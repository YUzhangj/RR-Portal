const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../frontend/mixed-molds');
const { calculateMixedQuote } = require('../backend/services/mixedQuotation');

const config = { enabled:true, mode:'equal', units_per_pack:12,
  products:[{id:'a',code:'A',name:'A'}, {id:'b',code:'B',name:'B'}] };
function fixture() {
  const parts = Array.from({length:145}, (_, i) => ({id:`numbered_${i}`, name:`产品零件${i}`,
    mold_no:`P${i}`, material:'ABS', weight_g:1, cavity:1, target:1000,
    production_demand:100, material_unit_price:.1, machine_price:100, loss_pct:0}));
  const refs = {a:[{part_id:parts[0].id,usage:1}], b:[{part_id:parts[1].id,usage:1}]};
  const shared = [15,19].map((weight, i) => ({mold_no:`0${i+1}M`, name:i ? '球下壳' : '球上壳',
    material:'再生PP+PP', sets:6, machine:'10A', machine_model:'10A', target:null,
    parts:[{name:i ? '球下壳' : '球上壳', material:'再生PP+PP', weight_g:weight, cavity:6,
      injection_run_id:`row:${i+6}`, injection_run_part_index:0}]}));
  return { engineering:{ mixed_imported_parts:parts, mixed_imported_molds:shared,
    mixed_shared:{molds:shared}, mixed_part_selections:refs, mixed_deleted_part_ids:['old_upload'] },
    molding:{mixed_shared:{}, parts_catalog:{version:1, parts:structuredClone(parts), selections:structuredClone(refs)}} };
}
test('#97 旧结构：145条产品零件加2条共有球壳，重复读取不增加、不修改源资料', () => {
  const {engineering,molding} = fixture(), before = JSON.stringify({engineering,molding});
  const merged = M.engineeringCatalog(molding,engineering);
  assert.equal(merged.parts_catalog.parts.length,147);
  assert.deepEqual(merged.parts_catalog.parts.slice(-2).map(p=>[p.name,p.weight_g,p.cavity,p.machine_model,p.target ?? null]),
    [['球上壳',15,6,'10A',null],['球下壳',19,6,'10A',null]]);
  assert.deepEqual(merged.parts_catalog.selections.__shared__.map(r=>r.usage),[1,1]);
  assert.equal(JSON.stringify(M.engineeringCatalog(merged,engineering)),JSON.stringify(merged));
  assert.equal(JSON.stringify({engineering,molding}),before);
  assert.throws(()=>M.catalogRows(merged,config,100),/日产啤次/);
});
test('共有球壳价格及已设用量保留；共有成本每包装一次，不乘12个小产品', () => {
  const {engineering,molding} = fixture();
  const merged = M.engineeringCatalog(molding,engineering);
  const shells = merged.parts_catalog.parts.slice(-2);
  shells.forEach(p=>Object.assign(p,{target:1000,machine_price:100,material_unit_price:.1,loss_pct:0}));
  merged.parts_catalog.selections.__shared__[1].usage=2;
  const again = M.engineeringCatalog(merged,engineering);
  assert.equal(again.parts_catalog.parts.at(-1).target,1000);
  assert.equal(again.parts_catalog.parts.at(-1).material_unit_price,.1);
  const sections = [
    {dept:'sales',payload_json:JSON.stringify({mixed_quote:config,shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}})},
    {dept:'engineering',payload_json:JSON.stringify(engineering)},
    {dept:'molding',payload_json:JSON.stringify(again)},
  ];
  const result = calculateMixedQuote({qty:100},sections,{strict:true});
  assert.ok(Math.abs(result.common_components.dom_mat+result.common_components.imp_mat-5.3)<1e-10);
  assert.ok(Math.abs(result.common_components.injection_labor-.05)<1e-10);
  assert.equal(M.applyCatalog(again,config,100).mixed_shared.injection.length,2);
});
test('已在目录中的球壳复用原ID、价格和工程明确用量，不重复添加', () => {
  const {engineering,molding} = fixture();
  molding.parts_catalog.parts.push({id:'old_ball',name:'球上壳',mold_no:'01M',material:'再生PP+PP',
    weight_g:15,cavity:6,target:2000,material_unit_price:.2});
  engineering.mixed_part_selections.__shared__=[{part_id:'old_ball',usage:3}];
  const catalog=M.engineeringCatalog(molding,engineering).parts_catalog;
  assert.equal(catalog.parts.filter(p=>p.name==='球上壳').length,1);
  assert.equal(catalog.parts.find(p=>p.id==='old_ball').target,2000);
  assert.deepEqual(catalog.selections.__shared__,[{part_id:'old_ball',usage:3}]);
});
test('明确取消选用、删除或完整替换，不会被旧共用模具快照恢复', () => {
  const {engineering,molding} = fixture();
  const merged=M.engineeringCatalog(molding,engineering);
  engineering.mixed_part_selections.__shared__=[];
  assert.deepEqual(M.engineeringCatalog(merged,engineering).parts_catalog.selections.__shared__,[]);
  engineering.mixed_deleted_part_ids.push(merged.parts_catalog.parts.at(-1).id);
  const after=M.engineeringCatalog(merged,engineering);
  assert.equal(after.parts_catalog.parts.some(p=>p.name==='球下壳'),false);
  const replaced=M.prepareMoldImport(engineering,merged.parts_catalog.parts,'replace');
  assert.equal(M.engineeringCatalog(merged,replaced).parts_catalog.parts.length,0);
});
test('工程来源列表缺项不删除已有共有零件，明确删除仍清除对应引用', () => {
  const old={parts_catalog:{version:1,parts:[{id:'upload_ball',name:'球'}],selections:{__shared__:[{part_id:'upload_ball',usage:2}]}}};
  assert.equal(M.engineeringCatalog(old,{mixed_imported_parts:[]}).parts_catalog.parts.length,1);
  const removed=M.engineeringCatalog(old,{mixed_imported_parts:[],mixed_deleted_part_ids:['upload_ball']});
  assert.deepEqual(removed.parts_catalog.parts,[]);
  assert.deepEqual(removed.parts_catalog.selections.__shared__,[]);
});
test('球壳与小产品同为01M时，机型和目标数独立，不能借用另一个模具的参数', () => {
  const {engineering,molding}=fixture();
  engineering.mixed_imported_parts[0].mold_no='01M';
  const merged=M.engineeringCatalog(molding,engineering);
  const shell=merged.parts_catalog.parts.find(p=>p.name==='球上壳');
  const product=merged.parts_catalog.parts[0];
  assert.equal(M.catalogMoldField(merged,shell,'target').value,'');
  assert.throws(()=>M.catalogRows(merged,config,100),/日产啤次/);
  M.updateCatalogMoldField(merged,shell,'target',3000);
  assert.equal(product.target,1000);
  M.updateCatalogMoldField(merged,product,'machine_model','20A');
  assert.equal(shell.machine_model,'10A');
  const again=M.engineeringCatalog(merged,engineering);
  assert.equal(again.parts_catalog.parts.find(p=>p.id===shell.id).target,3000);
});

