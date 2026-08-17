'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { parseWorkbook } = require('../backend/services/parseBlowSheet');
const { buildWorkbook } = require('../backend/services/exportInternal');

function makeLegacyBlowWorkbook() {
  const rows = [
    [null, ' 吹 气 报 价'],
    [],
    ['客户', 'TOMY'],
    ['货名：', '盘子'],
    ['产能：', '22/小时3500'],
    ['用料：', 'HDPE 5502'],
    ['预估料重：', '42g'],
    ['料价：', '6P'],
    ['产品料价：', 0.55],
    ['吹工：', 0.428],
    ['披锋：', 0.08],
    ['小计：', 1.058],
    ['利润：*', 1.05],
    ['合计：', 1.1109],
    [null, '一出一'],
    ['模价：', null],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xls' });
}

test('blow import parses the legacy vertical XLS costing card', async () => {
  const result = await parseWorkbook(makeLegacyBlowWorkbook());

  assert.equal(result.error, undefined);
  assert.equal(result.count, 1);
  assert.deepEqual(result.sheets_used, ['1']);
  assert.equal(result.items[0].name, '盘子');
  assert.equal(result.items[0].capacity, 3500);
  assert.equal(result.items[0].material, 'HDPE 5502');
  assert.equal(result.items[0].weight_g, 42);
  assert.equal(result.items[0].material_price_lb, 6);
  assert.equal(result.items[0].blow_labor, 0.428);
  assert.equal(result.items[0].flash, 0.08);
  assert.equal(result.items[0].profit_x, 1.05);
  assert.equal(result.items[0].usage_qty, 1);
  assert.equal(result.items[0].cavity_note, '一出一');
  assert.equal(result.items[0].material_cost_hkd, 0.55);
  assert.equal(result.items[0].source_subtotal_hkd, 1.058);
  assert.equal(result.items[0].source_total_hkd, 1.1109);
});

test('imported product material price is preserved in totals and Excel export', async () => {
  const parsed = await parseWorkbook(makeLegacyBlowWorkbook());
  const workbook = await buildWorkbook({
    quote: { quote_no: 'BLOW-IMPORT', product_name: '盘子', qty: 1000 },
    sections: [{ dept: 'molding', payload_json: JSON.stringify({ blow_items: parsed.items }) }],
  });
  const worksheet = workbook.getWorksheet('报价明细');
  let sectionRow = 0;
  worksheet.eachRow(row => {
    if (row.getCell(1).value === '二·B、吹气部分 (HKD)') sectionRow = row.number;
  });
  const dataRow = sectionRow + 2;

  assert.equal(worksheet.getCell(dataRow, 6).value, 0.55);
  assert.equal(worksheet.getCell(dataRow, 9).value.result, 1.058);
  assert.equal(Number(worksheet.getCell(dataRow, 12).value.result.toFixed(4)), 1.1109);
});

test('blow import rejects unrelated workbooks', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['普通表'], ['无吹气字段']]), 'Sheet1');
  const result = await parseWorkbook(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  assert.match(result.error, /未找到吹气报价格式/);
});

test('blow upload route and workbench import are wired', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'uploads.js'), 'utf8');
  const workbenchSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'workbench.js'), 'utf8');

  assert.match(routeSource, /router\.post\('\/blow-sheet'/);
  assert.match(routeSource, /\['molding', 'sales', 'engineering'\]/);
  assert.match(routeSource, /parseBlowWorkbook/);
  assert.match(workbenchSource, /id="blow-import"/);
  assert.match(workbenchSource, /fetch\('\/api\/uploads\/blow-sheet'/);
  assert.match(workbenchSource, /payload\.blow_items = rows\.map/);
});
