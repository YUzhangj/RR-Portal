const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const ts=require('typescript');
function read(name){const source=fs.readFileSync(`lib/${name}.ts`,'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;const ref={exports:{}};new Function('module','exports','require',js)(ref,ref.exports,path=>path.endsWith('.json')?require('../services/email-parser/app/truck-rules.json'):read('warehouse-truck'));return ref.exports;}
const {initialTrips,tripErrors,allocatedCargo}=read('warehouse-trips');
const items=[{product_code:'A',source_row:1,quantity:100,pieces:10,volume:40}];
const trip=(key,volume,quantity=50,pieces=5)=>({key,warehouse:'裕泰仓',vehicle_type:'',allocations:[{item_index:0,quantity:String(quantity),pieces:String(pieces),volume:String(volume)}]});
test('按现有分组建立草稿，超35提示，人工分配守恒',()=>{
 const initial=initialTrips({items,warehouse_groups:[{warehouse:'裕泰仓',items}]});assert.equal(initial.length,1);assert.ok(tripErrors(items,initial).some(error=>error.includes('35')));
 assert.deepEqual(tripErrors(items,[trip('A',20),trip('B',20)]),[]);
 assert.ok(tripErrors(items,[trip('A',20)]).some(error=>error.includes('合计')));
 assert.ok(tripErrors(items,[trip('A',36),trip('B',4)]).some(error=>error.includes('35')));
 assert.deepEqual(tripErrors([{...items[0],volume:70}],[trip('A',35),trip('B',35)]),[]);
});
test('混装共享体积只计一次，但同组不能跨车',()=>{
 const mixed=[{...items[0],volume:20,packing_group:'M'},{...items[0],product_code:'B',volume:20,packing_group:'M'}];
 const rows=mixed.map((_,item_index)=>({item_index,quantity:'100',pieces:'10',volume:'20'}));
 assert.deepEqual(tripErrors(mixed,[{...trip('A',20),allocations:rows}]),[]);
 assert.ok(tripErrors(mixed,[{...trip('A',20),allocations:[rows[0]]},{...trip('B',20),allocations:[rows[1]]}]).some(error=>error.includes('同一已确认混装组')));
});

test('拆行卡板必须人工分配，不能重复沿用原卡板数',()=>{
 const palletItems=[{...items[0],pallet_count:4}];
 const trips=[trip('A',20),trip('B',20)];
 assert.ok(tripErrors(palletItems,trips).some(error=>error.includes('卡板')));
 trips[0].allocations[0].pallet_count='2';trips[1].allocations[0].pallet_count='2';
 assert.deepEqual(tripErrors(palletItems,trips),[]);
 trips[1].allocations[0].pallet_count='4';
 assert.ok(tripErrors(palletItems,trips).some(error=>error.includes('卡板合计')));
});

const sparseMixed=[{product_code:'A',source_file:'packing.xlsx',source_row:1,quantity:100,pieces:10,volume:20,pallet_count:2,packing_group:'M'},
 {product_code:'B',source_file:'packing.xlsx',source_row:2,quantity:50,pieces:null,volume:null,pallet_count:null,packing_group:'M'}];
function sparseTrips(cargo=sparseMixed){return initialTrips({items:cargo,warehouse_groups:[{warehouse:'裕泰仓',items:cargo}]});}
test('混装首行共享合计和空后行可整组分车，不把共享数逐行相加',()=>{
 const trips=sparseTrips();assert.deepEqual(tripErrors(sparseMixed,trips),[]);
 assert.deepEqual(trips[0].allocations.map(row=>[row.quantity,row.pieces,row.volume,row.pallet_count]),[['100','10','20','2'],['50','','','']]);
 const repeated=sparseMixed.map(item=>({...item,pieces:10,volume:20,pallet_count:2}));
 assert.deepEqual(tripErrors(repeated,sparseTrips(repeated)),[]);
 const noPallets=sparseMixed.map(item=>({...item,pallet_count:null}));
 assert.deepEqual(tripErrors(noPallets,sparseTrips(noPallets)),[]);
 assert.equal(sparseTrips(noPallets)[0].allocations[0].pallet_count,'');
});
test('混装原组共享资料矛盾、全缺和分配矛盾不能确认',()=>{
 for(const [field,value] of [['pieces',15],['volume',21],['pallet_count',3]]){
  const bad=structuredClone(sparseMixed);bad[1][field]=value;
  assert.ok(tripErrors(bad,sparseTrips(bad)).some(error=>error.includes('不一致')));
 }
 for(const field of ['pieces','volume']){
  const bad=structuredClone(sparseMixed);bad[0][field]=null;
  assert.ok(tripErrors(bad,sparseTrips(bad)).some(error=>error.includes('缺少共享件数或体积')));
 }
 const wrong=sparseTrips();wrong[0].allocations[1].pieces='15';
 assert.ok(tripErrors(sparseMixed,wrong).some(error=>error.includes('原组资料一致')));
 const cleared=sparseTrips();cleared[0].allocations[0].pieces='';
 assert.ok(tripErrors(sparseMixed,cleared).some(error=>error.includes('不能在分配时清空')));
 const noPallets=sparseMixed.map(item=>({...item,pallet_count:null}));const invented=sparseTrips(noPallets);invented[0].allocations[0].pallet_count='0';
 assert.ok(tripErrors(noPallets,invented).some(error=>error.includes('原组资料一致')));
});
test('混装每SKU仅一次且整组同车，普通货物拆分仍独立守恒',()=>{
 const duplicate=sparseTrips();duplicate[0].allocations.push({...duplicate[0].allocations[1]});
 assert.ok(tripErrors(sparseMixed,duplicate).some(error=>error.includes('不支持拆行')));
 const crossed=sparseTrips();const moved=crossed[0].allocations.pop();crossed.push({key:'other',warehouse:'裕泰仓',vehicle_type:'1*8T',allocations:[moved]});
 assert.ok(tripErrors(sparseMixed,crossed).some(error=>error.includes('同一已确认混装组')));
 assert.deepEqual(tripErrors(items,[trip('A',20),trip('B',20)]),[]);
});
test('预览稳定按原货物序输出且同SKU普通分片保留片序',()=>{
 const source=[...sparseMixed,{product_code:'PLAIN',quantity:1,pieces:1,volume:1}];const trips=sparseTrips(source);
 trips[0].allocations=[trips[0].allocations[0],trips[0].allocations[2],trips[0].allocations[1]];
 assert.deepEqual(tripErrors(source,trips),[]);
 assert.deepEqual(allocatedCargo(source,trips[0]).map(row=>row.product_code),['A','B','PLAIN']);
 assert.deepEqual(allocatedCargo(items,{...trip('A',20),allocations:[{item_index:0,quantity:'20',pieces:'2',volume:'8'},{item_index:0,quantity:'30',pieces:'3',volume:'12'}]}).map(row=>row.quantity),['20','30']);
});
test('混装不能按通知范围二次拆组，共享原毛重必须一致且净重仍逐SKU独立',()=>{
 const cargo=sparseMixed.map((item,index)=>({...item,shipment_scope:index?'waiting':'current',gross_weight:index?null:25.2,net_weight:index?4:3}));
 assert.ok(tripErrors(cargo,sparseTrips(cargo),true).some(error=>error.includes('不能拆分为本次出运和等待通知')));
 cargo[1].shipment_scope='current';assert.deepEqual(tripErrors(cargo,sparseTrips(cargo),true),[]);
 for(const invalid of [99,-1,'not-a-number']){cargo[1].gross_weight=invalid;assert.ok(tripErrors(cargo,sparseTrips(cargo),true).some(error=>error.includes('共享毛重')));}
});
test('普通货物volume空值与初稿一致使用cbm别名',()=>{
 const cargo=[{product_code:'A',quantity:10,pieces:1,volume:'',cbm:1}];
 assert.deepEqual(tripErrors(cargo,sparseTrips(cargo)),[]);
});
