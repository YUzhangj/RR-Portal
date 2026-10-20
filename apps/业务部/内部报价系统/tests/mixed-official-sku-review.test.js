const test=require('node:test'),assert=require('node:assert/strict');
const sku=require('../frontend/mixed-sku');
const {importParts,reconcileProductSelections}=require('../backend/services/mixedPartImport');
const product=(id,code,source_number='1')=>({id,code,source_number,name:code,ratio:1});
const cfg=products=>({enabled:true,mode:'equal',units_per_pack:1,products});
const products=[product('a','BEAUTYM-S3-037','36'),product('b','BEAUTYM-S3-038','37')];
test('补齐B正式货号时关联已选用A的共用零件，保留原用量价格并幂等',()=>{
 const config=cfg(products),part={id:'cap',name:'共用盖',source_product_code:'BEAUTYM-S3-037/BEAUTYM-S3-038',shot_price:.5,material_unit_price:.02};
 const engineering={mixed_imported_parts:[part],mixed_part_selections:{a:[{part_id:'cap',usage:2}]}};
 const molding={parts_catalog:{parts:[part],selections:engineering.mixed_part_selections}};
 const result=reconcileProductSelections(config,engineering,molding,{updatedProductIds:['b']});
 assert.deepEqual(result.engineering.mixed_part_selections,{a:[{part_id:'cap',usage:2}],b:[{part_id:'cap',usage:2}]});
 assert.deepEqual(result.molding.parts_catalog.parts,molding.parts_catalog.parts);assert.equal(result.changes.length,1);
 assert.equal(reconcileProductSelections(config,result.engineering,result.molding).changes.length,0);assert.equal(engineering.mixed_part_selections.b,undefined);
});
test('共用零件已有不同合法用量时不猜测第三款用量，完整合法关系则保留',()=>{
 const config=cfg([...products,product('c','BEAUTYM-S3-039','38')]);
 const part={id:'cap',name:'共用盖',source_product_code:'BEAUTYM-S3-037/BEAUTYM-S3-038/BEAUTYM-S3-039'};
 const refs={a:[{part_id:'cap',usage:2}],b:[{part_id:'cap',usage:3}]};
 assert.throws(()=>sku.repairNumberedSelections(config,refs,[part]),/用量/);
 const complete={...refs,c:[{part_id:'cap',usage:4}]};assert.deepEqual(sku.repairNumberedSelections(config,complete,[part]).selections,complete);
});
test('完整正式货号优先于相同尾号数字占位，不错误拒绝或改写占位ID',()=>{
 const config=cfg([product('formal','BEAUTYM-S3-037'),product('placeholder','37')]);
 const result=sku.apply(config,[{source_number:'36',code:'BEAUTYM-S3-037',name:'正式款'}]);
 assert.equal(result.matched,1);assert.equal(result.added,0);assert.equal(result.config.products.find(p=>p.id==='placeholder').code,'37');
 assert.deepEqual(sku.productsForPartCode(config,'BEAUTYM-S3-037').map(p=>p.id),['formal']);
});
test('两个正式货号争用同一数字占位时SKU导入拒绝，不依赖表内顺序',()=>{
 const config=cfg([product('placeholder','37'),product('other','99')]);
 const rows=[{source_number:'1',code:'BEAUTYM-S3-037',name:'A'},{source_number:'2',code:'OTHER-S3-037',name:'B'}];
 for(const records of [rows,[...rows].reverse()])assert.throws(()=>sku.apply(config,records),/占位|多个/);
 assert.equal(config.products[0].code,'37');
});
test('两个正式货号争用同一数字占位时模具导入同样拒绝',()=>{
 const config=cfg([product('placeholder','37'),product('other','99')]);
 assert.throws(()=>importParts(config,{},[{mold_no:'M',parts:[{name:'共用盖',source_product_code:'BEAUTYM-S3-037/OTHER-S3-037'}]}]),/占位|多个/);
});
test('其他正式货号也按完整号末尾编号匹配旧表，不使用配比表NO',()=>{
 assert.equal(sku.productPartNumber(product('generic','ACME-037','36')),'37');
 const config=cfg([product('generic','ACME-037','36'),product('other','ACME-038','37')]);
 const result=importParts(config,{},[{mold_no:'M',parts:[{name:'37-瓶盖'},{name:'38-瓶身'}]}]);
 const byId=new Map(result.engineering.mixed_imported_parts.map(p=>[p.id,p.name]));
 assert.equal(byId.get(result.engineering.mixed_part_selections.generic[0].part_id),'37-瓶盖');
});
