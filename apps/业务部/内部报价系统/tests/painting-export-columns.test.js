'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkbook } = require('../backend/services/exportInternal');
const { calculateQuoteCosts } = require('../backend/services/quoteCostSummary');

function quoteArgs(painting) {
  return {
    quote: { quote_no: 'PAINT-COLUMN-REGRESSION', product_name: '喷油导出校核', qty: 100 },
    sections: [
      { dept: 'painting', payload_json: JSON.stringify(painting) },
      { dept: 'sales', payload_json: JSON.stringify({ header: { fx_rmb_hkd: 0.85, fx_hkd_usd: 7.8 }, shipping: { markup_x: 1.2 } }) },
    ],
  };
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

function findRow(sheet, column, label) {
  let result;
  sheet.eachRow(row => { if (row.getCell(column).value === label) result = row.number; });
  assert.ok(result, `missing ${label}`);
  return result;
}

test('滚印烫印单价不被印尼运费覆盖，喷油明细和主表引用实际报价列', async () => {
  const args = quoteArgs({ indo_pct: 10, painting_items: [
    { name: '滚印烫印', roller_qty: 3, roller_unit: 0.06, hot_stamp_qty: 1, hot_stamp_unit: 0.15 },
  ] });
  const workbook = await buildWorkbook(args);
  const detail = workbook.getWorksheet('喷油明细');
  assert.equal(detail.getCell('Z2').value, '滚印');
  assert.equal(detail.getCell('AB2').value, '烫印');
  assert.equal(detail.getCell('AD2').value, '报价');
  assert.equal(detail.getCell('AE2').value, '印尼运费 10%');
  assert.equal(detail.getCell('AA4').value, 0.06);
  assert.equal(detail.getCell('AC4').value, 0.15);
  assert.equal(detail.getCell('AE3').value, null, '第二层表头不能参与金额计算');
  assert.equal(detail.getCell('A5').value, '合计 HKD', '合计标签不能变成自引用公式');
  assert.match(detail.getCell('AD4').formula, /Z4\*AA4\+AB4\*AC4$/);
  near(detail.getCell('AD4').result, 0.33);
  near(detail.getCell('AD5').result, 0.33);
  assert.equal(detail.getCell('AE5').formula, 'AD5*30%*10/100');
  near(detail.getCell('AE5').result, 0.0099);
  const main = workbook.getWorksheet('报价明细');
  const summaryRow = findRow(main, 2, '印喷');
  assert.equal(main.getCell(summaryRow, 10).formula, "'喷油明细'!AD5");
  near(main.getCell(summaryRow, 11).result, 0.33);
  const costs = calculateQuoteCosts(args.quote, args.sections);
  near(costs.components.painting_labor, 0.231);
  near(costs.components.paint_material, 0.099);
  near(costs.components.misc, 0.0099);
  near(costs.quotedPrice, 0.4079);
});

test('多产品喷油保留滚印烫印输入及配比，主表使用加权报价而非工序数量', async () => {
  const args = quoteArgs({ indo_pct: 5, product_mix_ratios: { p1: 2, p2: 1 }, painting_items: [
    { name: '1#产品', product_group_id: 'p1', product_group_name: '1#产品', roller_qty: 3, roller_unit: 0.06, hot_stamp_qty: 1, hot_stamp_unit: 0.15 },
    { name: '2#产品', product_group_id: 'p2', product_group_name: '2#产品', roller_qty: 2, roller_unit: 0.20, hot_stamp_qty: 2, hot_stamp_unit: 0.10 },
  ] });
  const workbook = await buildWorkbook(args);
  const detail = workbook.getWorksheet('喷油明细');
  assert.equal(detail.getCell('AA4').value, 0.06);
  assert.equal(detail.getCell('AA5').value, 0.20);
  assert.equal(detail.getCell('AC4').value, 0.15);
  assert.equal(detail.getCell('AC5').value, 0.10);
  const first = findRow(detail, 1, '1#产品 小计 · 配比');
  const second = findRow(detail, 1, '2#产品 小计 · 配比');
  const total = findRow(detail, 1, '合计 HKD');
  assert.equal(detail.getCell(first, 29).value, 2);
  assert.equal(detail.getCell(second, 29).value, 1);
  near(detail.getCell(first, 30).result, 0.33);
  near(detail.getCell(second, 30).result, 0.60);
  near(detail.getCell(total, 30).result, 0.42);
  assert.match(detail.getCell(total, 30).formula, /SUMPRODUCT\(AC\d+:AC\d+,AD\d+:AD\d+\)\/SUM\(AC\d+:AC\d+\)/);
  assert.equal(detail.getCell(total, 31).formula, `AD${total}*30%*5/100`);
  near(detail.getCell(total, 31).result, 0.0063);
  const main = workbook.getWorksheet('报价明细');
  const summaryRow = findRow(main, 2, '印喷');
  assert.equal(main.getCell(summaryRow, 10).formula, `'喷油明细'!AD${total}`);
  near(main.getCell(summaryRow, 11).result, 0.42);
  const costs = calculateQuoteCosts(args.quote, args.sections);
  near(costs.components.painting_labor + costs.components.paint_material, 0.42);
  near(costs.components.misc, 0.0063);
});

test('旧十一工序输入继续按原单价计入导出，新增空工序不覆盖金额', async () => {
  const workbook = await buildWorkbook(quoteArgs({ indo_pct: 6, painting_items: [
    { name: '旧UV转印件', uv_qty: 2, uv_unit: 1.25, heat_transfer_qty: 3, heat_transfer_unit: 0.5 },
  ] }));
  const detail = workbook.getWorksheet('喷油明细');
  assert.equal(detail.getCell('W4').value, 1.25);
  assert.equal(detail.getCell('Y4').value, 0.5);
  assert.equal(detail.getCell('Z4').value, null);
  assert.equal(detail.getCell('AA4').value, null);
  assert.equal(detail.getCell('AB4').value, null);
  assert.equal(detail.getCell('AC4').value, null);
  near(detail.getCell('AD5').result, 4);
  near(detail.getCell('AE5').result, 0.072);
});
