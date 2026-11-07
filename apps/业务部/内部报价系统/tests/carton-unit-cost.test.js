'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildWorkbook } = require('../backend/services/exportXlsx');
const { calculateQuoteCosts } = require('../backend/services/quoteCostSummary');

const carton = {
  name: '主纸箱',
  cl: 8.5,
  cw: 6.75,
  ch: 13,
  qty: 6,
  flat_cards: [{ name: '主平卡', l: 8.5, w: 6.75, qty: 1 }],
};
const paperRate = 3;
const boxPrice = (carton.cl + carton.cw + 2) * (carton.cw + carton.ch + 1) * 2 * paperRate / 1000;
const flatCardPrice = (8.5 + 1) * (6.75 + 1) * 2 / 1000;
const expectedPerPiece = (boxPrice + flatCardPrice) / carton.qty;

function sections() {
  return [
    {
      dept: 'sales',
      payload_json: JSON.stringify({ header: { fx_rmb_hkd: 0.85, fx_hkd_usd: 7.8 }, shipping: { scenarios: [] } }),
    },
    {
      dept: 'engineering',
      payload_json: JSON.stringify({ carton_calc: { paper_rate: paperRate, cartons: [carton] } }),
    },
  ];
}

test('纸箱单件成本按（箱价 + 平卡）/ 数量计算', () => {
  const result = calculateQuoteCosts(
    { quote_no: 'CARTON-PER-PCS', customer: 'ToyMonster', qty: 1000 },
    sections(),
  );

  assert.ok(Math.abs(result.components.carton - expectedPerPiece) < 1e-12);
  assert.notEqual(result.components.carton, boxPrice / carton.qty + flatCardPrice);
});

test('报价明细 Excel 的纸箱汇总公式先加箱价和平卡再除数量', async () => {
  const workbook = await buildWorkbook({
    quote: { quote_no: 'CARTON-EXPORT', product_name: '纸箱公式', customer: 'ToyMonster', qty: 1000 },
    sections: sections(),
  });
  const worksheet = workbook.getWorksheet('报价明细');
  let boxRow = 0;
  let flatRow = 0;
  worksheet.eachRow(row => {
    if (row.getCell(1).value === '主纸箱') boxRow = row.number;
    if (row.getCell(1).value === '主平卡') flatRow = row.number;
  });
  assert.ok(boxRow > 0 && flatRow > boxRow);

  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'services', 'exportXlsx.js'), 'utf8');
  assert.match(source, /return `\(\$\{cr\.boxCell\}\$\{flatSum\}\)\/MAX\(\$\{cr\.qtyCell\},1\)`/);
  assert.match(source, /return s \+ \(boxPrice \+ flatSum\) \/ q/);

  const workbenchSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'workbench.js'), 'utf8');
  assert.match(workbenchSource, /return s \+ \(boxPrice \+ flatSum\) \/ q/);
});
