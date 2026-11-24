const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {buildOutputWorkbook}=require('../backend/services/nexusOutputTemplate');
const {serializeWorkbook}=require('../backend/services/workbookPreview');
test('carton source editor follows actual rows and correct carton instead of fixed row 35',async()=>{
 const wb=await buildOutputWorkbook({quote:{qty:100},sections:[{dept:'engineering',payload_json:JSON.stringify({carton_calc:{cartons:[{name:'主纸箱',cl:18,cw:12,ch:10,qty:12},{name:'内箱',cl:6,cw:5,ch:4,qty:3}]}})}]});
 const sheets=serializeWorkbook(wb,{editableCells:wb.outputEditState.editable});
 const source=fs.readFileSync(require.resolve('../frontend/quote-output.js'),'utf8').split("element('clear-stale-output').onclick")[0];
 const context=vm.createContext({URLSearchParams,location:{search:'?id=1',pathname:'/quote-output.html'},console});
 vm.runInContext(source+';globalThis.model=(data,cell)=>{state.data=data;state.activeSheet=data.sheets.findIndex(s=>s.name===\'报价明细\');return cartonCalculationModel(cell);};',context);
 const detail=sheets.find(s=>s.name==='报价明细');
 const targets=detail.cells.filter(c=>c.value==='箱价/件');
 assert.equal(targets.length,2);
 assert.ok(targets.every(c=>c.column===10));
 for(const [index,label] of targets.entries()){
  const target=detail.cells.find(c=>c.row===label.row&&c.column===label.column+1);
  const model=context.model({sheets},target);
  assert.ok(model);assert.equal(model.initial.length,index===0?18:6);
  assert.equal(model.initial.quantity,index===0?12:3);
  assert.equal(model.targetAddress,target.address);
  assert.ok(model.fields.every(f=>f.cell.editable));
  assert.equal(model.fields.find(f=>f.label==='纸箱长 L').cell.column,11);
  assert.equal(model.fields.find(f=>f.label==='装箱数量').cell.column,14);
 }
});
