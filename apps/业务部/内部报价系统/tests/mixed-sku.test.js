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

test('Ratio per capsule imports full precision into direct NA pricing without dividing by product count',async()=>{
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('SKU');
 ws.addRow(['NO.','Mini_item no','Brand','Discription','Ratio per mini','Ratio per capsule']);
 ws.addRow([1,'SKU-001','B','一',.023148148148,{formula:'E2*6',result: .138888888888}]);
 ws.addRow([2,'SKU-002','B','二',.01,'6.94%']);
 const config={enabled:true,mode:'equal',units_per_pack:6,products:[{id:'number_01',code:'01',name:'一',ratio:1},{id:'number_02',code:'02',name:'二',ratio:1}]};
 const {records}=await parseWorkbook(await wb.xlsx.writeBuffer());
 const updated=apply(config,records).config;
 const {pricingWeights}=require('../frontend/mixed-molds');
 assert.equal(updated.na_direct,true);
 assert.equal(updated.products[0].na_ratio,.138888888888);
 assert.equal(updated.products[1].na_ratio,.0694);
 assert.deepEqual(pricingWeights(updated),{number_01:.138888888888,number_02:.0694});
 assert.equal(config.na_direct,undefined);
 ws.getCell('F3').value=0;
 assert.equal((await parseWorkbook(await wb.xlsx.writeBuffer())).records[1].na_ratio,0);
 ws.getCell('F3').value=null;
 const missing=await wb.xlsx.writeBuffer();
 await assert.rejects(()=>parseWorkbook(missing),/Ratio per capsule 为空/);
 ws.getCell('F3').value={formula:'E3*6'};
 await assert.rejects(()=>wb.xlsx.writeBuffer().then(parseWorkbook),/没有计算结果/);
 assert.throws(()=>apply(config,[records[0]]),/覆盖全部/);
});

test('imported capsule ratios drive backend totals and common cost exactly once',()=>{
 const original={enabled:true,mode:'equal',units_per_pack:6,products:[{id:'a',code:'A',name:'A',source_number:'01',ratio:1},{id:'b',code:'B',name:'B',source_number:'02',ratio:1}]};
 const config=apply(original,[{source_number:'01',code:'A',name:'A',na_ratio:.1389},{source_number:'02',code:'B',name:'B',na_ratio:.0694}]).config;
 const payloads={sales:{mixed_quote:config,header:{fx_hkd_usd:1,fx_rmb_hkd:1},shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}},engineering:{mixed_products:{a:{hardware:[{name:'A',qty:1,unit_price:10}]},b:{hardware:[{name:'B',qty:1,unit_price:20}]}},mixed_shared:{packaging_materials:[{name:'共有包装',qty:1,unit_price:2}]}},molding:{mixed_molds:[]}};
 const sections=Object.entries(payloads).map(([dept,p])=>({dept,payload_json:JSON.stringify(p)}));
 const result=require('../backend/services/mixedQuotation').calculateMixedQuote({qty:100},sections,{strict:true});
 assert.ok(Math.abs(result.final_usd-(10*.1389+20*.0694+2))<1e-10);
 assert.equal(result.cost_units,1);assert.equal(result.common_components.color_box,2);
});

test('partial direct-NA import keeps existing positive fraction and rejects all-zero atomically',()=>{
 const config={enabled:true,mode:'equal',units_per_pack:6,na_direct:true,products:[
  {id:'a',code:'A',name:'A',source_number:'01',ratio:1,na_ratio:.1},
  {id:'b',code:'B',name:'B',source_number:'02',ratio:1,na_ratio:'1/2'},
 ]};
 const before=JSON.stringify(config);
 const updated=apply(config,[{source_number:'01',code:'A',name:'A',na_ratio:0}]);
 assert.equal(updated.config.products[0].na_ratio,0);
 assert.equal(updated.config.products[1].na_ratio,'1/2');
 assert.deepEqual(updated.unmatched,['B']);
 assert.throws(()=>apply(config,[{source_number:'01',code:'A',name:'A',na_ratio:0},{source_number:'02',code:'B',name:'B',na_ratio:0}]),/合计必须大于零/);
 assert.equal(JSON.stringify(config),before);
});

test('capsule numeric exponent values retain precision through import, weights and JSON reload',async()=>{
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('SKU');
 ws.addRow(['NO.','Mini_item no','Discription','Ratio per capsule']);
 ws.addRow([1,'A','A',1e-7]);ws.addRow([2,'B','B',1e21]);
 const {records}=await parseWorkbook(await wb.xlsx.writeBuffer());
 const config=apply({enabled:true,mode:'equal',units_per_pack:6,products:[]},records).config;
 const reloaded=JSON.parse(JSON.stringify(config));
 const weights=require('../frontend/mixed-molds').pricingWeights(reloaded);
 assert.equal(weights[reloaded.products[0].id],1e-7);
 assert.equal(weights[reloaded.products[1].id],1e21);
});

test('capsule parser rejects invalid cells without accepting partial numeric strings',async()=>{
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('SKU');
 ws.addRow(['NO.','Mini_item no','Discription','Ratio per capsule']);
 ws.addRow([1,'A','A',1]);
 for(const value of [-1,'1oops','1/2','NaN','Infinity',true,{formula:'1/0',result:{error:'#DIV/0!'}}]) {
  ws.getCell('D2').value=value;
  await assert.rejects(()=>wb.xlsx.writeBuffer().then(parseWorkbook),/Ratio per capsule 无效/);
 }
});
