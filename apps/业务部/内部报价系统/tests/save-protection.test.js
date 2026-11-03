const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { sectionRevision, assertSectionRevision, saveVerificationSection } = require('../backend/services/verificationSectionSave');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE quote_verification_versions(id INTEGER PRIMARY KEY,quote_id INTEGER,status TEXT,label TEXT,updated_at TEXT);
    CREATE TABLE quote_verification_sections(id INTEGER PRIMARY KEY,version_id INTEGER,dept TEXT,payload_json TEXT,status TEXT,filled_at TEXT,reviewed_at TEXT,filled_by TEXT);
    CREATE TABLE quote_verifications(quote_id INTEGER,status TEXT,updated_by TEXT,updated_at TEXT);
    CREATE TABLE audit_log(quote_id INTEGER,dept TEXT,actor TEXT,action TEXT,detail TEXT);
    INSERT INTO quote_verification_versions VALUES(1,1,'drafting','V1',NULL);
    INSERT INTO quote_verification_sections VALUES(1,1,'sales','{}','empty',NULL,NULL,NULL);
    INSERT INTO quote_verifications VALUES(1,'in_progress',NULL,NULL);`);
  const adapter = { prepare: sql => db.prepare(sql), transaction: fn => async () => {
    db.exec('BEGIN'); try { const result = await fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } };
  const read = () => db.prepare('SELECT * FROM quote_verification_sections WHERE id=1').get();
  return { db, adapter, read };
}

test('two editors cannot overwrite the same verification section, even within one timestamp tick', async () => {
  const f = fixture();
  try {
    const first = f.read(), second = f.read(), token = sectionRevision(first);
    assertSectionRevision(first, token);
    await saveVerificationSection(f.adapter, first, {price: 12}, false, 'A');
    assert.throws(() => assertSectionRevision(f.read(), token), e => e.status === 409);
    await assert.rejects(saveVerificationSection(f.adapter, second, {price: 99}, false, 'B'), e => e.status === 409);
    assert.equal(JSON.parse(f.read().payload_json).price, 12);
    const updated = f.read();
    await saveVerificationSection(f.adapter, updated, {price: 13}, false, 'A');
    assert.notEqual(updated.filled_at, f.read().filled_at);
    assert.notEqual(sectionRevision(updated), sectionRevision(f.read()));
  } finally { f.db.close(); }
});

test('review, source replacement and version lock between read and write reject stale saves', async () => {
  for (const mutation of [
    "UPDATE quote_verification_sections SET status='approved' WHERE id=1",
    "UPDATE quote_verification_sections SET payload_json='{\"basis\":1}' WHERE id=1",
    "UPDATE quote_verification_sections SET reviewed_at='2026-10-15' WHERE id=1",
    "UPDATE quote_verification_versions SET status='completed' WHERE id=1",
  ]) {
    const f = fixture();
    try { const source=f.read(); f.db.exec(mutation);
      await assert.rejects(saveVerificationSection(f.adapter, source, {price:99}, true, 'B'), e=>e.status===409);
      assert.notEqual(f.read().payload_json, '{"price":99}');
    } finally { f.db.close(); }
  }
});

function routeFixture(f) {
  const filename = path.join(__dirname, '../backend/routes/verifications.js');
  const realRequire = createRequire(filename), routes = {};
  const router = {use(){},get(){},delete(){},post(){},patch(){},put(url,fn){routes[url]=fn;}};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module:{exports:{}},require:id =>
    id==='express'?{Router:()=>router}:id==='../db'?f.adapter:
    id==='../middleware/auth'?{requireAuth(){},quoteAccess:async()=>({status:200})}:realRequire(id)});
  return async (url, body) => {
    const res = {statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
    await routes[url]({params:{versionId:'1',sectionId:'1'},body,user:{name:'A',dept:'sales',role:'admin'}},res);
    return res;
  };
}

test('verification endpoint rejects missing and stale revisions and accepts a fresh editor', async () => {
  const f=fixture();
  try {
    const call=routeFixture(f),url='/versions/:versionId/sections/:sectionId';
    const revision=sectionRevision(f.read());
    assert.equal((await call(url,{payload:{price:1}})).statusCode,409);
    assert.equal((await call(url,{payload:{price:12},base_revision:revision})).statusCode,200);
    assert.equal((await call(url,{payload:{price:99},base_revision:revision,submit:true})).statusCode,409);
    assert.equal(JSON.parse(f.read().payload_json).price,12);
    assert.equal((await call(url,{payload:{price:13},base_revision:sectionRevision(f.read()),submit:true})).statusCode,200);
    assert.equal(f.read().status,'filled');
    assert.equal(f.db.prepare('SELECT count(*) n FROM audit_log').get().n,1);
  } finally { f.db.close(); }
});

function summaryFixture(api) {
  const elements=new Map(), handlers={}, alerts=[];
  const element = id => {
    if(!elements.has(id)) elements.set(id,{value:'',innerHTML:'',hidden:false,style:{},
      addEventListener(){},closest(){return {style:{}};},querySelectorAll(){return [];}});
    return elements.get(id);
  };
  const context={document:{getElementById:element,querySelectorAll:()=>[]},window:{addEventListener:(event,fn)=>handlers[event]=fn},Map,Set,alert:msg=>alerts.push(msg),setTimeout,console};
  const source=fs.readFileSync(path.join(__dirname,'../frontend/summary.js'),'utf8');
  vm.runInNewContext(source.slice(0,source.indexOf("$('summary-customer').onchange = render;"))+ '\napi = testApi; this.app={state,saveRow,trackSummaryDraft,rowHtml,render};',Object.assign(context,{testApi:api}));
  return {app:context.app,element,handlers,alerts};
}
function row(id,values) {
  const fields=Object.fromEntries(Object.entries({workshop:'.summary-workshop',confirmed_price:'.summary-price',confirmed_qty:'.summary-qty',note:'.summary-note'}).map(([key,selector])=>[selector,{value:values[key]}]));
  fields['.save-summary']={};
  const tr={dataset:{id:String(id)},querySelector:selector=>fields[selector]||null};
  return {tr,fields,event:{target:{closest:()=>tr,matches:()=>true}}};
}
const report={rows:[{id:1,customer:'A',qty:1,quoted_price:10,confirmation:{status:'pending',workshops:[]}},{id:2,customer:'B',qty:2,quoted_price:20,confirmation:{status:'pending',workshops:[]}}],summary_columns:[],workshops:[{code:'a',name:'车间A'}],can_edit:true};

test('saving one summary row and filtering keep the other row inputs including blanks and zero', async () => {
  const f=summaryFixture(async()=>report); Object.assign(f.app.state,{rows:report.rows,canEdit:true});
  const a=row(1,{workshop:'a',confirmed_price:'10',confirmed_qty:'1',note:'已保存'});
  const b=row(2,{workshop:'a',confirmed_price:'0',confirmed_qty:'',note:'未保存<&>'});
  f.app.trackSummaryDraft(a.event); f.app.trackSummaryDraft(b.event);
  await f.app.saveRow(a.tr);
  assert.equal(f.app.state.drafts.has('1'),false);
  assert.equal(f.app.state.drafts.get('2').note,'未保存<&>');
  f.element('summary-customer').value='A'; f.app.render();
  f.element('summary-customer').value=''; f.app.render();
  const html=f.element('summary-body').innerHTML;
  assert.match(html,/value="未保存&lt;&amp;&gt;"/);assert.match(html,/value="0"/);assert.match(html,/class="summary-qty"[^>]*value=""/);
  const event={preventDefault(){this.prevented=true;}};f.handlers.beforeunload(event);assert.equal(event.prevented,true);
});

test('summary keeps edits during pending saves and keeps drafts after rejected saves', async () => {
  let release; const gate=new Promise(resolve=>release=resolve);
  const f=summaryFixture(async(_path,options)=>{if(options){await gate;return {ok:true};}return report;});
  Object.assign(f.app.state,{rows:report.rows,canEdit:true});
  const a=row(1,{workshop:'',confirmed_price:'10',confirmed_qty:'1',note:'first'});
  f.app.trackSummaryDraft(a.event); const pending=f.app.saveRow(a.tr);
  a.fields['.summary-note'].value='second';f.app.trackSummaryDraft(a.event);release();await pending;
  assert.equal(f.app.state.drafts.get('1').note,'second');assert.match(f.element('summary-body').innerHTML,/value="second"/);
  const failed=summaryFixture(async()=>{throw Error('保存冲突');});
  await failed.app.saveRow(a.tr);assert.equal(failed.app.state.drafts.get('1').note,'second');assert.equal(failed.alerts[0],'保存冲突');
});
