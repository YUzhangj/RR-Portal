"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server/server.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, 'judgement-flow.test.js'), 'utf8');
const prefix = source.slice(0, source.indexOf('const defect ='));
const fixture = { require, __dirname, console };
vm.runInNewContext(prefix + ';this.make=browser;', fixture);
const plain = value => JSON.parse(JSON.stringify(value));
function browser() {
  const b = fixture.make();
  b.element('f_productName');
  b.messages = [];
  b.ctx.showToast = (message, type) => b.messages.push({message,type});
  b.ctx._backupLog = () => {};
  b.ctx._backupRefreshAll = () => {};
  return b;
}
function random(b, pairs) {
  let calls = 0;
  b.ctx.crypto = {getRandomValues(words) {
    const pair = pairs[Math.min(calls++, pairs.length - 1)];
    words[0] = pair[0]; words[1] = pair[1]; return words;
  }};
  return () => calls;
}
const row = (id, extra = {}) => ({id,date:'2026-11-05',supplier:'Test Supplier',productNo:'SKU-'+id,
  qty:12,updatedAt:'2026-11-05T01:00:00.000Z',status:'pending',...extra});
const setRecords = (b, rows) => b.run('state.records='+JSON.stringify(rows));
const records = b => plain(b.json('state.records'));

// Real save/SQLite round trips, no production source, AI or business database.
test('two independent entry clients allocate safe IDs and both complete records reach SQLite', () => {
  const first = browser(), second = browser(); random(first,[[0,701]]); random(second,[[0,702]]);
  first.elements.get('f_productName').value = 'First complete row';
  second.elements.get('f_productName').value = 'Second complete row';
  assert.equal(first.ctx.saveRecord(),true); assert.equal(second.ctx.saveRecord(),true);
  const a=records(first)[0],b=records(second)[0];
  for(const r of[a,b]) {assert.ok(Number.isSafeInteger(r.id));assert.ok(r.id>0);assert.equal(r.status,'pending');}
  assert.notEqual(a.id,b.id);
  const core=vm.runInNewContext(server.slice(server.indexOf('const RECORD_COLS'),server.indexOf('function replaceUsers'))+';({SCHEMA_SQL,upsertRecords,rowToRecord})');
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(core.SCHEMA_SQL);core.upsertRecords(db,[a]);core.upsertRecords(db,[b]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,2);
    assert.deepEqual(db.prepare('SELECT productName FROM records ORDER BY id').all().map(r=>r.productName),['First complete row','Second complete row']);
    const saved=core.rowToRecord(db.prepare('SELECT * FROM records WHERE id=?').get(a.id));
    assert.equal(saved.qty,a.qty);assert.deepEqual(plain(saved.defects),a.defects);assert.deepEqual(plain(saved.measurements),a.measurements);
  } finally {db.close();}
});

test('random boundary words remain safe for both a record and legacy nextId', () => {
  const b=browser();random(b,[[0xffffffff,0xffffffff]]);
  const id=b.ctx._newRecordId();assert.equal(id,4503599627370495);assert.ok(Number.isSafeInteger(id));assert.ok(Number.isSafeInteger(id+1));
});

test('zero and an existing ID are retried instead of creating or overwriting either', () => {
  const b=browser();setRecords(b,[row(91)]);const calls=random(b,[[0,0],[0,91],[0,92]]);
  assert.equal(b.ctx._newRecordId(),92);assert.equal(calls(),3);assert.deepEqual(records(b),[row(91)]);
});

test('bounded random exhaustion leaves real save and batch import completely unchanged', () => {
  const b=browser();setRecords(b,[row(91)]);random(b,[[0,91]]);
  assert.equal(b.ctx.saveRecord(),false);assert.deepEqual(records(b),[row(91)]);assert.equal(b.writes.length,0);
  b.run('_batchRows=[{productName:"batch one"},{productName:"batch two"}];renderRecordsTable=()=>{};');
  random(b,[[0,92],[0,92]]);b.ctx.confirmBatchImport();
  assert.deepEqual(records(b),[row(91)]);assert.equal(b.writes.length,0);assert.equal(b.json('_batchRows.length'),2);
});

