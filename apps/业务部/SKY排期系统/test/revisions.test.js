const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Excel = require('exceljs');
const { writeToExcel } = require('../excel-writer');
const { writeFullWorkbook } = require('../full-workbook');

async function exportAndRead(template, orders) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sky-revision-'));
  try {
    const input = path.join(dir, 'input.xlsx'), output = path.join(dir, 'export.xlsx');
    await template.xlsx.writeFile(input);
    const { wb, type } = await writeToExcel(input, orders);
    await writeFullWorkbook(input, output, wb, type, orders);
    const result = new Excel.Workbook();
    await result.xlsx.readFile(output);
    return result;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test('修改数量后按原行的装箱数和贴纸用量更新合计，保留手工备注', async () => {
  const template = new Excel.Workbook();
  const order = template.addWorksheet('总接单');
  order.addRow(['合成表头']); order.addRow(['第二行']); order.addRow([null,null,null,'PO0000303','SR600',20]);
  const sched = template.addWorksheet('一二代排期');
  sched.addRow(['合成表头']); sched.addRow(['第二行']);
  const row = sched.addRow([null,null,null,null,null,null,'PO0000303','SR600',null,20,3,60,10,2]);
  row.getCell(45).value = '手工备注';
  const result = await exportAndRead(template, [{
    client: 'Sky Castle',
    poNumber: 'PO0000303',
    shippingDate: '2026-12-01',
    items: [{ partNo: 'SR600', quantity: 42, unitPrice: 2, amount: 84, dueDate: '2026-12-10' }],
  }]);
  const actual = result.getWorksheet('一二代排期').getRow(3);
  assert.deepEqual([10,11,12,13,14,45].map(col=>actual.getCell(col).value),[42,3,126,10,5,'手工备注']);
  const expectedDate = new Date('2026-12-10T00:00:00Z');
  assert.deepEqual(actual.getCell(15).value, expectedDate);
  assert.deepEqual(actual.getCell(16).value, expectedDate);
  assert.deepEqual(result.getWorksheet('总接单').getCell('B3').value, expectedDate);
});
test('TOMY 旧格式单价待定提示写入备注列，保留独立的美元金额列', async () => {
  const template = new Excel.Workbook();
  template.addWorksheet('总接单').addRow(['表头']);
  const sched = template.addWorksheet('总排期');
  const headers = sched.addRow(['接单期']); headers.getCell(22).value='备注'; headers.getCell(24).value='金额USD';
  const result = await exportAndRead(template,[{client:'TOMY',poNumber:'PO0000304',items:[{partNo:'TEST01',quantity:12,unitPrice:0,amount:0,priceTBA:true}]}]);
  const row = result.getWorksheet('总排期').getRow(2);
  assert.equal(row.getCell(24).value,0);
  assert.match(row.getCell(22).value,/TBA/);
});