function sharedMold(name, weight, extra = {}) {
  return {mold_no:'M1',name,material:'ABS',target:1000,machine_price:100,
    parts:[{name,material:'ABS',weight_g:weight,cavity:1,target:1000,
      machine_price:100,material_unit_price:.1,loss_pct:0,note:'',
      injection_run_id:'row:5',injection_run_part_index:0}],...extra};
}
function emptyCatalog() {
  return {parts_catalog:{version:1,parts:[],selections:{a:[],b:[]}}};
}
function legacyEngineering(molds) {
  return {mixed_shared:{molds},mixed_part_selections:{a:[],b:[]}};
}
// Evaluate the exported phase formulas from their inputs, independently of cached results.
function phaseFormulaEvaluator(workbook, overrides={}) {
  const memo=new Map();
  const criterion=(actual,rule)=>{
    const match=String(rule).match(/^(>=|<=|<>|>|<|=)?(-?\d+(?:\.\d+)?)$/);
    if(!match)return String(actual)===String(rule);
    const rhs=Number(match[2]);
    return ({'>=':()=>actual>=rhs,'<=':()=>actual<=rhs,'<>':()=>actual!==rhs,'>':()=>actual>rhs,'<':()=>actual<rhs,'=':()=>actual===rhs})[match[1]||'=']();
  };
  function value(sheetName,address){
    address=address.replaceAll('$','');const key=sheetName+'!'+address;
    if(Object.hasOwn(overrides,key))return overrides[key];
    if(memo.has(key))return memo.get(key);
    const cell=workbook.getWorksheet(sheetName).getCell(address);
    if(!cell.formula)return typeof cell.value==='number'?cell.value:Number(cell.value||0);
    const refs=[],ranges=[];
    let code=cell.formula.replace(/'((?:[^']|'')+)'!(\$?[A-Z]+\$?\d+)/g,(_,sheet,ref)=>{refs.push([sheet.replaceAll("''","'"),ref]);return `REF(${refs.length-1})`;});
    code=code.replace(/(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)/g,(_,from,to)=>{
      const sheet=workbook.getWorksheet(sheetName),first=sheet.getCell(from),last=sheet.getCell(to),cells=[];
      for(let row=first.row;row<=last.row;row++)for(let col=first.col;col<=last.col;col++)cells.push(sheet.getCell(row,col).address);
      ranges.push(cells);return `RANGE(${ranges.length-1})`;
    });
    code=code.replace(/\$?\b[A-Z]+\$?\d+\b/g,ref=>`CELL('${ref}')`).replaceAll('&','+').replace(/(?<![<>=!])=(?!=)/g,'===');
    const result=Function('CELL','REF','RANGE','SUMIF','COUNTIF','MAX','IF','IFERROR','return '+code)(
      ref=>value(sheetName,ref),i=>value(...refs[i]),i=>ranges[i].map(ref=>value(sheetName,ref)),
      (range,rule,sum=range)=>range.reduce((n,item,i)=>n+(criterion(item,rule)?sum[i]:0),0),
      (range,rule)=>range.filter(item=>criterion(item,rule)).length,Math.max,
      (condition,yes,no)=>condition?yes:no,(item,fallback)=>Number.isFinite(item)?item:fallback);
    assert.ok(Number.isFinite(result),key+' formula must recalculate to a finite number');memo.set(key,result);return result;
  }
  return value;
}
async function exportedSharedCase(molds, usages, productExtra={}) {
  const root=emptyCatalog(),engineering=legacyEngineering(molds);
  root.parts_catalog.parts.push({...sharedMold('正常产品',5).parts[0],id:'normal_product',mold_no:'P1',production_demand:100,...productExtra});
  engineering.mixed_part_selections.a=[{part_id:'normal_product',usage:1}];
  engineering.mixed_part_selections.b=[{part_id:'normal_product',usage:1}];
  const merged=M.engineeringCatalog(root,engineering);
  merged.parts_catalog.selections.__shared__.forEach((ref,i)=>ref.usage=usages[i]);
  engineering.mixed_part_selections.__shared__=structuredClone(merged.parts_catalog.selections.__shared__);
  const sections=[
    {dept:'sales',payload_json:JSON.stringify({mixed_quote:config,shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}})},
    {dept:'engineering',payload_json:JSON.stringify(engineering)},
    {dept:'molding',payload_json:JSON.stringify(merged)},
  ];
  const build=require('../backend/services/exportMixedQuotation').buildMixedWorkbook;
  const generated=await build({quote:{qty:100},sections,consolidate:false});
  const workbook=new (require('exceljs').Workbook)();
  await workbook.xlsx.load(await generated.xlsx.writeBuffer());
  return {workbook,merged,engineering,sections,build};
}
test('共有同啤次导出公式缓存与重算一致，Excel改用量后按真实阶段重新分摊', async () => {
  const mold=sharedMold('左右壳',10);
  mold.parts=[{...mold.parts[0],name:'左壳',injection_run_part_index:0},{...mold.parts[0],name:'右壳',injection_run_part_index:1}];
  const {workbook}=await exportedSharedCase([mold],[1,1]);
  const labor=workbook.getWorksheet('封穴啤工计算'),rows=labor.getRows(2,labor.rowCount-1).filter(row=>['左壳','右壳'].includes(row.getCell(2).value));
  const evaluate=phaseFormulaEvaluator(workbook);
  assert.equal(rows.length,2);
  rows.forEach(row=>{assert.match(row.getCell(6).formula,/零件用量/);assert.match(row.getCell(10).formula,/I\d+\/F\d+/);assert.ok(Math.abs(evaluate(labor.name,row.getCell(10).address)-.05)<1e-10);assert.ok(Math.abs(row.getCell(10).result-.05)<1e-10);});
  const right=rows[1],ref=right.getCell(6).formula.match(/'([^']+)'!(\$?[A-Z]+\$?\d+)/);
  assert.ok(ref);const changed=phaseFormulaEvaluator(workbook,{[ref[1]+'!'+ref[2].replaceAll('$','')]:2});
  const total=changed(labor.name,rows[0].getCell(10).address)+2*changed(labor.name,right.getCell(10).address);
  assert.ok(Math.abs(total-.2)<1e-10);
  assert.equal(labor.getCell('F2').formula,undefined,'ordinary product production demand stays a manual value');
});
test('导出跨表同名共有零件保持各自单价、用量与公式引用，最终完整工作簿可生成', async () => {
  const first=sharedMold('同名壳',10,{source_file:'same.xlsx',_sheet_name:'A',_sheet_index:0});
  const second=sharedMold('同名壳',20,{source_file:'same.xlsx',_sheet_name:'B',_sheet_index:1});
  Object.assign(second.parts[0],{target:2000,machine_price:500,material_unit_price:.3});
  const {workbook,build,sections}=await exportedSharedCase([first,second],[1,2]);
  const labor=workbook.getWorksheet('封穴啤工计算'),rows=labor.getRows(2,labor.rowCount-1).filter(row=>row.getCell(2).value==='同名壳');
  assert.equal(rows.length,2);const evaluate=phaseFormulaEvaluator(workbook);
  rows.forEach((row,i)=>{const expected=[.1,.25][i];assert.ok(Math.abs(evaluate(labor.name,row.getCell(10).address)-expected)<1e-10);assert.ok(Math.abs(row.getCell(10).result-expected)<1e-10);});
  const formulas=[];workbook.eachSheet(sheet=>sheet.eachRow(row=>row.eachCell(cell=>{if(cell.formula)formulas.push(cell.formula);})));
  rows.forEach(row=>assert.ok(formulas.some(formula=>formula.includes("'封穴啤工计算'!"+row.getCell(10).address)),`each same-name part must link to its own labor row ${row.number}`));
  const complete=await build({quote:{qty:100},sections});assert.ok(complete.worksheets.length);
  const visible=complete.getWorksheet('总报价表');
  const visibleRows=visible.getRows(2,visible.rowCount-1).filter(row=>row.getCell(2).value==='同名壳'&&row.getCell(22).value!=null);
  assert.equal(visibleRows.length,2);
  const recalculated=phaseFormulaEvaluator(complete);
  visibleRows.forEach((row,i)=>{const cell=row.getCell(22);assert.ok(Math.abs((cell.result??cell.value)-[.1,.25][i])<1e-10,JSON.stringify({row:row.number,value:cell.value,expected:[.1,.25][i]}));assert.ok(Math.abs(recalculated(visible.name,cell.address)-[.1,.25][i])<1e-10);});
});
test('导出产品与共有模具同号时分组独立，公式重算不借用对方机台费', async () => {
  const mold=sharedMold('共有壳',10,{source_file:'common.xlsx'});
  Object.assign(mold.parts[0],{machine_price:200});
  const {workbook}=await exportedSharedCase([mold],[1],{mold_no:'M1',source_file:'product.xlsx'});
  const labor=workbook.getWorksheet('封穴啤工计算'),evaluate=phaseFormulaEvaluator(workbook);
  const product=labor.getRows(2,labor.rowCount-1).find(row=>row.getCell(2).value==='正常产品');
  const common=labor.getRows(2,labor.rowCount-1).find(row=>row.getCell(2).value==='共有壳');
  assert.ok(Math.abs(evaluate(labor.name,product.getCell(10).address)-.1)<1e-10);
  assert.ok(Math.abs(evaluate(labor.name,common.getCell(10).address)-.2)<1e-10);
  assert.equal(product.getCell(10).result,.1);assert.equal(common.getCell(10).result,.2);
});
test('同一父级啤次兼有产品和共有选用时统一批次数量，qty为1也保留动态导出关联', async () => {
  for(const qty of [1,100]) {
    const mold=sharedMold('左右壳',10);
    mold.parts=[{...mold.parts[0],name:'产品左壳',injection_run_part_index:0},{...mold.parts[0],name:'共有右壳',injection_run_part_index:1}];
    const engineering=legacyEngineering([mold]),merged=M.engineeringCatalog(emptyCatalog(),engineering);
    const [left,right]=merged.parts_catalog.parts;left.production_demand=qty;
    engineering.mixed_part_selections={a:[{part_id:left.id,usage:1}],b:[{part_id:left.id,usage:1}],__shared__:[{part_id:right.id,usage:1}]};
    const active=M.engineeringCatalog(merged,engineering),rows=M.catalogRows(active,config,qty).rows;
    assert.equal(rows.a[0].labor_demand,qty);assert.equal(rows.__shared__[0].labor_demand,qty);
    assert.equal(rows.__shared__[0].shared_demand_is_batch,true);
    assert.ok(Math.abs(rows.a[0].shot_price+rows.__shared__[0].shot_price-.1)<1e-10);
    const oneUnit={...config,units_per_pack:1};
    const sections=[
      {dept:'sales',payload_json:JSON.stringify({mixed_quote:oneUnit,shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}})},
      {dept:'engineering',payload_json:JSON.stringify(engineering)},
      {dept:'molding',payload_json:JSON.stringify(active)},
    ];
    const workbook=await require('../backend/services/exportMixedQuotation').buildMixedWorkbook({quote:{qty},sections,consolidate:false});
    const labor=workbook.getWorksheet('封穴啤工计算'),product=labor.getRows(2,labor.rowCount-1).find(row=>row.getCell(2).value==='产品左壳'),common=labor.getRows(2,labor.rowCount-1).find(row=>row.getCell(2).value==='共有右壳');
    assert.match(common.getCell(6).formula,/零件用量.*混装算价参数.*B2/);
    const evaluate=phaseFormulaEvaluator(workbook);
    assert.ok(Math.abs(evaluate(labor.name,product.getCell(10).address)+evaluate(labor.name,common.getCell(10).address)-.1)<1e-10);
    const changed=phaseFormulaEvaluator(workbook,{'混装算价参数!B2':100,[labor.name+'!'+product.getCell(6).address]:100});
    assert.equal(changed(labor.name,common.getCell(6).address),100);
    assert.ok(Math.abs(changed(labor.name,product.getCell(10).address)+changed(labor.name,common.getCell(10).address)-.1)<1e-10);
  }
});
test('不同来源文件的同名同模号共有零件保留独立身份、重量及选用', () => {
  const engineering=legacyEngineering([
    sharedMold('壳',10,{source_file:'A.xlsx'}),
    sharedMold('壳',20,{source_file:'B.xlsx'}),
  ]);
  const root=emptyCatalog(),before=JSON.stringify({root,engineering});
  const merged=M.engineeringCatalog(root,engineering),catalog=merged.parts_catalog;
  assert.equal(catalog.parts.length,2);
  assert.deepEqual(catalog.parts.map(p=>p.weight_g),[10,20]);
  assert.equal(new Set(catalog.parts.map(p=>p.id)).size,2);
  assert.equal(new Set(catalog.parts.map(p=>M.catalogMoldGroupKey(p))).size,2);
  assert.deepEqual(catalog.selections.__shared__.map(r=>r.part_id).sort(),catalog.parts.map(p=>p.id).sort());
  assert.equal(JSON.stringify(M.engineeringCatalog(merged,engineering)),JSON.stringify(merged));
  assert.equal(JSON.stringify({root,engineering}),before);
});
test('实际解析父级工作表字段隔离同文件跨表同名模具，不把独立啤次合并计价', () => {
  const engineering=legacyEngineering([
    sharedMold('壳',10,{source_file:'same.xlsx',_sheet_name:'产品A',_sheet_index:0}),
    sharedMold('壳',20,{source_file:'same.xlsx',_sheet_name:'产品B',_sheet_index:1}),
  ]);
  const merged=M.engineeringCatalog(emptyCatalog(),engineering),parts=merged.parts_catalog.parts;
  assert.equal(parts.length,2);
  assert.equal(new Set(parts.map(p=>M.catalogMoldGroupKey(p))).size,2);
  assert.deepEqual(parts.map(p=>p.weight_g),[10,20]);
  const rows=M.catalogRows(merged,config,100).rows.__shared__;
  assert.deepEqual(rows.map(row=>row.shot_price),[.1,.1]);
  assert.equal(JSON.stringify(M.engineeringCatalog(merged,engineering)),JSON.stringify(merged));
});
test('两个独立父级模具即使名称模号来源和行号都相同，也分别计啤工', () => {
  const engineering=legacyEngineering([
    sharedMold('壳',10,{source_file:'same.xlsx',_sheet_name:'同表',_sheet_index:0}),
    sharedMold('壳',20,{source_file:'same.xlsx',_sheet_name:'同表',_sheet_index:0}),
  ]);
  const merged=M.engineeringCatalog(emptyCatalog(),engineering),parts=merged.parts_catalog.parts;
  assert.equal(parts.length,2);
  assert.equal(new Set(parts.map(p=>p.id)).size,2);
  assert.equal(new Set(parts.map(p=>M.catalogMoldGroupKey(p))).size,2);
  assert.deepEqual(parts.map(p=>p.weight_g),[10,20]);
  assert.deepEqual(M.catalogRows(merged,config,100).rows.__shared__.map(row=>row.shot_price),[.1,.1]);
  assert.equal(JSON.stringify(M.engineeringCatalog(merged,engineering)),JSON.stringify(merged));
});
for(const scenario of [
  {name:'旧目录真实_sheet_name/index不能与新共有另一张表误匹配',old:{_sheet_name:'B',_sheet_index:1},incoming:{_sheet_name:'A',_sheet_index:0}},
  {name:'旧目录只有工作表索引0时不能当空值通配另一张表索引1',old:{_sheet_index:0},incoming:{_sheet_index:1}},
]) test(scenario.name,()=>{
  const root=emptyCatalog();
  const original={...sharedMold('壳',20).parts[0],id:'old_sheet_part',mold_no:'M1',source_file:'same.xlsx',...scenario.old};
  root.parts_catalog.parts.push(original);root.parts_catalog.selections.__shared__=[{part_id:original.id,usage:3}];
  const engineering=legacyEngineering([sharedMold('壳',10,{source_file:'same.xlsx',...scenario.incoming})]);
  const merged=M.engineeringCatalog(root,engineering),parts=merged.parts_catalog.parts;
  assert.equal(parts.length,2);assert.deepEqual(parts.find(p=>p.id===original.id),original);
  assert.equal(parts.find(p=>p.id!==original.id).weight_g,10);
  assert.deepEqual(merged.parts_catalog.selections.__shared__.find(r=>r.part_id===original.id),{part_id:original.id,usage:3});
  assert.equal(merged.parts_catalog.selections.__shared__.length,2);
});
test('产品明确选用的同名同模号零件不能被复用为共有零件', () => {
  const root=emptyCatalog();
  const product={...sharedMold('壳',5).parts[0],id:'product_owned',mold_no:'M1',production_demand:100};
  root.parts_catalog.parts.push(product);
  root.parts_catalog.selections.a=[{part_id:product.id,usage:2}];
  const engineering=legacyEngineering([sharedMold('壳',10)]);
  engineering.mixed_part_selections.a=[{part_id:product.id,usage:2}];
  const merged=M.engineeringCatalog(root,engineering),catalog=merged.parts_catalog;
  assert.equal(catalog.parts.length,2);
  assert.deepEqual(catalog.parts.find(p=>p.id===product.id),product);
  assert.deepEqual(catalog.selections.a,[{part_id:product.id,usage:2}]);
  assert.equal(catalog.selections.__shared__.length,1);
  assert.notEqual(catalog.selections.__shared__[0].part_id,product.id);
  const rows=M.catalogRows(merged,config,100).rows;
  assert.equal(rows.a[0].catalog_raw_weight,5);
  assert.equal(rows.__shared__[0].catalog_raw_weight,10);
  assert.equal(JSON.stringify(M.engineeringCatalog(merged,engineering)),JSON.stringify(merged));
});
test('已有未选目录匹配旧共有快照时不改原模具归组或已选产品啤工', () => {
  const root=emptyCatalog();
  root.parts_catalog.parts=[
    {...sharedMold('扣',5).parts[0],id:'product_buckle',mold_no:'M1',production_demand:100},
    {...sharedMold('壳',10).parts[0],id:'pending_shell',mold_no:'M1',production_demand:100},
  ];
  root.parts_catalog.selections.a=[{part_id:'product_buckle',usage:1}];
  const prior=M.catalogRows(root,config,100).rows.a[0].shot_price;
  near(prior,.05);
  const engineering=legacyEngineering([sharedMold('壳',10)]);
  engineering.mixed_part_selections.a=[{part_id:'product_buckle',usage:1}];
  const merged=M.engineeringCatalog(root,engineering),shell=merged.parts_catalog.parts.find(p=>p.id==='pending_shell');
  assert.equal(merged.parts_catalog.parts.length,2);
  assert.equal(M.catalogMoldGroupKey(shell),'M1');
  assert.deepEqual(merged.parts_catalog.selections.__shared__||[],[]);
  near(M.catalogRows(merged,config,100).rows.a[0].shot_price,prior);
  function near(actual,expected){assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);}
});
test('旧上传明确替换共有模具时移除已迁入旧行及引用，保留无关手工共有费用', () => {
  const root=emptyCatalog();
  root.parts_catalog.parts.push({...sharedMold('手工共有',3).parts[0],id:'manual_shared',mold_no:'MANUAL'});
  root.parts_catalog.selections.__shared__=[{part_id:'manual_shared',usage:2}];
  const oldEngineering=legacyEngineering([sharedMold('旧共有壳',10)]);
  const before=M.engineeringCatalog(root,oldEngineering);
  const old=before.parts_catalog.parts.find(p=>p.name==='旧共有壳');
  assert.ok(old);
  const nextEngineering=M.replaceLegacySharedMolds(oldEngineering,before,[sharedMold('新共有壳',20)]);
  const after=M.engineeringCatalog(before,nextEngineering),catalog=after.parts_catalog;
  assert.equal(catalog.parts.some(p=>p.id===old.id),false);
  assert.equal(catalog.selections.__shared__.some(r=>r.part_id===old.id),false);
  assert.deepEqual(catalog.parts.filter(p=>p.id==='manual_shared'),root.parts_catalog.parts);
  assert.deepEqual(catalog.selections.__shared__.find(r=>r.part_id==='manual_shared'),{part_id:'manual_shared',usage:2});
  assert.equal(catalog.parts.filter(p=>p.name==='新共有壳').length,1);
  assert.equal(catalog.parts.length,2);
  assert.equal(JSON.stringify(M.engineeringCatalog(after,nextEngineering)),JSON.stringify(after));
});
test('被动读取旧共有来源列表缺项不删除已保存行，明确同内容替换仍可重新迁入', () => {
  const engineering=legacyEngineering([sharedMold('共有壳',10)]);
  const before=M.engineeringCatalog(emptyCatalog(),engineering);
  const passive=M.engineeringCatalog(before,legacyEngineering([]));
  assert.equal(JSON.stringify(passive),JSON.stringify(before));
  const replaced=M.replaceLegacySharedMolds(engineering,before,[sharedMold('共有壳',10)]);
  const after=M.engineeringCatalog(before,replaced),catalog=after.parts_catalog;
  assert.equal(catalog.parts.length,1);
  assert.equal(catalog.parts[0].name,'共有壳');
  assert.notEqual(catalog.parts[0].id,before.parts_catalog.parts[0].id);
  assert.deepEqual(catalog.selections.__shared__,[{part_id:catalog.parts[0].id,usage:1}]);
  assert.equal(JSON.stringify(M.engineeringCatalog(after,replaced)),JSON.stringify(after));
});
test('同一啤次左右共有壳只分摊一次啤工，材料重量各自保留', () => {
  const mold=sharedMold('左右壳',10);
  mold.parts=[
    {...mold.parts[0],name:'左壳',weight_g:10,injection_run_part_index:0},
    {...mold.parts[0],name:'右壳',weight_g:20,injection_run_part_index:1},
  ];
  const engineering=legacyEngineering([mold]),root=emptyCatalog();
  for(const id of ['a','b']) {
    root.parts_catalog.parts.push({...sharedMold('产品'+id,1).parts[0],id:'product_'+id,mold_no:'P'+id,production_demand:100});
    engineering.mixed_part_selections[id]=[{part_id:'product_'+id,usage:1}];
  }
  const merged=M.engineeringCatalog(root,engineering);
  const rows=M.catalogRows(merged,config,100).rows.__shared__;
  assert.equal(rows.length,2);
  assert.ok(Math.abs(rows.reduce((sum,row)=>sum+row.shot_price,0)-.1)<1e-10);
  assert.deepEqual(rows.map(row=>row.weight_g),[10,20]);
  const result=calculateMixedQuote({qty:100},[
    {dept:'sales',payload_json:JSON.stringify({mixed_quote:config,shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}})},
    {dept:'engineering',payload_json:JSON.stringify(engineering)},
    {dept:'molding',payload_json:JSON.stringify(merged)},
  ],{strict:true});
  assert.ok(Math.abs(result.common_components.injection_labor-.1)<1e-10);
  assert.ok(Math.abs(result.common_components.dom_mat+result.common_components.imp_mat-3)<1e-10);
});
test('同啤次共有用量1和2按封穴阶段计两次啤工，不同啤次各自计一次', () => {
  const mold=sharedMold('左右壳',10);
  mold.parts=[
    {...mold.parts[0],name:'左壳',injection_run_part_index:0},
    {...mold.parts[0],name:'右壳',injection_run_part_index:1},
  ];
  const together=M.engineeringCatalog(emptyCatalog(),legacyEngineering([mold]));
  together.parts_catalog.selections.__shared__[1].usage=2;
  const rows=M.catalogRows(together,config,100).rows.__shared__;
  assert.ok(Math.abs(rows.reduce((sum,row)=>sum+row.shot_price,0)-.2)<1e-10);
  assert.deepEqual(rows.map(row=>row.catalog_usage),[1,2]);
  const separated=structuredClone(mold);
  separated.parts[1].injection_run_id='row:6';
  const separateRows=M.catalogRows(M.engineeringCatalog(emptyCatalog(),legacyEngineering([separated])),config,100).rows.__shared__;
  assert.deepEqual(separateRows.map(row=>row.shot_price),[.1,.1]);
});
test('明确替换共有模具保留另有产品引用的旧行和价格，不把它加入删除清单', () => {
  const engineering=legacyEngineering([sharedMold('共有壳',10)]);
  const before=M.engineeringCatalog(emptyCatalog(),engineering),old=before.parts_catalog.parts[0];
  Object.assign(old,{production_demand:100,target:500,machine_price:777,material_unit_price:.7});
  before.parts_catalog.selections.a=[{part_id:old.id,usage:3}];
  engineering.mixed_part_selections.a=[{part_id:old.id,usage:3}];
  const replaced=M.replaceLegacySharedMolds(engineering,before,[sharedMold('共有壳',20)]);
  assert.equal((replaced.mixed_deleted_part_ids||[]).includes(old.id),false);
  const after=M.engineeringCatalog(before,replaced),catalog=after.parts_catalog;
  const retained=catalog.parts.find(p=>p.id===old.id);
  assert.deepEqual([retained.weight_g,retained.target,retained.machine_price,retained.material_unit_price],[10,500,777,.7]);
  assert.deepEqual(catalog.selections.a,[{part_id:old.id,usage:3}]);
  assert.equal(catalog.selections.__shared__.some(r=>r.part_id===old.id),false);
  assert.equal(catalog.selections.__shared__.length,1);
  const newPart=catalog.parts.find(p=>p.id===catalog.selections.__shared__[0].part_id);
  assert.deepEqual([newPart.weight_g,newPart.target,newPart.machine_price,newPart.material_unit_price],[20,1000,100,.1]);
});
test('明确同内容替换使用新版本参数，不继承已删除旧行的啤价和用量', () => {
  const engineering=legacyEngineering([sharedMold('共有壳',10)]);
  const before=M.engineeringCatalog(emptyCatalog(),engineering),old=before.parts_catalog.parts[0];
  Object.assign(old,{target:500,machine_price:777,material_unit_price:.7});
  before.parts_catalog.selections.__shared__[0].usage=9;
  const replaced=M.replaceLegacySharedMolds(engineering,before,[sharedMold('共有壳',10)]);
  const after=M.engineeringCatalog(before,replaced),catalog=after.parts_catalog,newPart=catalog.parts[0];
  assert.equal(catalog.parts.length,1);
  assert.notEqual(newPart.id,old.id);
  assert.deepEqual([newPart.target,newPart.machine_price,newPart.material_unit_price],[1000,100,.1]);
  assert.deepEqual(catalog.selections.__shared__,[{part_id:newPart.id,usage:1}]);
});
test('明确取消共有选用后，旧快照的缺参数零件不会阻断原本可计算的产品报价', () => {
  const root=emptyCatalog();
  root.parts_catalog.parts.push({...sharedMold('正常产品',5).parts[0],id:'valid_product',mold_no:'P1',production_demand:100});
  root.parts_catalog.selections.a=[{part_id:'valid_product',usage:1}];
  const mold=sharedMold('已取消缺参数壳',10,{target:null});
  mold.parts[0].target=null;
  const engineering=legacyEngineering([mold]);
  engineering.mixed_part_selections={a:[{part_id:'valid_product',usage:1}],b:[],__shared__:[]};
  const merged=M.engineeringCatalog(root,engineering);
  assert.deepEqual(merged.parts_catalog.selections.__shared__,[]);
  const rows=M.catalogRows(merged,config,100).rows;
  assert.equal(rows.a.length,1);
  assert.deepEqual(rows.__shared__,[]);
});
test('已保存共有零件取消选用保留价格且可导出，重新选用恢复计价', async () => {
  const root=emptyCatalog();
  root.parts_catalog.parts.push({...sharedMold('正常产品',5).parts[0],id:'normal_product',mold_no:'P1',production_demand:100});
  const engineering=legacyEngineering([sharedMold('可取消共有壳',10)]);
  engineering.mixed_part_selections.a=[{part_id:'normal_product',usage:1}];
  engineering.mixed_part_selections.b=[{part_id:'normal_product',usage:1}];
  const saved=M.engineeringCatalog(root,engineering),common=saved.parts_catalog.parts.find(p=>p.name==='可取消共有壳');
  Object.assign(common,{machine_price:200,material_unit_price:.4});
  assert.equal(common.production_demand??null,null);
  engineering.mixed_part_selections.__shared__=[];
  const cancelled=M.engineeringCatalog(saved,engineering);
  const retained=cancelled.parts_catalog.parts.find(p=>p.id===common.id);
  assert.deepEqual([retained.machine_price,retained.material_unit_price],[200,.4]);
  const rows=M.catalogRows(cancelled,config,100).rows;
  assert.equal(rows.a.length,1);assert.deepEqual(rows.__shared__,[]);
  const sections=[
    {dept:'sales',payload_json:JSON.stringify({mixed_quote:config,shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}})},
    {dept:'engineering',payload_json:JSON.stringify(engineering)},
    {dept:'molding',payload_json:JSON.stringify(cancelled)},
  ];
  const workbook=await require('../backend/services/exportMixedQuotation').buildMixedWorkbook({quote:{qty:100},sections});
  assert.ok(workbook.worksheets.length);
  assert.equal(calculateMixedQuote({qty:100},sections,{strict:true}).common_components.injection_labor,0);
  engineering.mixed_part_selections.__shared__=[{part_id:common.id,usage:1}];
  const restored=M.catalogRows(M.engineeringCatalog(cancelled,engineering),config,100).rows.__shared__;
  assert.equal(restored.length,1);assert.equal(restored[0].id,common.id);
  assert.equal(restored[0].shot_price,.2);assert.equal(restored[0].material_unit_price,.4);
});