test('a saved record keeps its actual identity when the same client edits it', () => {
  const b=browser();random(b,[[0,701]]);assert.equal(b.ctx.saveRecord(),true);
  b.run('editingId=state.records[0].id');b.elements.get('f_productName').value='Explicit edit';
  assert.equal(b.ctx.saveRecord(),true);assert.equal(records(b).length,1);assert.equal(records(b)[0].id,701);assert.equal(records(b)[0].productName,'Explicit edit');
});

test('append restores the full supported row once and a repeated restore is a no-op', () => {
  const b=browser();const r=row(801,{sampleQty:0,pass:0,fail:0,orderQty:0,result2:'HOLD',confirmBy:'Original confirmer',
    defects:[{desc:'full original defect',qty:0,level:'MAJ 0.65',category:'appearance',remark:'all remarks'}],
    measurements:[{item:'full measurement',measureType:'single',standard:0,tolDir:'-',tolerance:0,values:[0],avg:0,result:'PASS'}],
    aqlLevel:'MAJ 0.65',reviewBy:'',reviewAt:'',rejectReason:'',rejectBy:'',rejectAt:''});
  assert.equal(b.ctx._backupDoImport([r],'append'),true);assert.equal(records(b).length,1);
  const stored=records(b)[0];assert.equal(stored.id,801);assert.equal(stored.sampleQty,0);assert.equal(stored.orderQty,0);
  assert.equal(stored.result2,'HOLD');assert.equal(stored.confirmBy,'Original confirmer');assert.deepEqual(stored.defects,r.defects);assert.deepEqual(stored.measurements,r.measurements);
  const before=JSON.stringify(records(b));assert.equal(b.ctx._backupDoImport([r],'append'),true);
  assert.equal(JSON.stringify(records(b)),before);assert.equal(b.writes.length,1);
});

test('append ID conflict in a later row rejects the entire batch without losing earlier data or intent', () => {
  const b=browser();setRecords(b,[row(801)]);b.ctx.__QC_FORCE_REPLACE=7;
  const original=JSON.stringify(records(b));
  assert.equal(b.ctx._backupDoImport([row(802),row(801,{qty:99})],'append'),false);
  assert.equal(JSON.stringify(records(b)),original);assert.equal(b.writes.length,0);assert.equal(b.ctx.__QC_FORCE_REPLACE,7);
  assert.match(b.messages.at(-1).message,/801.*内容不同/);
});

test('nested measurement or review differences are conflicts, not silently discarded duplicates', () => {
  for(const extra of [{measurements:[{item:'changed',values:[0]}]},{status:'approved',reviewBy:'forged'},{updatedAt:'2026-11-05T01:00:01Z'}]) {
    const b=browser();setRecords(b,[row(801)]);assert.equal(b.ctx._backupDoImport([row(801,extra)],'append'),false);
    assert.deepEqual(records(b),[row(801)]);assert.equal(b.writes.length,0);
  }
});

test('duplicate incoming IDs with different full content reject both append and replacement atomically', () => {
  for(const mode of['append','replace']) {
    const b=browser();setRecords(b,[row(50)]);
    assert.equal(b.ctx._backupDoImport([row(801),row(801,{productName:'different'})],mode),false);
    assert.deepEqual(records(b),[row(50)]);assert.equal(b.ctx.__QC_FORCE_REPLACE,undefined);assert.equal(b.writes.length,0);
  }
});

test('explicit replacement retains source identity and full approval fields for server permission validation', () => {
  const b=browser();setRecords(b,[row(50)]);
  const r=row(50,{status:'approved',reviewBy:'Original reviewer',reviewAt:'2026-10-01T01:00:00Z',measurements:[{item:'retained',values:[0]}]});
  assert.equal(b.ctx._backupDoImport([r,r],'replace'),true);
  assert.equal(records(b).length,1);assert.equal(records(b)[0].id,50);assert.equal(records(b)[0].reviewBy,r.reviewBy);
  assert.equal(records(b)[0].reviewAt,r.reviewAt);assert.deepEqual(records(b)[0].measurements,r.measurements);
  assert.equal(b.ctx.__QC_FORCE_REPLACE,1);assert.equal(b.writes.length,1);
});

