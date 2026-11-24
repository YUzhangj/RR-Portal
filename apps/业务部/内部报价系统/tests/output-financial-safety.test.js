const test=require('node:test');
const assert=require('node:assert/strict');
const {buildOutputWorkbook}=require('../backend/services/nexusOutputTemplate');
const row=(name,weight)=>({name,mold_no:name,material:'ABS',material_grade:'750SW',weight_g:weight,material_unit_price:0.02,machine_model:'20A',sets:1,target:2600,shot_price:0.4});
const args=(rows,scenarios)=>({quote:{quote_no:'PR1144-ONLY',product_name:'Synthetic',qty:1000},sections:[
 {dept:'molding',payload_json:JSON.stringify({injection:rows,material_prices:[{name:'ABS',model:'750SW',price:6.5}]})},
 {dept:'sales',payload_json:JSON.stringify({shipping:{scenarios}})},
]});
test('output material unit price always links to the matching upper reference',async()=>{
 const wb=await buildOutputWorkbook(args([row('partA',10)]));
 const c=wb.getWorksheet('报价明细').getCell('G11');
 assert.equal(c.formula,'C4');
 assert.equal(c.result,Number((6.5/454).toFixed(4)));
});
test('output preserves saved manual material unit price when no upper reference matches',async()=>{
 const unmatched=row('partA',10);
 unmatched.material_grade='CUSTOM';
 const wb=await buildOutputWorkbook(args([unmatched]));
 const c=wb.getWorksheet('报价明细').getCell('G11');
 assert.equal(c.formula,undefined);
 assert.equal(c.value,0.02);
});
test('saved output corrections must not move to a different part after inserting a row',async()=>{
 const old=args([row('partA',10)]);
 const original=await buildOutputWorkbook(old);
 old.overrides=[{sheet_name:'报价明细',cell_address:'E11',value_json:JSON.stringify(require('../backend/services/outputWorkbookOverrides').boundOverride(original,'报价明细','E11',20,'molding'))}];
 const wb=await buildOutputWorkbook({...old,sections:args([row('partB',30),row('partA',10)]).sections});
 assert.equal(wb.getWorksheet('报价明细').getCell('C11').value,'partB');
 assert.equal(wb.getWorksheet('报价明细').getCell('E11').value,30);
 assert.equal(wb.outputEditState.conflicts.length,1);
});
test('an explicitly saved factory-only shipping plan remains factory-only',async()=>{
 const wb=await buildOutputWorkbook(args([row('partA',10)],[{name:'出厂价',is_factory:true}]));
 const ws=wb.getWorksheet('报价明细');let found;
 ws.eachRow(r=>{if(r.getCell(2).value==='运输方案')found=r;});
 assert.ok(found);
 assert.equal(found.getCell(4).value,'出厂价');
 assert.equal(found.getCell(5).value,null);
});

test('legacy detail sheets cannot create an independent conflicting output price',async()=>{
 const wb=await buildOutputWorkbook(args([row('partA',10)]));
 assert.ok([...wb.outputEditState.editable].every(k=>k.startsWith('报价明细!')));
});
test('invalid output divisor cannot silently retain a cached price',async()=>{
 const a=args([row('partA',10)]); const wb=await buildOutputWorkbook(a);
 const bound=require('../backend/services/outputWorkbookOverrides').boundOverride;
 await assert.rejects(()=>buildOutputWorkbook({...a,overrides:[{sheet_name:'报价明细',cell_address:'C3',value_json:JSON.stringify(bound(wb,'报价明细','C3',0,'molding'))}]}),/无法计算/);
});
test('freight corrections flow through scenario price and tax summaries',async()=>{
 const a=args([row('partA',10)],[{name:'出厂价',is_factory:true},{name:'盐田40柜'}]);
 a.sections.push({dept:'engineering',payload_json:JSON.stringify({carton_calc:{cartons:[{cl:18,cw:12,ch:10,qty:12}]}})});
 const base=await buildOutputWorkbook(a); const ws=base.getWorksheet('报价明细');let feeRow,summaryRow,taxRow,shippingRow;
 ws.eachRow(r=>{if(r.getCell(2).value==='YT 40柜运费+吊柜费')feeRow=r.number;if(r.getCell(1).value==='二、包装 / 外购')summaryRow=r.number+2;if(r.getCell(1).value==='四、减税明细')taxRow=r.number+2;if(r.getCell(2).value==='运费')shippingRow=r.number;});
 assert.ok(feeRow && shippingRow);
 const address='C'+feeRow, bound=require('../backend/services/outputWorkbookOverrides').boundOverride;
 const changed=await buildOutputWorkbook({...a,overrides:[{sheet_name:'报价明细',cell_address:address,value_json:JSON.stringify(bound(base,'报价明细',address,14400,'sales'))}]}), next=changed.getWorksheet('报价明细');
 assert.ok(next.getCell('E'+shippingRow).result > ws.getCell('E'+shippingRow).result);
 const linked=[]; next.eachRow(r=>r.eachCell(c=>{if(c.formula?.includes('*48%'))linked.push(c);}));
 assert.ok(linked.length>=2); assert.ok(linked.every(c=>c.result>0));
});
