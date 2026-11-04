'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { parseWorkbook } = require('../backend/services/parsePaintingSheet');
const { buildWorkbook } = require('../backend/services/exportInternal');
const { calculateQuoteCosts } = require('../backend/services/quoteCostSummary');

const processes = [
  ['夹模', 'clamp'], ['移印', 'pad'], ['炒货', 'roast'], ['散枪', 'spray'],
  ['边模', 'edge'], ['油色', 'color'], ['浸油', 'dip'], ['抹油', 'oil'],
  ['擦PP水', 'pp_water'], ['UV打印', 'uv'], ['热转印', 'heat_transfer'],
  ['滚印', 'roller'], ['烫印', 'hot_stamp'],
];

async function parseRows(rows) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('合成喷油工序');
  rows.forEach(row => sheet.addRow(row));
  return parseWorkbook(await book.xlsx.writeBuffer());
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('all thirteen real operation pairs stay before a whitespace-normalized total, never the duplicate fee columns', async () => {
  for (const total of ['总报价', '总\n报价', ' 总 报 价 ']) {
    const header = ['名称', '位置', ...processes.flatMap(([name]) => [name, `${name}单价`]), total,
      ...processes.flatMap(([name]) => [name, `${name}模具费`]), '钢板', '备注'];
    const values = ['合成零件', '正面', ...processes.flatMap((_, index) => [index + 1, (index + 1) / 100]), 999,
      ...processes.flatMap((_, index) => [1000 + index, 9000 + index]), 8800, '保留原备注'];
    const parsed = await parseRows([header, values]);
    assert.equal(parsed.error, undefined, total);
    assert.equal(parsed.count, 1);
    for (const [, key] of processes) {
      const index = processes.findIndex(([, candidate]) => candidate === key);
      assert.equal(parsed.items[0][`${key}_qty`], index + 1, `${total}/${key}`);
      assert.equal(parsed.items[0][`${key}_unit`], (index + 1) / 100, `${total}/${key}`);
    }
    assert.equal(parsed.items[0].note, '保留原备注');
  }
});

test('a quantity adjacent to the total cannot consume that total as its unit price', async () => {
  const parsed = await parseRows([
    ['名称', '位置', '移印', '移印单价', '夹模', '总报价', '夹模', '钢板', '备注'],
    ['相邻边界件', '正面', 2, 0.08, 1, 0.16, 600, 180, '缺独立夹模单价'],
  ]);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.items[0].pad_qty, 2);
  assert.equal(parsed.items[0].pad_unit, 0.08);
  assert.equal(parsed.items[0].clamp_qty, 0);
  assert.equal(parsed.items[0].clamp_unit, 0);
});

test('legacy BIFF without a total still imports; a repeated modern header gets a fresh fee boundary', async () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['名称', '位置', '夹模', '夹模单价', '移印', '移印单价', '备注'],
    ['旧格式件', '前面', 1, 0.09, 0, 0, '旧表备注'],
    ['名称', '位置', '移印', '移印单价', '总\n报价', '夹模', '钢板', '备注'],
    ['新分区件', '背面', 3, 0.08, 0.24, 600, 180, '新表备注'],
  ]);
  XLSX.utils.book_append_sheet(book, sheet, '合成旧表');
  const parsed = await parseWorkbook(XLSX.write(book, { type: 'buffer', bookType: 'biff8' }));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.count, 2);
  assert.deepEqual(parsed.items.map(row => [row.name, row.clamp_qty, row.clamp_unit, row.pad_qty, row.pad_unit, row.note]), [
    ['旧格式件', 1, 0.09, 0, 0, '旧表备注'],
    ['新分区件', 0, 0, 3, 0.08, '新表备注'],
  ]);
});

test('parsed operation costs reach actual quotation and round-trip XLSX totals without any tooling fees', async () => {
  const parsed = await parseRows([
    ['名称', '位置', '夹模', '夹模单价', '移印', '移印单价', '总报价', '夹模', '钢板', '备注'],
    ['合成头盖', '眼睛', 0, 0, 2, 0.08, 0.16, 600, 180, '头盖备注'],
    ['合成身体', '身体', 2, 0.03, 0, 0, 0.06, 800, 250, '身体备注'],
    ['仅一次性模具费', '工装', 0, 0, 0, 0, 0, 900, 500, '不应变成工序'],
  ]);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.count, 2);
  const args = {
    quote: { quote_no: 'UI1068-SYNTHETIC', product_name: '合成费用边界', qty: 100 },
    sections: [
      { dept: 'painting', payload_json: JSON.stringify({ painting_items: parsed.items, indo_pct: 0 }) },
      { dept: 'sales', payload_json: JSON.stringify({ header: { fx_rmb_hkd: 0.85, fx_hkd_usd: 7.8 } }) },
    ],
  };
  const costs = calculateQuoteCosts(args.quote, args.sections);
  near(costs.components.painting_labor + costs.components.paint_material, 0.22);
  const workbook = await buildWorkbook(args);
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
  const details = reopened.getWorksheet('喷油明细');
  const rowByName = name => {
    let found;
    details.eachRow(row => { if (row.getCell(2).value === name) found = row.number; });
    assert.ok(found, `missing ${name}`);
    return found;
  };
  const head = rowByName('合成头盖'), body = rowByName('合成身体');
  near(details.getCell(head, 6).value, 2);
  near(details.getCell(head, 7).value, 0.08);
  near(details.getCell(head, 30).result, 0.16);
  near(details.getCell(body, 4).value, 2);
  near(details.getCell(body, 5).value, 0.03);
  near(details.getCell(body, 30).result, 0.06);
  let total;
  details.eachRow(row => { if (row.getCell(1).value === '合计 HKD') total = row.number; });
  assert.ok(total);
  near(details.getCell(total, 30).result, 0.22);
  assert.ok(details.getCell(total, 30).formula, 'the exported total retains a live formula');
  const main = reopened.getWorksheet('报价明细');
  let mainRow;
  main.eachRow(row => { if (row.getCell(2).value === '印喷') mainRow = row.number; });
  assert.ok(mainRow);
  near(main.getCell(mainRow, 11).result, 0.22);
});
