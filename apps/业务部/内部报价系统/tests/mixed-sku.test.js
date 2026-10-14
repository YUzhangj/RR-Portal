const test=require('node:test'),assert=require('node:assert/strict'),ExcelJS=require('exceljs');
const {parseWorkbook}=require('../backend/services/parseMixedSku');
const {apply,productSerial}=require('../frontend/mixed-sku');
const {importParts}=require('../backend/services/mixedPartImport');
test('SKU资料按序号更新，保留产品标识、比例和模具关联',async()=>{
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('SKU LIST');ws.addRow(['NO.','Mini_item no','Brand','Discription']);
 ws.addRow([3,'BEAUTYM-S3-003','Brand','产品三']);ws.addRow([60,'BEAUTYM-S3-048-excl','Brand','独家款']);
 const {records}=await parseWorkbook(await wb.xlsx.writeBuffer());
 const config={enabled:true,mode:'equal',units_per_pack:1,products:[{id:'number_03',code:'03',name:'小产品03',ratio:2},{id:'number_60',code:'60',name:'小产品60',ratio:1}]};
 const updated=apply(config,records);assert.equal(updated.matched,2);assert.equal(updated.added,0);assert.equal(updated.config.products[0].id,'number_03');assert.equal(updated.config.products[0].ratio,2);assert.equal(productSerial(updated.config.products[1]),'60');
 const mold=[{mold_no:'M1',parts:[{name:'03、60-共用盖',material:'ABS'}]}];
 for(const mode of ['append','replace']){
  const result=importParts(updated.config,{},mold,{mode});
  assert.equal(result.config.products.length,2);assert.equal(result.config.products[1].code,'BEAUTYM-S3-048-excl');assert.equal(result.engineering.mixed_part_selections.number_03.length,1);assert.equal(result.engineering.mixed_part_selections.number_60.length,1);
 }
 assert.throws(()=>apply(config,[...records,records[0]]),/重复/);
 const ambiguous={...config,products:[...config.products,{id:'other',code:'BEAUTYM-S3-003',name:'另一个',ratio:1}]};assert.throws(()=>apply(ambiguous,records),/多个/);
 assert.equal(config.products[0].code,'03');
});
