const test=require('node:test'),assert=require('node:assert/strict');
const {apply,productSerial,productPartNumber,repairNumberedSelections}=require('../frontend/mixed-sku');
const {importParts,reconcileProductSelections}=require('../backend/services/mixedPartImport');
const products=[{id:'sku36',code:'BEAUTYM-S3-037',source_number:'36',name:'指甲胶',ratio:1},{id:'sku37',code:'BEAUTYM-S3-038',source_number:'37',name:'面膜',ratio:1}];
const config={enabled:true,mode:'equal',units_per_pack:1,products};

test('模具零件按正式货号末尾编号关联，NO.序号保留但不用于此关联',()=>{
 assert.equal(productSerial(products[1]),'37');assert.equal(productPartNumber(products[1]),'38');
 const molds=[{mold_no:'M1',parts:[{name:'37-瓶盖',material:'ABS'},{name:'38-罐盖',material:'ABS'}]}];
 const imported=importParts(config,{},molds);
 assert.equal(imported.config.products.length,2);
 const byId=new Map(imported.engineering.mixed_imported_parts.map(p=>[p.id,p.name]));
 assert.equal(byId.get(imported.engineering.mixed_part_selections.sku36[0].part_id),'37-瓶盖');
 assert.equal(byId.get(imported.engineering.mixed_part_selections.sku37[0].part_id),'38-罐盖');
});

test('SKU配比资料跳号时按正式货号更新占位款，保留原ID及NA比例',()=>{
 const initial={enabled:true,mode:'equal',units_per_pack:1,products:[{id:'number_37',code:'37',name:'旧37',ratio:2},{id:'number_38',code:'38',name:'旧38',ratio:3}]};
 const records=[{source_number:'36',code:'BEAUTYM-S3-037',name:'指甲胶',na_ratio:.1},{source_number:'37',code:'BEAUTYM-S3-038',name:'面膜',na_ratio:.2}];
 const result=apply(initial,records);
 assert.equal(result.added,0);assert.equal(result.matched,2);
 assert.equal(result.config.products[0].code,'BEAUTYM-S3-037');assert.equal(result.config.products[0].source_number,'36');
 assert.equal(result.config.products[1].code,'BEAUTYM-S3-038');assert.equal(result.config.products[1].na_ratio,.2);
 const repeated=apply(result.config,records);
 assert.deepEqual(repeated.config,result.config);
 assert.equal(initial.products[0].code,'37');
});

test('校正旧NO.自动关联保留用量，共用及手选其他关系保留，重复运行不再改动',()=>{
 const refs={sku37:[{part_id:'cap37',usage:2},{part_id:'manual',usage:3}],__shared__:[{part_id:'common',usage:1}]};
 const parts=[{id:'cap37',name:'37-瓶盖'},{id:'manual',name:'其他胶件'},{id:'common',name:'共有盖'}];
 const original=structuredClone(refs),plan=repairNumberedSelections(config,refs,parts);
 assert.deepEqual(refs,original);assert.deepEqual(plan.selections.sku36,[{part_id:'cap37',usage:2}]);
 assert.deepEqual(plan.selections.sku37,[{part_id:'manual',usage:3}]);assert.deepEqual(plan.selections.__shared__,refs.__shared__);
 assert.equal(plan.changes[0].from,'BEAUTYM-S3-038');assert.equal(plan.changes[0].to,'BEAUTYM-S3-037');
 assert.equal(repairNumberedSelections(config,plan.selections,parts).changes.length,0);
});

test('缺少或重复正式货号不猜测关联，目标用量冲突阻止应用',()=>{
 const refs={sku37:[{part_id:'p',usage:2}]},parts=[{id:'p',name:'37-瓶盖'}];
 const missing=repairNumberedSelections({...config,products:[products[1]]},refs,parts);
 assert.equal(missing.changes.length,0);assert.equal(missing.unresolved.length,1);assert.deepEqual(missing.selections,refs);
 const duplicate=repairNumberedSelections({...config,products:[...products,{...products[0],id:'dup'}]},refs,parts);
 assert.equal(duplicate.changes.length,0);assert.equal(duplicate.unresolved.length,1);
 assert.throws(()=>repairNumberedSelections(config,{...refs,sku36:[{part_id:'p',usage:1}]},parts),/用量不同/);
});

