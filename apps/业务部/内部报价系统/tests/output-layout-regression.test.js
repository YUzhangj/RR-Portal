'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildOutputWorkbook } = require('../backend/services/nexusOutputTemplate');
const { buildWorkbook } = require('../backend/services/exportInternal');
const { boundOverride } = require('../backend/services/outputWorkbookOverrides');
const { inferOutputSourceDepartment } = require('../backend/services/outputSourceDepartment');
const fixture = () => ({ quote: { quote_no: 'PR1145-SYNTHETIC', qty: 1000 }, sections: [
  { dept: 'engineering', payload_json: JSON.stringify({ hardware: [{ name: 'screw', qty: 2, unit_price_rmb: 0.85 }], carton_calc: { paper_rate: 2.75, cartons: [{ name: '主纸箱', cl: 18, cw: 12, ch: 10, qty: 12 }] } }) },
  { dept: 'sales', payload_json: JSON.stringify({ header: { fx_rmb_hkd: 0.85 }, freight_calc: { hk40: 0, hk20: 0, yt40: 0, yt20: 0, hk10t: 0, yt10t: 0, hk5t: 0, yt5t: 0 }, shipping: { markup_x: 0, scenarios: [{ name: '出厂价', is_factory: true }] } }) },
] });
function find(ws, text, offset = 0) {
  let found;
  ws.eachRow(r => r.eachCell(c => { if (c.value === text) found = ws.getCell(c.row + offset, c.col); }));
  assert.ok(found, text); return found;
}
function value(cell) { return cell.result ?? cell.value; }
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }
function override(wb, address, v, dept) { return { sheet_name: '报价明细', cell_address: address, value_json: JSON.stringify(boundOverride(wb, '报价明细', address, v, dept)) }; }

test('detail is first after XLSX serialization without reordering other department tabs', async () => {
  const a = fixture(), original = await buildWorkbook(a), wb = await buildOutputWorkbook(a);
  const expected = original.worksheets.map(s => s.name === '报价明细' ? '系统报价汇总' : s.name);
  const read = new ExcelJS.Workbook(); await read.xlsx.load(await wb.xlsx.writeBuffer());
  assert.equal(read.worksheets[0].name, '报价明细');
  assert.deepEqual(read.worksheets.slice(1).map(s => s.name), expected);
  assert.equal(read.views[0].activeTab, 0);
});

test('moved carton inputs recalculate tax base, deduction and final cost together', async () => {
  const a = fixture(), base = await buildOutputWorkbook(a), ws = base.getWorksheet('报价明细');
  const size = find(ws, '纸箱尺寸inch:'); assert.equal(size.col, 10);
  const lengthAddress = `K${size.row}`, quantityAddress = `N${size.row + 1}`;
  for (const address of [lengthAddress, quantityAddress]) {
    assert.ok(base.outputEditState.editable.has(`报价明细!${address}`));
    assert.equal(inferOutputSourceDepartment(base, '报价明细', address), 'engineering');
  }
  const wb = await buildOutputWorkbook({ ...a, overrides: [override(base, lengthAddress, 20, 'engineering'), override(base, quantityAddress, 10, 'engineering')] });
  const out = wb.getWorksheet('报价明细'), tax = find(out, '四、减税明细'), cost = find(out, '减税后结果');
  const carton = (20 + 12 + 2) * (12 + 10 + 1) * 2 * 2.75 / 1000 / 10;
  const deduction = carton / 1.1 * 0.115 + 2 * 0.115;
  near(value(out.getCell(tax.row + 1, 5)), carton);
  near(value(out.getCell(tax.row + 3, 5)), carton / 1.1 * 0.115);
  near(value(out.getCell(tax.row + 3, 13)), deduction);
  near(value(out.getCell(cost.row + 1, 5)), 2 + carton - deduction);
  assert.equal(wb.outputEditState.conflicts.length, 0);
  const reopened = new ExcelJS.Workbook(); await reopened.xlsx.load(await wb.xlsx.writeBuffer());
  near(value(reopened.getWorksheet('报价明细').getCell(tax.row + 3, 13)), deduction);
});

test('tax rate adjustment uses its displayed base and only counts each category once', async () => {
  const a = fixture(), base = await buildOutputWorkbook(a), ws = base.getWorksheet('报价明细');
  const row = find(ws, '四、减税明细').row, rate = `E${row + 2}`;
  assert.equal(inferOutputSourceDepartment(base, '报价明细', rate), 'sales');
  const wb = await buildOutputWorkbook({ ...a, overrides: [override(base, rate, 0.2, 'sales')] }), out = wb.getWorksheet('报价明细');
  const carton = (18 + 12 + 2) * (12 + 10 + 1) * 2 * 2.75 / 1000 / 12;
  near(value(out.getCell(row + 3, 13)), carton / 1.1 * 0.2 + 2 * 0.115);
  assert.equal(out.getCell(row + 3, 4).value, '—');
});


test('carton size and quantity flow through freight, yellow summary and three-row tax analysis', async () => {
  const a = fixture();
  const sales = JSON.parse(a.sections[1].payload_json);
  sales.freight_calc.yt40 = 7200;
  sales.shipping.scenarios.push({name:'盐田40柜'});
  a.sections[1].payload_json = JSON.stringify(sales);
  const base = await buildOutputWorkbook(a), original = base.getWorksheet('报价明细');
  const size = find(original, '纸箱尺寸inch:');
  const wb = await buildOutputWorkbook({...a,overrides:[override(base, `K${size.row}`,20,'engineering'),override(base,`N${size.row+1}`,10,'engineering')]}), ws=wb.getWorksheet('报价明细');
  const summary = find(ws,'二、包装 / 外购').row+1, tax=find(ws,'四、减税明细').row;
  const freight = 7200/Math.round(1980/(20*12*10/1728))/10*0.48;
  near(value(ws.getCell(summary,13)),freight);
  near(value(ws.getCell(tax+1,11)),freight);
  near(value(ws.getCell(tax+3,11)),freight*0.0826);
});
