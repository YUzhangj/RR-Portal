const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOutputWorkbook } = require('../backend/services/nexusOutputTemplate');
const { boundOverride } = require('../backend/services/outputWorkbookOverrides');
const { adoptMaterialMoq } = require('../backend/services/materialMoqPolicy');
function fixture() {
 return {quote:{quote_no:'HISTORY-1148',qty:3000},sections:Object.entries({sales:{},engineering:{hardware:[{name:'螺丝',qty:1,unit_price:2,moq_qty:5000}],indo_pct:8},molding:{indo_pct:3,material_prices:[{name:'ABS',model:'750SW',price:6.5}],injection:[{name:'保留手填',material:'ABS',material_grade:'750SW',weight_g:10,material_unit_price:0.02,shot_price:0.4,sets:1}]},electronic:{electronics:[{name:'IC',qty:1,unit_price:5},{name:'PCB',qty:1,unit_price:2}],indo_pct:4}}).map(([dept,p])=>({dept,payload_json:JSON.stringify(p)}))};
}
function detail(wb) {
 const ws=wb.getWorksheet('报价明细'),result={};
 ws.eachRow(r=>{
   if(r.getCell(1).value==='直接成本合计')result.total=r.getCell(4).result;
   if(String(r.getCell(2).value).startsWith('报价（MOQ')){result.label=r.getCell(2).value;result.price=r.getCell(4).result;}
   if(r.getCell(3).value==='保留手填')result.material=r.getCell(7).value;
 }); return result;
}
test('old #1145 saved correction retains exact historical manual price, MOQ and totals without mutation',async()=>{
 const args=fixture(),before=JSON.stringify(args);
 // Captured from #1145 / 60de6756 against this exact synthetic source.
 const legacy={value:12,source_department:'molding',source_signature:'c6e26ed994f75b2d46511f984e73fd919fd0c343f1b58a55c616a63d0796ff43'};
 const overrides=[{sheet_name:'报价明细',cell_address:'C2',value_json:JSON.stringify(legacy)}];
 const wb=await buildOutputWorkbook({...args,overrides});
 assert.deepEqual(wb.outputEditState.conflicts,[]);
 assert.deepEqual(detail(wb),{total:9.930325209647496,label:'报价（MOQ3K）',price:12.15958188936428,material:0.02});
 assert.equal(JSON.stringify(args),before);
 const changed=structuredClone(args);const mold=JSON.parse(changed.sections[2].payload_json);mold.material_prices[0].name='PP';changed.sections[2].payload_json=JSON.stringify(mold);
 assert.equal((await buildOutputWorkbook({...changed,overrides})).outputEditState.conflicts.length,1,'changed source must not accept old correction');
});
test('only an explicitly saved reference price replaces a matching manual price, and reset restores it',async()=>{
 const args=fixture(),base=await buildOutputWorkbook(args);
 const overrides=[{sheet_name:'报价明细',cell_address:'C2',value_json:JSON.stringify(boundOverride(base,'报价明细','C2',12,'molding'))}];
 const after=await buildOutputWorkbook({...args,overrides});
 assert.deepEqual(after.outputEditState.conflicts,[]);
 assert.equal(detail(after).material.result,Number((12/454).toFixed(4)));
 assert.ok(detail(after).total>detail(base).total);
 assert.equal(detail(await buildOutputWorkbook(args)).material,0.02);
});
test('MOQ adoption requires actual saved material changes; a read or unrelated save preserves history',async()=>{
 const args=fixture(),previous=JSON.parse(args.sections[1].payload_json);
 const unrelated=adoptMaterialMoq(previous,{...structuredClone(previous),notes:'备注',output_moq_from_materials:true});
 assert.equal(unrelated.output_moq_from_materials,undefined);
 const changed=structuredClone(previous);changed.hardware[0].qty=2;
 args.sections[1].payload_json=JSON.stringify(adoptMaterialMoq(previous,changed));
 assert.equal(detail(await buildOutputWorkbook(args)).label,'报价（MOQ5K）');
 assert.throws(()=>adoptMaterialMoq({output_unified_indonesia:true,indo_pct:8},{indo_pct:9}),/统一印尼/);
});
