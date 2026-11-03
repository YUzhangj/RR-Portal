'use strict';
// Actual route handlers and in-memory SQLite; never load db/index, an app
// initializer, a private config, a network listener, or a production fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const root = path.join(__dirname, '..');
const departments = ['sales', 'engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly'];

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'backend/db/schema.sql'), 'utf8'));
  db.prepare('INSERT INTO factories(code,name_cn) VALUES(?,?)').run('qingxi', 'SyntheticFactory');
  for (const [i, dept] of departments.entries()) {
    db.prepare('INSERT INTO departments(code,name_cn,sort_order,pin_staff,pin_supervisor) VALUES(?,?,?,?,?)')
      .run(dept, dept, i, 'synthetic-unused-hash', 'synthetic-unused-hash');
  }
  db.prepare(`INSERT INTO users(id,username,password_hash,display_name,dept,role)
    VALUES(1,'synthetic-1064','synthetic-unused-hash','SyntheticActor','molding','staff')`).run();
  db.prepare('INSERT INTO user_customers(user_id,customer) VALUES(1,?)').run('SyntheticCustomer');
  db.prepare(`INSERT INTO quotes(id,quote_no,product_name,customer,factory_code)
    VALUES(1,'SYNTHETIC-1064','SyntheticProduct','SyntheticCustomer','qingxi')`).run();
  db.prepare("INSERT INTO quote_customer_confirmations(quote_id,status) VALUES(1,'confirmed')").run();
  db.prepare("INSERT INTO quote_verifications(quote_id,baseline_json,status) VALUES(1,'{}','in_progress')").run();
  db.prepare(`INSERT INTO quote_verification_versions(id,quote_id,version_no,label,status)
    VALUES(1,1,1,'V1','in_review')`).run();
  for (const [i, dept] of departments.entries()) {
    const payload = { excel_native: { inputs: {} } };
    if (dept === 'sales') payload.legacy_import = { excel_model: { cells: { 'Synthetic!A1': { t: 'n', v: 1, owner: 'molding' } } } };
    db.prepare(`INSERT INTO quote_verification_sections(id,version_id,dept,payload_json,status,filled_at)
      VALUES(?,1,?,?,'filled','2026-11-03T00:00:00.000Z')`).run(i + 1, dept, JSON.stringify(payload));
  }
  const routes = {}, cache = new Map(); let afterRead;
  const adapter = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        all(...args) { const value = statement.all(...args); return afterRead?.(sql, value) ?? value; },
        get(...args) { const value = statement.get(...args); return afterRead?.(sql, value) ?? value; },
        run(...args) { return statement.run(...args); },
      };
    },
    transaction(fn) {
      return async (...args) => {
        db.exec('BEGIN');
        try { const value = await fn(...args); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      };
    },
  };
  const router = { use() {} };
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) router[method] = (url, fn) => { routes[method + ' ' + url] = fn; };
  function load(relative) {
    relative = path.posix.normalize(relative);
    if (relative === 'backend/db' || relative === 'backend/db/index.js') return adapter;
    if (cache.has(relative)) return cache.get(relative).exports;
    const module = { exports: {} }; cache.set(relative, module);
    const scopedRequire = name => {
      if (name === 'express') return { Router: () => router };
      if (name.startsWith('.')) {
        let next = path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
        if (next === 'backend/db') return adapter;
        if (!path.posix.extname(next)) next += '.js';
        return load(next);
      }
      return require(name);
    };
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    if (relative.endsWith('.json')) module.exports = JSON.parse(text);
    else vm.runInNewContext('(function(require,module,exports){' + text + '\n})',
      { console, Buffer, structuredClone, setImmediate, setTimeout, clearTimeout })(scopedRequire, module, module.exports);
    return module.exports;
  }
  load('backend/routes/verifications.js');
  const revision = load('backend/services/verificationSectionSave.js').sectionRevision;
  const user = { id: 1, name: 'SyntheticActor', username: 'synthetic-1064', dept: 'molding', role: 'staff',
    active_factory_code: 'qingxi', perms: { '报价单详情': { can_view: 1, can_edit: 0 },
      '啤机部': { can_view: 1, can_edit: 0, can_review: 0 } } };
  async function call(key, { body = {}, as = user, params = { versionId: '1', sectionId: '4', quoteId: '1' } } = {}) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    try { await routes[key]({ user: as, body, params }, response); }
    catch (error) { response.statusCode = error.status || 500; response.error = error.message; }
    return response;
  }
  return { db, user, call, load, revision, setAfterRead(fn) { afterRead = fn; } };
}
const reviewUser = x => ({ ...x.user, role: 'supervisor',
  perms: { ...x.user.perms, '啤机部': { can_view: 1, can_review: 1 } } });

test('PR1064 integration retains original-workbook edit permission and preserves rejected payload', async t => {
  const x = fixture(); t.after(() => x.db.close());
  const before = x.db.prepare('SELECT * FROM quote_verification_sections WHERE id=4').get();
  const payload = JSON.parse(before.payload_json); payload.excel_native.inputs['Synthetic!A1'] = { v: 2 };
  const response = await x.call('put /versions/:versionId/sections/:sectionId',
    { body: { payload, submit: true, base_revision: x.revision(before) } });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(x.db.prepare('SELECT * FROM quote_verification_sections WHERE id=4').get(), before);
});

