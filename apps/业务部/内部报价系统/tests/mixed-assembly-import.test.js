const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const {parseWorkbook} = require('../backend/services/parseAssemblySheet');
const {planAssembly} = require('../frontend/mixed-sku');
test('mixed assembly uses explicit SKU, keeps packaging shared and applies the unified target', async () => {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('装工-系统');
  ws.addRow(['序号','小产品编号','半成品配件包工序名称','使用工具','人数','工位用时','注意事项',null,'序号','成品包装工序名称','使用工具','人数',null,'注意事项']);
  ws.addRow([1,'SKU-060','59#喷嘴',null,4,null,'检查',null,1,'装箱',null,2]);
  ws.addRow([2,'SKU-060','封口',null,1,null,null,null,null,null,'目标数',12000]);
  ws.addRow([null,null,null,null,null,null,null,null,null,null,'时间','11H']);
  const r = await parseWorkbook(await wb.xlsx.writeBuffer(),{mixed:true});
  assert.equal(r.count,3); assert.equal(r.groups[0].source_product_code,'SKU-060');
  assert.equal(r.groups[0].qty,12000); assert.equal(r.groups[0].steps[0].note,'检查');
  assert.equal(r.groups[1].shared,true); assert.equal(r.groups[1].qty,12000);
  assert.equal(r.groups[1].work_hours,11);
  assert.equal(r.groups[0].work_hours,11);
  ws.getCell('L3').value = null;
  const missing = await parseWorkbook(await wb.xlsx.writeBuffer(),{mixed:true});
  assert.ok(missing.groups.every(g => g.qty === null));
  const plan=planAssembly({products:[{id:'60',code:'SKU-060'}]},r.groups);
  assert.deepEqual(plan.unmatched,[]); assert.deepEqual(plan.groups.map(g=>g.product.id),['60','__shared__']);
});
test('unknown or duplicate SKU is blocked without guessing from process numbers',()=>{
  const row={source_product_code:'SKU-060',steps:[{name:'59#喷嘴',count:4}]};
  assert.equal(planAssembly({products:[{id:'59',code:'SKU-059'}]},[row]).unmatched.length,1);
  assert.equal(planAssembly({products:[{id:'a',code:'SKU-060'},{id:'b',code:'SKU-060'}]},[row]).unmatched.length,1);
});