test('missing and invalid source IDs allocate distinct safe IDs without altering the source backup', () => {
  const b=browser();setRecords(b,[row(91)]);const source=[row(undefined),row('invalid'),row(92)];const before=JSON.stringify(source);
  random(b,[[0,91],[0,92],[0,93],[0,94]]);
  assert.equal(b.ctx._backupDoImport(source,'append'),true);assert.equal(JSON.stringify(source),before);
  assert.deepEqual(records(b).map(r=>r.id),[91,93,94,92]);
});

test('unsupported authority fields never enter normalized record payloads', () => {
  const b=browser();assert.equal(b.ctx._backupDoImport([row(800,{username:'admin',password:'synthetic-only',role:'admin',company:'other',csrfToken:'fake',perms:{review:{a:1}}})],'append'),true);
  for(const field of['username','password','role','company','csrfToken','perms']) assert.equal(field in records(b)[0],false);
});

test('invalid detail structures and oversized payloads retain all current data without a persist', () => {
  for(const bad of[{defects:'not an array'},{measurements:[{item:'x',values:[{}]}]},{remark:'汉'.repeat(17*1024*1024)}]) {
    const b=browser();setRecords(b,[row(91)]);assert.equal(b.ctx._backupDoImport([row(800,bad)],'append'),false);
    assert.deepEqual(records(b),[row(91)]);assert.equal(b.writes.length,0);assert.equal(b.ctx.__QC_FORCE_REPLACE,undefined);
  }
});


test('existing short-code presentation never replaces full record identity or action arguments', () => {
  const b=browser(),ids=[31,1000000000000,1000000000000+2176782336];
  setRecords(b,ids.map(id=>row(id,{status:'approved',result:'PASS'})));
  b.element('recordsTableWrap');b.run('_syncCheckAllState=()=>{};_updateBatchBtn=()=>{};applyColLock=()=>{};');
  b.ctx.filterRecords();const html=b.elements.get('recordsTableWrap').innerHTML;
  for(const id of ids) {assert.ok(html.includes('title="完整编号 '+id+'"'));assert.ok(html.includes('exportIQCReport('+id+')'));}
  assert.equal(b.ctx._shortId(31),'31');assert.equal(b.ctx._shortId(ids[1]),b.ctx._shortId(ids[2]));
  assert.deepEqual(records(b).map(r=>r.id),ids);
});


function importPlan(b) {
  b.run('_importMappedFields={date:"date",supplier:"supplier",productNo:"productNo",productName:"productName",qty:"qty"};'+
    '_importParsedRows=[{date:"2026-11-05",supplier:"Test Supplier",productNo:"SAME",productName:"Same complete goods",qty:"12"},'+
    '{date:"2026-11-05",supplier:"Test Supplier",productNo:"SAME",productName:"Same complete goods",qty:"12"}];'+
    '_importWarnings=[];_pendingImportPlan=_buildImportPlan("append");');
  return plain(b.json('_pendingImportPlan'));
}

test('two worksheet clients preview without writes then import distinct IDs without deduplicating equal goods', () => {
  const a=browser(),b=browser();random(a,[[0,821],[0,822]]);random(b,[[0,823],[0,824]]);
  const first=importPlan(a),second=importPlan(b);
  assert.equal(a.writes.length,0);assert.equal(b.writes.length,0);assert.deepEqual(records(a),[]);assert.deepEqual(records(b),[]);
  assert.equal(first.records.length,2);assert.equal(second.records.length,2);
  a.ctx.executeImportConfirm();b.ctx.executeImportConfirm();
  const rows=records(a).concat(records(b));assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.id)).size,4);
  for(const row of rows) {assert.ok(Number.isSafeInteger(row.id));assert.equal(row.status,'pending');assert.equal(row.qty,12);assert.equal(row.productName,'Same complete goods');}
  const Auth=require('./server/auth');
  const core=vm.runInNewContext(server.slice(server.indexOf('const RECORD_COLS'),server.indexOf('function replaceUsers'))+';({SCHEMA_SQL,mergeRecordChanges})',{Auth});
  const db=new DatabaseSync(':memory:');
  try {db.exec(core.SCHEMA_SQL);core.mergeRecordChanges(db,rows,[],rows.map(r=>r.id));assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,4);}
  finally {db.close();}
});

