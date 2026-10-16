const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const { sectionRevision } = require('../backend/services/verificationSectionSave');

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

async function fixture(t) {
  require('express-async-errors');
  const transactionStore = new AsyncLocalStorage();
  const pgUrl = process.env.TEST_DATABASE_URL;
  let native, pool, schema, sqlRun, close;
  if (pgUrl) {
    const { Pool, types } = require('pg');
    types.setTypeParser(1184, value => value);
    schema = `verification_test_${process.pid}_${Math.random().toString(16).slice(2)}`;
    const admin = new Pool({connectionString:pgUrl});
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({connectionString:pgUrl, options:`-c search_path=${schema},public`});
    sqlRun = async (sql, params, method) => {
      let i = 0;
      const result = await (transactionStore.getStore() || pool).query(sql.replace(/\?/g, () => `$${++i}`).replace(/datetime\('now'\)/g, 'CURRENT_TIMESTAMP'), params);
      return method === 'all' ? result.rows : method === 'get' ? result.rows[0] : {changes:result.rowCount};
    };
    close = async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
  } else {
    native = new DatabaseSync(':memory:');
    sqlRun = async (sql, params, method) => native.prepare(sql)[method](...params);
    close = async () => native.close();
  }
  const timeType = pgUrl ? 'TIMESTAMPTZ' : 'TEXT';
  const ddl = `CREATE TABLE quote_verification_versions(id INTEGER PRIMARY KEY,quote_id INTEGER,status TEXT,label TEXT,note TEXT,completed_by TEXT,completed_at ${timeType},updated_at ${timeType});
    CREATE TABLE quote_verification_sections(id INTEGER PRIMARY KEY,version_id INTEGER,dept TEXT,payload_json TEXT,status TEXT,filled_at ${timeType},reviewed_at ${timeType},filled_by TEXT,reviewed_by TEXT,review_comment TEXT);
    CREATE TABLE quote_verifications(quote_id INTEGER,status TEXT,note TEXT,updated_by TEXT,updated_at ${timeType});
    CREATE TABLE audit_log(quote_id INTEGER,dept TEXT,actor TEXT,action TEXT,detail TEXT);
    INSERT INTO quote_verification_versions(id,quote_id,status,label) VALUES(1,1,'drafting','V1');
    INSERT INTO quote_verification_sections(id,version_id,dept,payload_json,status) VALUES(1,1,'assembly','{}','empty');
    INSERT INTO quote_verifications(quote_id,status) VALUES(1,'in_progress');`;
  if (pgUrl) await pool.query(ddl); else native.exec(ddl);
  let beforeQuery = async () => {}, afterQuery = async () => {}, sqliteTail = Promise.resolve();
  const db = {
    pool,
    prepare(sql) {
      return Object.fromEntries(['all','get','run'].map(method => [method, async (...params) => {
        await beforeQuery(sql, params, method);
        const result = await sqlRun(sql, params, method);
        await afterQuery(sql, params, method, result);
        return result;
      }]));
    },
    transaction(fn) { return async (...args) => {
      let client, releaseSqlite;
      if (pgUrl) client = await pool.connect();
      else { const previous = sqliteTail, gate = defer(); sqliteTail = gate.promise; await previous; releaseSqlite = gate.resolve; }
      try {
        if (pgUrl) await client.query('BEGIN'); else native.exec('BEGIN');
        const result = await transactionStore.run(client, () => fn(...args));
        if (pgUrl) await client.query('COMMIT'); else native.exec('COMMIT');
        return result;
      } catch (error) {
        if (pgUrl) await client.query('ROLLBACK'); else native.exec('ROLLBACK');
        throw error;
      } finally { if (client) client.release(); if (releaseSqlite) releaseSqlite(); }
    }; },
  };
  const filename = path.join(__dirname, '../backend/routes/verifications.js');
  const realRequire = createRequire(filename), module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'), {module,require:id => id === '../db' ? db :
    id === '../middleware/auth' ? {requireAuth(req,_res,next){req.user={name:'Fixture user',dept:req.headers['x-dept']||'assembly',role:req.headers['x-role']||'staff'};next();},quoteAccess:async()=>({status:200})} : realRequire(id)});
  const express = require('express'), app = express();
  app.use(express.json());
  app.use('/api/verifications',module.exports);
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  const server = await new Promise(resolve => { const running=app.listen(0,'127.0.0.1',()=>resolve(running)); });
  t.after(async()=>{ await new Promise(resolve=>server.close(resolve)); await close(); });
  const api = async (suffix, body, headers={}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/verifications/versions/1${suffix}`, {method:suffix === '/sections/1'?'PUT':'POST', headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body||{})});
    return {status:response.status,body:await response.json()};
  };
  const read = () => db.prepare('SELECT * FROM quote_verification_sections WHERE id=1').get();
  return {db,api,read,pg:!!pgUrl,setBefore(fn){beforeQuery=fn;},setAfter(fn){afterQuery=fn;}};
}

test('verification HTTP rejects missing or stale revisions, preserves owner and returns the saved revision', async t => {
  const f = await fixture(t), initial = await f.read();
  assert.equal((await f.api('/sections/1',{payload:{price:1}})).status,409);
  const body = {payload:{price:12},submit:true,base_revision:sectionRevision(initial)};
  const results = await Promise.all([f.api('/sections/1',body),f.api('/sections/1',{...body,payload:{price:99}})]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  const saved = await f.read(), winner = results.find(result=>result.status===200);
  assert.equal(saved.filled_by,'Fixture user');
  assert.equal(saved.status,'filled');
  assert.equal(winner.body.revision,sectionRevision(saved));
  assert.equal(winner.body.section_status,'filled');
  assert.equal((await f.db.prepare('SELECT count(*) n FROM audit_log').get()).n, f.pg?'1':1);
});

test('verification HTTP keeps department and locked version authorization', async t => {
  const f=await fixture(t), body={payload:{price:1},base_revision:sectionRevision(await f.read())};
  assert.equal((await f.api('/sections/1',body,{'x-dept':'painting'})).status,403);
  assert.equal((await f.api('/sections/1/review',{action:'approve'})).status,403);
  for(const status of ['completed','cancelled']) {
    await f.db.prepare('UPDATE quote_verification_versions SET status=? WHERE id=1').run(status);
    assert.equal((await f.api('/sections/1',body)).status,409);
    assert.equal((await f.api('/sections/1/reopen',{}, {'x-role':'supervisor'})).status,409);
    assert.equal((await f.api('/complete',{}, {'x-dept':'sales','x-role':'admin'})).status,status==='completed'?200:409);
  }
});

test('a failed submit rolls back the section, version, case and audit together', async t => {
  const f=await fixture(t), initial=await f.read();
  const initialCase=await f.db.prepare('SELECT * FROM quote_verifications WHERE quote_id=1').get();
  f.setBefore(async sql=>{if(sql.includes("'verification_submit'")) throw Error('fixture audit failure');});
  const response=await f.api('/sections/1',{payload:{price:25},submit:true,base_revision:sectionRevision(initial)});
  assert.equal(response.status,500);
  assert.deepEqual(await f.read(),initial);
  assert.deepEqual(await f.db.prepare('SELECT * FROM quote_verifications WHERE quote_id=1').get(),initialCase);
  assert.equal((await f.db.prepare('SELECT status FROM quote_verification_versions WHERE id=1').get()).status,'drafting');
  assert.equal((await f.db.prepare('SELECT count(*) n FROM audit_log').get()).n,f.pg?'0':0);
});

test('a section changed while approval is waiting cannot be approved using the old loaded state', async t => {
  const f=await fixture(t);
  await f.db.prepare("UPDATE quote_verification_sections SET status='filled' WHERE id=1").run();
  const revision=sectionRevision(await f.read()), reached=defer(), release=defer();
  let first=true;
  f.setAfter(async(sql)=>{if(first && sql.includes('SELECT s.*, v.quote_id')){first=false;reached.resolve();await release.promise;}});
  const review=f.api('/sections/1/review',{action:'approve'}, {'x-role':'supervisor'});
  await reached.promise;
  const save=await f.api('/sections/1',{payload:{price:30},base_revision:revision});
  release.resolve();
  assert.equal(save.status,200);
  assert.equal((await review).status,409);
  assert.equal((await f.read()).status,'filled');
  assert.equal((await f.db.prepare('SELECT count(*) n FROM audit_log').get()).n,f.pg?'0':0);
});

test('same-tick review and reopen cycles always invalidate an older editor revision', async t => {
  const f=await fixture(t);
  await f.db.prepare("UPDATE quote_verification_sections SET status='filled' WHERE id=1").run();
  const manager={'x-role':'supervisor'};
  assert.equal((await f.api('/sections/1/review',{action:'approve'},manager)).status,200);
  assert.equal((await f.api('/sections/1/reopen',{},manager)).status,200);
  const first = await f.read();
  assert.equal((await f.api('/sections/1/review',{action:'approve'},manager)).status,200);
  assert.equal((await f.api('/sections/1/reopen',{},manager)).status,200);
  assert.notEqual(sectionRevision(await f.read()),sectionRevision(first));
  assert.equal((await f.api('/sections/1',{payload:{stale:true},base_revision:sectionRevision(first)})).status,409);
});

test('reopening an approved section and completing its version serialize without producing a locked editable section', async t => {
  const f=await fixture(t);
  await f.db.prepare("UPDATE quote_verification_sections SET status='approved' WHERE id=1").run();
  await f.db.prepare("UPDATE quote_verification_versions SET status='ready' WHERE id=1").run();
  const reached=defer(), release=defer(), completeReached=defer();
  let paused=false;
  f.setBefore(async(sql)=>{
    if(sql.includes("SET status='filled', review_comment=")&&!paused){paused=true;reached.resolve();await release.promise;}
    if(paused && /SELECT \* FROM quote_verification_versions WHERE id=\?/.test(sql)) completeReached.resolve();
  });
  const reopen=f.api('/sections/1/reopen',{}, {'x-role':'supervisor'});
  await reached.promise;
  const complete=f.api('/complete',{}, {'x-dept':'sales','x-role':'admin'});
  await completeReached.promise;
  // Give an unguarded complete a chance to finish while reopen is paused.
  await Promise.race([complete,new Promise(resolve=>setTimeout(resolve,50))]);
  release.resolve();
  const results=await Promise.all([reopen,complete]);
  assert.equal(results[0].status,200);
  assert.equal(results[1].status,409);
  const version=await f.db.prepare('SELECT status FROM quote_verification_versions WHERE id=1').get();
  assert.equal(version.status,'in_review');
  assert.equal((await f.read()).status,'filled');
});

test('completion that takes the version first prevents a waiting reopen and is idempotent', async t => {
  const f=await fixture(t);
  await f.db.prepare("UPDATE quote_verification_sections SET status='approved' WHERE id=1").run();
  await f.db.prepare("UPDATE quote_verification_versions SET status='ready' WHERE id=1").run();
  const reached=defer(), release=defer(), reopenReached=defer();
  let paused=false;
  f.setBefore(async sql=>{
    if(sql.includes("SET status='completed', note=")&&!paused){paused=true;reached.resolve();await release.promise;}
    if(paused && sql.includes('SELECT s.*, v.quote_id')) reopenReached.resolve();
  });
  const manager={'x-dept':'sales','x-role':'admin'};
  const complete=f.api('/complete',{}, manager);
  await reached.promise;
  const reopen=f.api('/sections/1/reopen',{}, {'x-role':'supervisor'});
  await reopenReached.promise;
  release.resolve();
  assert.equal((await complete).status,200);
  assert.equal((await reopen).status,409);
  assert.equal((await f.read()).status,'approved');
  assert.equal((await f.db.prepare('SELECT status FROM quote_verifications WHERE quote_id=1').get()).status,'completed');
  assert.equal((await f.api('/complete',{},manager)).status,200);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM audit_log').get()).n,f.pg?'1':1);
});

test('verification revision retains PostgreSQL microseconds during round trip', {skip:!process.env.TEST_DATABASE_URL}, async t => {
  const f=await fixture(t);
  await f.db.prepare("UPDATE quote_verification_sections SET filled_at='2026-10-16T00:00:00.123456Z' WHERE id=1").run();
  const initial=await f.read();
  assert.match(initial.filled_at,/\.123456/);
  const response=await f.api('/sections/1',{payload:{precise:true},base_revision:sectionRevision(initial)});
  assert.equal(response.status,200);
  assert.equal(response.body.revision,sectionRevision(await f.read()));
});
