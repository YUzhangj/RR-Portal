'use strict';
// Actual summary route with real synthetic SQLite. XLSX serialization is held
// at a deterministic boundary; no app startup, HTTP listener or private config.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const filename = path.join(__dirname, '../backend/routes/verificationSummary.js');
const realRequire = createRequire(filename);
function fixture({ interleave = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE user_customers(user_id INTEGER, customer TEXT);
    INSERT INTO user_customers VALUES(1,'SYN-A'),(2,'SYN-B');
    CREATE TABLE quotes(id INTEGER, customer TEXT, quote_no TEXT, product_name TEXT, factory_code TEXT, deleted_at TEXT);
    INSERT INTO quotes VALUES(1,'SYN-A','SYN-Q1','Synthetic A','qingxi',NULL),
      (2,'SYN-B','SYN-Q2','Synthetic B','qingxi',NULL),(3,'SYN-A','SYN-Q3','Synthetic Other Factory','heyuan',NULL);
    CREATE TABLE quote_verification_versions(id INTEGER,quote_id INTEGER,version_no INTEGER,status TEXT,label TEXT);
    INSERT INTO quote_verification_versions VALUES(1,1,1,'drafting','V1'),(2,2,1,'drafting','V1'),(3,3,1,'drafting','V1');
    CREATE TABLE quote_verification_sections(version_id INTEGER,dept TEXT,payload_json TEXT);
    INSERT INTO quote_verification_sections VALUES(1,'sales','{}'),(2,'sales','{}'),(3,'sales','{}');`);
  let firstScope = true, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const handlers = new Map(), builds = [], queries = [];
  const adapter = { prepare(sql) { const statement = sqlite.prepare(sql); return {
    all(...args) {
      queries.push({ sql, args });
      const result = statement.all(...args);
      if (interleave && firstScope && sql.startsWith('SELECT customer FROM user_customers')) {
        firstScope = false;
        sqlite.exec("UPDATE user_customers SET customer='SYN-B' WHERE user_id=1");
      }
      return result;
    },
  }; } };
  const router = { use() {}, put() {}, get(url, fn) { handlers.set(url, fn); } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: { exports: {} }, Buffer, Date, Promise, Map, JSON, Object, setImmediate,
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (name === '../db') return adapter;
      if (name === '../middleware/auth') return { requireAuth() {} };
      if (name === '../services/sourceSummary') return { sourceQuantity: () => null };
      if (name === '../../frontend/verification-customers') return { display: value => value };
      if (name === '../services/verificationSummary') return {
        columns: [], customerTotals: () => [],
        buildVerificationRow: quote => ({ id: quote.id, customer: quote.customer, factory: quote.factory_code }),
        buildVerificationWorkbook(rows) {
          builds.push(JSON.parse(JSON.stringify(rows)));
          return { xlsx: { async writeBuffer() { entered(); await gate; return Buffer.from(JSON.stringify(rows)); } } };
        },
      };
      return realRequire(name);
    },
  });
  const user = { id: 1, role: 'staff', active_factory_code: 'qingxi', perms: {} };
  async function run(as = user, query = {}) {
    const response = { setHeader() {}, send(value) { this.body = value; }, status() { return this; }, json(value) { this.body = value; } };
    await handlers.get('/export')({ user: as, query }, response);
    return JSON.parse(response.body.toString());
  }
  return { sqlite, user, run, started, release, builds, queries };
}

test('PR1064 export cache and data share one scope when customer grants interleave A to B to A', async t => {
  const x = fixture({ interleave: true }); t.after(() => x.sqlite.close());
  const first = x.run(x.user, { export_id: 'synthetic-scope-first' }); await x.started;
  x.sqlite.exec("UPDATE user_customers SET customer='SYN-A' WHERE user_id=1");
  const second = x.run(x.user, { export_id: 'synthetic-scope-second' });
  await new Promise(resolve => setImmediate(resolve)); x.release();
  const results = await Promise.all([first, second]);
  assert.equal(x.builds.length, 1, 'identical captured scopes may share one pending export');
  for (const rows of results) assert.deepEqual(rows.map(row => row.customer), ['SYN-A']);
  assert.equal(x.sqlite.prepare('SELECT customer FROM user_customers WHERE user_id=1').get().customer, 'SYN-A');
});

test('PR1064 pending exports never coalesce across another user or factory', async t => {
  const x = fixture(); t.after(() => x.sqlite.close());
  const first = x.run(); await x.started;
  const otherUser = x.run({ ...x.user, id: 2 });
  const otherFactory = x.run({ ...x.user, active_factory_code: 'heyuan' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(x.builds.length, 3); x.release();
  const [a, b, c] = await Promise.all([first, otherUser, otherFactory]);
  assert.deepEqual(a.map(row => row.id), [1]); assert.deepEqual(b.map(row => row.id), [2]); assert.deepEqual(c.map(row => row.id), [3]);
});

test('PR1064 request scope injection cannot grant customers and both existing admin policies retain full scope', async t => {
  const x = fixture(); t.after(() => x.sqlite.close()); x.release();
  const none = await x.run({ ...x.user, id: 3 }, { admin: 'true', customers: ['SYN-A', 'SYN-B'],
    readScope: { admin: true, customers: ['SYN-A', 'SYN-B'] } });
  assert.deepEqual(none, []);
  assert.deepEqual((await x.run({ ...x.user, role: 'admin' })).map(row => row.id), [1, 2]);
  assert.deepEqual((await x.run({ ...x.user, perms: { '账号管理': { can_admin: 1 } } })).map(row => row.id), [1, 2]);
});