test('PR1064 integration retains original-workbook review permission even for a supervisor', async t => {
  const x = fixture(); t.after(() => x.db.close());
  const before = x.db.prepare('SELECT * FROM quote_verification_sections WHERE id=4').get();
  const response = await x.call('post /versions/:versionId/sections/:sectionId/review',
    { as: { ...x.user, role: 'supervisor' }, body: { action: 'approve' } });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(x.db.prepare('SELECT * FROM quote_verification_sections WHERE id=4').get(), before);
});

test('PR1064 fixture permits an authorized native edit, persists its full payload, and audits approval', async t => {
  const x = fixture(); t.after(() => x.db.close());
  const before = x.db.prepare('SELECT * FROM quote_verification_sections WHERE id=4').get();
  const payload = JSON.parse(before.payload_json); payload.excel_native.inputs['Synthetic!A1'] = { v: 2 };
  const editor = { ...x.user, perms: { '报价单详情': { can_view: 1, can_edit: 1 },
    '啤机部': { can_view: 1, can_edit: 1, can_review: 1 } } };
  const saved = await x.call('put /versions/:versionId/sections/:sectionId',
    { as: editor, body: { payload, submit: true, base_revision: x.revision(before) } });
  assert.equal(saved.statusCode, 200, saved.error || JSON.stringify(saved.body));
  const actual = x.db.prepare('SELECT * FROM quote_verification_sections WHERE id=4').get();
  assert.equal(JSON.parse(actual.payload_json).excel_native.inputs['Synthetic!A1'].v, 2);
  assert.equal(actual.status, 'filled');
  const approved = await x.call('post /versions/:versionId/sections/:sectionId/review',
    { as: { ...editor, role: 'supervisor' }, body: { action: 'approve' } });
  assert.equal(approved.statusCode, 200);
  assert.equal(x.db.prepare('SELECT status FROM quote_verification_sections WHERE id=4').get().status, 'approved');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, 2);
});

test('PR1064 integration rejects approval when a different payload commits after initial load', async t => {
  const x = fixture(); t.after(() => x.db.close()); let changed = false;
  x.setAfterRead(sql => {
    if (!changed && sql.includes('v.status AS version_status')) {
      changed = true;
      x.db.prepare(`UPDATE quote_verification_sections SET payload_json=?,filled_at=? WHERE id=4`)
        .run(JSON.stringify({ excel_native: { inputs: { 'Synthetic!A1': { v: 77 } } } }), '2026-11-03T00:01:00.000Z');
    }
  });
  const response = await x.call('post /versions/:versionId/sections/:sectionId/review',
    { as: reviewUser(x), body: { action: 'approve' } });
  assert.equal(response.statusCode, 409);
  const saved = x.db.prepare('SELECT * FROM quote_verification_sections WHERE id=4').get();
  assert.equal(saved.status, 'filled');
  assert.equal(JSON.parse(saved.payload_json).excel_native.inputs['Synthetic!A1'].v, 77);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, 0);
});

test('PR1064 integration commits approval and its audit together or rolls both back', async t => {
  const x = fixture(); t.after(() => x.db.close());
  const before = x.db.prepare('SELECT * FROM quote_verification_sections WHERE id=4').get();
  x.db.exec(`CREATE TRIGGER synthetic_abort_audit BEFORE INSERT ON audit_log
    BEGIN SELECT RAISE(ABORT,'synthetic-audit-failure'); END;`);
  const response = await x.call('post /versions/:versionId/sections/:sectionId/review',
    { as: reviewUser(x), body: { action: 'approve' } });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(x.db.prepare('SELECT * FROM quote_verification_sections WHERE id=4').get(), before);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, 0);
});

test('PR1064 integration serializes complete and reject and cannot leave a completed rejected version', async t => {
  const x = fixture(); t.after(() => x.db.close());
  x.db.exec("UPDATE quote_verification_sections SET status='approved'");
  let pendingReject;
  x.setAfterRead((sql, value) => {
    if (sql.includes('COUNT(*) AS total') && sql.includes("status='approved'")) {
      x.setAfterRead(undefined);
      pendingReject = x.call('post /versions/:versionId/sections/:sectionId/review',
        { as: reviewUser(x), body: { action: 'reject' } });
      return new Promise(resolve => setImmediate(() => resolve(value)));
    }
  });
  const completed = await x.call('post /versions/:versionId/complete', { as: { ...x.user, role: 'admin' } });
  assert.equal(completed.statusCode, 200); assert.ok(pendingReject);
  assert.equal((await pendingReject).statusCode, 409);
  assert.equal(x.db.prepare('SELECT status FROM quote_verification_versions WHERE id=1').get().status, 'completed');
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM quote_verification_sections WHERE status<>'approved'").get().n, 0);
});

test('PR1064 integration cannot clone an allowed quotation into an unauthorized customer and self-grant access', async t => {
  const x = fixture(); t.after(() => x.db.close()); x.load('backend/routes/quotes.js');
  const before = x.db.prepare('SELECT * FROM user_customers ORDER BY customer').all();
  const response = await x.call('post /:id/clone', { as: { ...x.user, dept: 'sales' }, params: { id: '1' },
    body: { quote_no: 'SYNTHETIC-1064-UNAUTHORIZED', customer: 'UnauthorizedSyntheticCustomer' } });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(x.db.prepare('SELECT * FROM user_customers ORDER BY customer').all(), before);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM quotes').get().n, 1);
});