test('真实保存接口：旧共用模具补入、草稿保存、缺参数拦截及重新打开算价', {timeout:30000}, async t => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
  const {spawn}=require('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shared-molds-api-'));
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.execPath,['backend/server.js'],{cwd:path.join(__dirname,'..'),env:{
    ...process.env,NODE_ENV:'test',DB_DRIVER:'sqlite',DB_FILE:path.join(dir,'test.db'),DATABASE_URL:'',
    PORT:String(port),HOST:'127.0.0.1',SESSION_SECRET:'legacy-shared-test',COOKIE_SECURE:'0',ADMIN_INITIAL_PASSWORD:'shared-test',
  },stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',chunk=>{logs+=chunk;});
  t.after(async()=>{if(child.exitCode==null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(dir,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(logs || 'Server start timed out')),15000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('listening on')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}: ${logs}`));});
  });
  let cookie='';
  async function api(url,method='GET',body,status=200){
    const res=await fetch(`http://127.0.0.1:${port}/api${url}`,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body?JSON.stringify(body):undefined});
    if(res.headers.getSetCookie().length)cookie=res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;
  }
  await api('/auth/login','POST',{username:'admin',password:'shared-test'});
  const created=await api('/quotes','POST',{quote_no:'LEGACY-SHARED',product_name:'共有球壳回归',customer:'TEST',qty:100,quote_type:'mixed'});
  let data=await api('/quotes/'+created.id);
  await api(`/quotes/${created.id}/mixed`,'PUT',{config,expected_config:data.mixed_quote});
  data=await api('/quotes/'+created.id);
  const id=dept=>data.sections.find(s=>s.dept===dept).id;
  const {engineering,molding}=fixture();
  await api('/sections/'+id('engineering'),'PUT',{payload:engineering});
  await api('/sections/'+id('molding'),'PUT',{payload:molding});
  let saved=JSON.parse((await api('/quotes/'+created.id)).sections.find(s=>s.dept==='molding').payload_json);
  assert.equal(saved.parts_catalog.parts.length,147);
  assert.equal(saved.parts_catalog.selections.__shared__.length,2);
  await api('/sections/'+id('molding'),'PUT',{payload:saved,submit:true},400);
  saved.parts_catalog.parts.slice(-2).forEach(p=>Object.assign(p,{target:1000,machine_price:100,material_unit_price:.1,loss_pct:0}));
  await api('/sections/'+id('molding'),'PUT',{payload:saved});
  const sales={mixed_quote:config,shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}};
  await api('/sections/'+id('sales'),'PUT',{payload:sales});
  data=await api('/quotes/'+created.id);
  saved=JSON.parse(data.sections.find(s=>s.dept==='molding').payload_json);
  assert.equal(saved.mixed_shared.injection.length,2);
  assert.equal(saved.parts_catalog.parts.at(-1).target,1000);
  const result=await api(`/quotes/${created.id}/mixed`);
  assert.equal(result.valid,true);
  assert.ok(Math.abs(result.common_components.dom_mat+result.common_components.imp_mat-3.4)<1e-10);
  assert.ok(Math.abs(result.common_components.injection_labor-1/30)<1e-10);
});
