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

function mixedSheet() {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('混装装工');
  ws.addRow(['序号','小产品编号','半成品工序名称','工具','人数','用时','备注',null,'序号','成品包装工序名称','工具','人数',null,'备注']);
  ws.addRow([1,'SKU-A','组装A',null,2]);
  return { wb, ws };
}
test('an empty packaging lane still supplies the unique sheet target and hours', async()=>{
  const {wb,ws}=mixedSheet();
  ws.addRow([null,null,null,null,null,null,null,null,null,null,'目标数',12000]);
  ws.addRow([null,null,null,null,null,null,null,null,null,null,'时间','11H']);
  const parsed=await parseWorkbook(await wb.xlsx.writeBuffer(),{mixed:true});
  assert.equal(parsed.groups.length,1);
  assert.equal(parsed.groups[0].qty,12000);
  assert.equal(parsed.groups[0].work_hours,11);
});
test('unique target metadata before the header is preserved in mixed import',async()=>{
  const {wb,ws}=mixedSheet();
  ws.insertRow(1,[null,null,null,null,null,null,null,null,null,null,'目标数量',9000]);
  ws.insertRow(1,[null,null,null,null,null,null,null,null,null,null,'时间：','10H']);
  const parsed=await parseWorkbook(await wb.xlsx.writeBuffer(),{mixed:true});
  assert.equal(parsed.groups[0].qty,9000);
  assert.equal(parsed.groups[0].work_hours,10);
});
test('conflicting labor metadata is rejected instead of taking the last value', async()=>{
  for(const [label,a,b] of [['目标数',12000,6000],['时间','11H','8H']]) {
    const {wb,ws}=mixedSheet();
    ws.addRow([null,null,null,null,null,null,null,null,null,null,label,a]);
    ws.addRow([null,null,null,null,null,null,null,null,null,null,label,b]);
    const parsed=await parseWorkbook(await wb.xlsx.writeBuffer(),{mixed:true});
    assert.match(parsed.error,/冲突/);
    assert.equal(parsed.groups,undefined);
  }
});
test('distinct lane targets stay local and ambiguous missing targets are not guessed',async()=>{
  const {wb,ws}=mixedSheet();
  // A third empty lane supplies a different target, so no unique global value exists.
  ws.getRow(1).values=[...ws.getRow(1).values.slice(1),null,'另一组工序名称','工具','人数'];
  ws.addRow([null,null,null,null,null,null,null,null,null,null,'目标数',12000,null,null,null,null,'目标数',6000]);
  const parsed=await parseWorkbook(await wb.xlsx.writeBuffer(),{mixed:true});
  assert.equal(parsed.groups[0].qty,null);
  assert.equal(parsed.groups[0].work_hours,undefined);
});
test('mixed labor metadata rejects supplied nonpositive or nonfinite values',async()=>{
  for(const value of [0,-1,{formula:'1/0',result:Infinity}]) {
    const {wb,ws}=mixedSheet();
    ws.addRow([null,null,null,null,null,null,null,null,null,null,'时间',value]);
    const parsed=await parseWorkbook(await wb.xlsx.writeBuffer(),{mixed:true});
    assert.match(parsed.error,/时间无效/);
  }
});
test('normalized aliases for one product cannot silently overwrite work hours',()=>{
  const plan=planAssembly({products:[{id:'a',code:'SKU-A'}]},[
    {source_product_code:'ＳＫＵ－Ａ',work_hours:11,steps:[{name:'A',count:1}]},
    {source_product_code:'sku-a',work_hours:8,steps:[{name:'B',count:1}]},
  ]);
  assert.match(plan.unmatched[0],/工时冲突/);
});
test('multiple SKU columns are rejected before labor can be assigned from the wrong lane',async()=>{
  const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('two SKU columns');
  ws.addRow(['小产品编号','半成品工序名称','工具','人数','小产品编号','半成品工序名称','工具','人数']);
  ws.addRow(['SKU-A',null,null,null,'SKU-B','B labor',null,4]);
  const result=await parseWorkbook(await wb.xlsx.writeBuffer(),{mixed:true});
  assert.match(result.error,/多个.*小产品编号.*单列/);
  assert.equal(result.groups,undefined);
});