test('a worksheet preview ID occupied before confirmation rejects the whole plan without touching either record', () => {
  const b=browser();random(b,[[0,821],[0,822]]);const plan=importPlan(b);setRecords(b,[row(plan.records[1].id,{productName:'Saved after preview'})]);
  const before=JSON.stringify(records(b));b.ctx.executeImportConfirm();assert.equal(JSON.stringify(records(b)),before);assert.equal(b.writes.length,0);
  assert.equal(b.json('_pendingImportPlan.records.length'),2);assert.match(b.messages.at(-1).message,/编号已被占用/);
});

test('creation intent is rechecked under the real SQLite write transaction before any deletion', () => {
  const Auth=require('./server/auth');
  const core=vm.runInNewContext(server.slice(server.indexOf('const RECORD_COLS'),server.indexOf('function replaceUsers'))+';({SCHEMA_SQL,upsertRecords,mergeRecordChanges})',{Auth});
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(core.SCHEMA_SQL);core.upsertRecords(db,[row(50),row(900,{productName:'Other creator won'})]);
    assert.throws(()=>core.mergeRecordChanges(db,[row(900,{productName:'Collision must not overwrite'})],[50],[900]),error=>error instanceof Auth.AuthError&&error.status===409);
    assert.equal(db.prepare('SELECT productName FROM records WHERE id=900').get().productName,'Other creator won');
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,2);assert.equal(db.prepare('SELECT count(*) AS n FROM record_tombstones').get().n,0);
  } finally {db.close();}
});

test('backup supported fields cover exactly the real persisted record contract', () => {
  const b=browser();assert.equal(b.ctx._backupDoImport([row(801)],'append'),true);
  const columns=plain(vm.runInNewContext(server.slice(server.indexOf('const RECORD_COLS'),server.indexOf('const SCHEMA_SQL'))+';RECORD_COLS'));
  assert.deepEqual(Object.keys(records(b)[0]).sort(),columns.sort());
});


test('backup byte counts match actual UTF-8 for Chinese, surrogate pairs and JSON escaping at exact limits',()=>{
  const b=browser();
  for(const value of['ASCII','中文🙂','\ud800','\udc00',{remark:'汉🙂\n"',values:[0,null,'é','𠀋']}]) {
    const bytes=Buffer.byteLength(JSON.stringify(value),'utf8');
    assert.equal(b.ctx._backupJsonBytes(value),bytes);assert.equal(b.ctx._backupJsonBytes(value,bytes),bytes);
    assert.ok(b.ctx._backupJsonBytes(value,bytes-1)>bytes-1);
  }
});

test('both incoming and merged multibyte payloads fail before any state change at a controlled byte boundary',()=>{
  // Use the real whole handler with only its fixed 50MiB threshold scaled to
  // 8192 bytes in this isolated VM. The actual byte counter is unchanged.
  const limit=8192;
  function limited(b) {
    const fn=b.ctx._backupDoImport.toString(),needle='const maxBody = 50 * 1024 * 1024;';
    assert.equal(fn.split(needle).length,2);
    b.ctx._backupDoImport=vm.runInContext('('+fn.replace(needle,'const maxBody = 8192;')+')',b.ctx);
  }
  const b=browser();limited(b);setRecords(b,[row(50)]);
  const tooLarge=[row(801,{remark:'汉'.repeat(3000)})];
  assert.ok(JSON.stringify(tooLarge).length<limit);assert.ok(b.ctx._backupJsonBytes(tooLarge)>limit);
  assert.equal(b.ctx._backupDoImport(tooLarge,'append'),false);assert.deepEqual(records(b),[row(50)]);assert.equal(b.writes.length,0);
  assert.match(b.messages.at(-1).message,/备份超过/);
  const c=browser();limited(c);const original=row(50,{remark:'汉'.repeat(2000)}),addition=[row(801,{remark:'🙂'.repeat(1000)})];setRecords(c,[original]);
  assert.ok(c.ctx._backupJsonBytes(addition)<limit);assert.ok(c.ctx._backupJsonBytes({records:[original,...addition]})>limit);
  assert.equal(c.ctx._backupDoImport(addition,'append'),false);assert.deepEqual(records(c),[original]);assert.equal(c.writes.length,0);
  assert.equal(c.ctx.__QC_FORCE_REPLACE,undefined);assert.match(c.messages.at(-1).message,/合并后资料超过/);
});
