const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const ts=require('typescript');
function read(name){const source=fs.readFileSync(`lib/${name}.ts`,'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;const ref={exports:{}};new Function('module','exports','require',js)(ref,ref.exports,path=>path.endsWith('.json')?require('../services/email-parser/app/truck-rules.json'):read('warehouse-truck'));return ref.exports;}
const {initialTrips,tripErrors}=read('warehouse-trips');
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