test('重新导入模具会清除旧NO.关系，机器价格及用量保留',()=>{
 const part={id:'old37',mold_no:'M',name:'37-瓶盖',material:'ABS',machine:'14A',material_unit_price:.02,target:2640};
 const eng={mixed_imported_parts:[part],mixed_part_selections:{sku37:[{part_id:'old37',usage:2}]}};
 const result=importParts(config,eng,[{mold_no:'M',parts:[{name:'37-瓶盖',material:'ABS'}]}],{existingParts:[part]});
 assert.deepEqual(result.engineering.mixed_part_selections.sku37,[]);
 assert.deepEqual(result.engineering.mixed_part_selections.sku36,[{part_id:'old37',usage:2}]);
 assert.equal(result.engineering.mixed_imported_parts[0].material_unit_price,.02);
 assert.equal(eng.mixed_part_selections.sku37.length,1);
});

test('先导入模具再导入配比表，跳号资料不改变已有零件选用关系',()=>{
 const empty={...config,products:[]};
 const molds=[{mold_no:'M',parts:[{name:'37-瓶盖',material:'ABS'},{name:'38-瓶身',material:'ABS'}]}];
 const imported=importParts(empty,{},molds);
 const records=[{source_number:'36',code:'BEAUTYM-S3-037',name:'指甲胶',na_ratio:.1},{source_number:'37',code:'BEAUTYM-S3-038',name:'面膜',na_ratio:.2}];
 const next=apply(imported.config,records).config;
 const linked=reconcileProductSelections(next,imported.engineering,{});
 assert.equal(next.products.find(p=>p.id==='number_37').code,'BEAUTYM-S3-037');
 assert.deepEqual(linked.engineering.mixed_part_selections,imported.engineering.mixed_part_selections);
 assert.equal(linked.changes.length,0);
});

test('配比表重新导入时自动同步旧关联，保留啤机价格和其他部门资料',()=>{
 const part={id:'p',name:'37-瓶盖',material_unit_price:.02,shot_price:.5};
 const refs={sku37:[{part_id:'p',usage:2}]};
 const eng={mixed_imported_parts:[part],mixed_part_selections:refs,mixed_shared:{hardware:[{name:'共有五金',qty:1,unit_price:3}]}};
 const molding={parts_catalog:{parts:[part],selections:refs}};
 const result=reconcileProductSelections(config,eng,molding);
 assert.deepEqual(result.engineering.mixed_part_selections.sku36,[{part_id:'p',usage:2}]);
 assert.deepEqual(result.engineering.mixed_part_selections.sku37,[]);
 assert.deepEqual(result.molding.parts_catalog.parts,molding.parts_catalog.parts);
 assert.deepEqual(result.molding.parts_catalog.selections,result.engineering.mixed_part_selections);
 assert.deepEqual(result.engineering.mixed_shared,eng.mixed_shared);
 assert.deepEqual(eng.mixed_part_selections,refs);
 assert.equal(reconcileProductSelections(config,result.engineering,result.molding).changes.length,0);
});

test('配比表NO.相同不能冒充缺失的正式货号覆盖NA比例',()=>{
 const initial={...config,products:[{id:'number_36',code:'36',name:'小产品36',ratio:1}]};
 assert.throws(()=>apply(initial,[{source_number:'36',code:'BEAUTYM-S3-037',name:'指甲胶',na_ratio:.1}]),/覆盖全部.*36/);
});

test('工程页面保留正常导入，不再增加手动校正入口',()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const node=()=>({html:'',nodes:{},children:[],textContent:'',style:{},selectedOptions:[{textContent:'包装材料'}],get innerHTML(){return this.html;},set innerHTML(v){this.html=v;},querySelector(k){return this.nodes[k] ||= node();},querySelectorAll(){return [];},appendChild(v){this.children.push(v);},insertBefore(v){this.children.push(v);}});
 const root={mixed_imported_parts:[{id:'p',name:'37-瓶盖'}],mixed_part_selections:{sku37:[{part_id:'p',usage:2}]}};
 const host=node();
 const window={__data:{quote:{id:1,qty:1},mixed_quote:config,sections:[]},MixedSku:require('../frontend/mixed-sku'),MixedMolds:{engineeringCatalog:()=>({})},attachSupplierMaterialImportUI(){}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/mixed-quotation.js'),'utf8'),{window,document:{createElement:node},sessionStorage:{getItem:()=> 'sku37',setItem(){}}});
 window.MixedQuotation.wrap(()=>{},'engineering')(host,root,true,()=>{});
 assert.equal(host.children.some(c=>c.innerHTML.includes('data-check-sku-links')),false);
 assert.ok(host.children.some(c=>c.innerHTML.includes('data-supplier-file')));
});

