import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import core from '../shared/business-sync.cjs';
import createSync from '../production/business-sync.cjs';
const snapshot=()=>({products:[{id:1,name:'扣子',price:10}],materials:[{id:1,name:'PETG'}],records:{'2026-10-10':{off:false,items:[{_id:'r1',machine:11,productName:'扣子',qty:1,weight:10,material:'PETG'}]}},inventory:{PETG:{stockG:1000,minStockG:50}}});
const doc=()=>core.project(snapshot());
function resolve(result,side){return Object.fromEntries(result.conflicts.map(c=>[c.id,{signature:c.signature,side}]));}
test('all business collections round trip; credentials and cloud ownership never leave',()=>{
 const data=snapshot();data.settings={laborPerDay:100,password:'secret',printers:[{accessCode:'secret'}]};data.records['2026-10-10'].items[0].cloudJobId='job';
 for(const name of ['schedules','maintenance','miscExpenses','stockInLogs'])data[name]=[{id:2,name:'记录',amount:5}];
 const projected=core.project(data);assert.ok(!JSON.stringify(projected).includes('secret'));assert.ok(!JSON.stringify(projected).includes('job'));
 assert.deepEqual(core.project(core.apply(data,projected)),projected);assert.equal(core.apply(data,projected).records['2026-10-10'].items[0].cloudJobId,'job');
});
test('independent field edits merge, same-field conflicts require a current choice',()=>{
 const base=doc(),cloud=structuredClone(base),windows=structuredClone(base);cloud.records.r1.qty=2;windows.records.r1.productName='眼睛';
 let r=core.merge(base,cloud,windows);assert.equal(r.conflicts.length,0);assert.equal(r.data.records.r1.qty,2);assert.equal(r.data.records.r1.productName,'眼睛');
 windows.records.r1.qty=3;r=core.merge(base,cloud,windows);assert.equal(r.conflicts.length,1);
 const choices=resolve(r,'windows');assert.equal(core.merge(base,cloud,windows,choices).data.records.r1.qty,3);
 windows.records.r1.qty=4;assert.equal(core.merge(base,cloud,windows,choices).conflicts.length,1);
});
test('first reconciliation flags one-sided rows and stock, concurrent ID collisions never merge',()=>{
 const cloud=doc(),windows=doc();windows.products['2']={id:2,name:'新产品'};windows.inventory.PETG.stockG=900;
 const r=core.merge(null,cloud,windows);assert.equal(r.conflicts.length,2);assert.equal(core.merge(null,cloud,windows,resolve(r,'windows')).conflicts.length,0);
 const base=doc();cloud.products['2']={id:2,name:'云产品'};assert.equal(core.merge(base,cloud,windows).conflicts.length,1);
});
test('deletions, delete/edit conflicts, removed fields and source IDs survive roundtrip',()=>{
 const data=snapshot();data.records['2026-10-10'].items[0]._id='bridge-id';data.records['2026-10-10'].items[0].sourceRecordId='r1';
 const base=core.project(data),cloud=structuredClone(base),windows=structuredClone(base);delete cloud.products['1'];delete cloud.records.r1.weight;
 let r=core.merge(base,cloud,windows);assert.equal(r.conflicts.length,0);const applied=core.apply(data,r.data);assert.equal(applied.products.length,0);assert.equal(applied.records['2026-10-10'].items[0]._id,'bridge-id');assert.ok(!('weight' in applied.records['2026-10-10'].items[0]));
 windows.products['1'].name='修改';assert.equal(core.merge(base,cloud,windows).conflicts.length,1);
});
test('inventory copies balances once; simultaneous balances conflict; retry is idempotent',()=>{
 const base=doc(),cloud=doc(),windows=doc();windows.inventory.PETG.stockG=990;
 let r=core.merge(base,cloud,windows);assert.equal(r.data.inventory.PETG.stockG,990);
 assert.equal(core.merge(base,r.data,windows).conflicts.length,1,'equal balances can represent two independent debits and require review');
 cloud.inventory.PETG.stockG=980;assert.equal(core.merge(base,cloud,windows).conflicts.length,1);
});
test('cloud transaction persists conflicts without changing business data, resolves and retries safely',()=>{
 process.env.BUSINESS_SYNC_STATION='test';const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE snapshot(value TEXT)');db.prepare('INSERT INTO snapshot VALUES (?)').run(JSON.stringify(snapshot()));
 const load=()=>JSON.parse(db.prepare('SELECT value FROM snapshot').get().value),write=data=>db.prepare('UPDATE snapshot SET value=?').run(JSON.stringify(data));
 const sync=createSync(db,{load,write}),remote=doc();remote.inventory.PETG.stockG=800;
 assert.equal(sync({action:'exchange',clientId:'11111111-1111-1111-1111-111111111111',station:'test',remote}).ok,false);assert.equal(load().inventory.PETG.stockG,1000);
 const conflicts=sync({action:'status'}).conflicts;sync({action:'resolve',choices:conflicts.map(c=>({id:c.id,signature:c.signature,side:'windows'}))});
 assert.equal(sync({action:'exchange',clientId:'11111111-1111-1111-1111-111111111111',station:'test',remote}).ok,true);assert.equal(load().inventory.PETG.stockG,800);
 assert.equal(sync({action:'exchange',clientId:'11111111-1111-1111-1111-111111111111',station:'test',remote}).ok,true);assert.equal(load().inventory.PETG.stockG,800);
 assert.throws(()=>sync({action:'exchange',clientId:'11111111-1111-1111-1111-111111111111',station:'other',remote}));db.close();delete process.env.BUSINESS_SYNC_STATION;
});
test('transport rejects reserved metadata, credentials and prototype keys rather than storing stripped values',()=>{
 for(const key of ['token','_sourceFacts','__proto__']){const input=doc();Object.defineProperty(input.products['1'],key,{value:'do-not-store',enumerable:true});assert.throws(()=>core.apply({},input),/保留字段/);}
});
test('cloud rollback is atomic and a different bridge instance cannot take over',()=>{
 process.env.BUSINESS_SYNC_STATION='test';const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE snapshot(value TEXT)');db.prepare('INSERT INTO snapshot VALUES (?)').run(JSON.stringify(snapshot()));
 const load=()=>JSON.parse(db.prepare('SELECT value FROM snapshot').get().value);
 let failWrite=false;const sync=createSync(db,{load,write:data=>{db.prepare('UPDATE snapshot SET value=?').run(JSON.stringify(data));if(failWrite)throw Error('disk full');}});
 const input={action:'exchange',station:'test',clientId:'11111111-1111-1111-1111-111111111111',base:doc(),remote:doc()};sync(input);
 assert.throws(()=>sync({...input,clientId:'22222222-2222-2222-2222-222222222222'}),/其他桥接/);
 const backupsBefore=db.prepare('SELECT COUNT(*) n FROM business_sync_backups').get().n;
 input.remote.inventory.PETG.stockG=900;failWrite=true;assert.throws(()=>sync(input),/disk full/);assert.equal(load().inventory.PETG.stockG,1000);assert.equal(db.prepare('SELECT COUNT(*) n FROM business_sync_backups').get().n,backupsBefore);
 failWrite=false;assert.equal(sync(input).ok,true);assert.equal(sync(input).ok,true);assert.equal(load().inventory.PETG.stockG,900);db.close();delete process.env.BUSINESS_SYNC_STATION;
});