function moldWorkbook(rows,merges=[]) {
 const XLSX=require('xlsx'),wb=XLSX.utils.book_new();
 const sheet=XLSX.utils.aoa_to_sheet([['模号','产品Item＃','模具名称','配件名称','胶料类型','型腔','套数','零件重量(g)'],...rows]);
 sheet['!merges']=merges;XLSX.utils.book_append_sheet(wb,sheet,'tp');
 return require('../backend/services/parseMoldSheet').parseWorkbook(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));
}
test('产品Item＃优先于零件名称编号，完整货号不按NO.匹配，三个货号共用同一零件',()=>{
 const parsed=moldWorkbook([
  ['M','BEAUTYM-S3-037','','38-瓶盖','ABS',2,2,1],
  ['','BEAUTYM-S3-052、BEAUTYM-S3-053、BEAUTYM-S3-054','','共用下瓶身','ABS',2,2,2],
 ]);
 const {summarize}=require('../backend/services/mixedPartImport');
 const summary=summarize(parsed.molds);
 assert.equal(parsed.cols_found.product_code,1);assert.equal(summary.part_count,2);assert.equal(summary.product_count,4);
 const result=importParts(config,{},parsed.molds);
 const parts=result.engineering.mixed_imported_parts;
 assert.deepEqual(result.engineering.mixed_part_selections.sku36,[{part_id:parts[0].id,usage:1}]);
 assert.equal(result.engineering.mixed_part_selections.sku37,undefined);
 const shared=result.config.products.filter(p=>/-05[234]$/.test(p.code));
 assert.equal(shared.length,3);
 for(const p of shared)assert.deepEqual(result.engineering.mixed_part_selections[p.id],[{part_id:parts[1].id,usage:1}]);
 assert.equal(new Set(shared.flatMap(p=>result.engineering.mixed_part_selections[p.id].map(r=>r.part_id))).size,1);
});
test('货号只在真实合并单元格内展开，普通空白用零件编号且不沿用上一货号',()=>{
 const parsed=moldWorkbook([
  ['M','BEAUTYM-S3-037','','瓶盖','ABS',2,2,1],
  ['','','','瓶身','ABS',2,2,2],
  ['M2','','','38-瓶身','ABS',2,2,3],
 ],[{s:{r:1,c:1},e:{r:2,c:1}}]);
 const parts=parsed.molds.flatMap(m=>m.parts);
 assert.deepEqual(parts.map(p=>p.source_product_code),['BEAUTYM-S3-037','BEAUTYM-S3-037',undefined]);
 const result=importParts(config,{},parsed.molds);
 assert.equal(result.engineering.mixed_part_selections.sku36.length,2);
 assert.equal(result.engineering.mixed_part_selections.sku37.length,1);
});
test('新增货号列再次导入会自动更正原归属，保留零件ID、原价格和用量',()=>{
 const old={id:'old',mold_no:'M',name:'37-瓶盖',material:'ABS',color:'',shot_price:.5,material_unit_price:.02};
 const eng={mixed_imported_parts:[old],mixed_part_selections:{sku37:[{part_id:'old',usage:2}]}};
 const parsed=moldWorkbook([['M','BEAUTYM-S3-037','','37-瓶盖','ABS',2,2,1]]);
 const result=importParts(config,eng,parsed.molds,{existingParts:[old]});
 assert.equal(result.engineering.mixed_imported_parts.length,1);
 const p=result.engineering.mixed_imported_parts[0];
 assert.equal(p.id,'old');assert.equal(p.source_product_code,'BEAUTYM-S3-037');assert.equal(p.shot_price,.5);assert.equal(p.material_unit_price,.02);
 assert.deepEqual(result.engineering.mixed_part_selections.sku36,[{part_id:'old',usage:2}]);
 assert.deepEqual(result.engineering.mixed_part_selections.sku37,[]);
 const again=importParts(result.config,result.engineering,parsed.molds,{existingParts:result.engineering.mixed_imported_parts});
 assert.deepEqual(again.engineering.mixed_part_selections,result.engineering.mixed_part_selections);
});
