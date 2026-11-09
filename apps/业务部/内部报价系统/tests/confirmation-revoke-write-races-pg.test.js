const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const pgUrl = process.env.TEST_DATABASE_URL;

// Real HTTP writers and database locks, not timing-only Promise.all races. Each
// barrier is installed solely in this test's unique disposable PostgreSQL schema.
test('confirmation revocation serializes with costing writes and keeps complete recovery evidence', { skip: !pgUrl, timeout: 90000 }, async t => {
  const { Pool, types } = require('pg');
  types.setTypeParser(1184, value => value);
  const schema = `revoke_writes_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const admin = new Pool({ connectionString: pgUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema},public` });
  const gate = await db.connect();
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', DB_DRIVER: 'postgres', DB_FILE: '', DATABASE_URL: pgUrl,
      DB_SCHEMA: schema, PGAPPNAME: schema, PORT: String(port), HOST: '127.0.0.1',
      SESSION_SECRET: 'revoke-race-fixture-only', COOKIE_SECURE: '0', ADMIN_INITIAL_PASSWORD: 'revoke-race-fixture-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    await gate.query('SELECT pg_advisory_unlock_all()');
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    gate.release();
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('isolated server startup timeout')), 15000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`isolated server exited ${code}`)); });
  });
  let cookie = '';
  async function api(url, method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await api('/auth/login', 'POST', { username: 'admin', password: 'revoke-race-fixture-only' })).status, 200);
  const rows = async (sql, values = []) => (await db.query(sql, values)).rows;
  const one = async (sql, values = []) => (await rows(sql, values))[0];
  const normalized = value => JSON.parse(JSON.stringify(value));
  const revision = async id => Number((await one("SELECT MAX(id) revision FROM audit_log WHERE quote_id=$1 AND action IN ('customer_confirmation','customer_confirmation_revoke')", [id])).revision || 0);
  let fixtureNumber = 0;
  async function fixture() {
    const created = await api('/quotes', 'POST', { quote_no: `PR1087-RACE-${++fixtureNumber}`, customer: 'TEST', product_name: 'synthetic original', qty: 100 });
    assert.equal(created.status, 200);
    const id = created.body.id;
    assert.equal((await api(`/quote-summary/${id}/confirmation`, 'PUT', { status: 'confirmed', confirmed_price: 12, confirmed_qty: 20 })).status, 200);
    const viewed = await api(`/verifications/${id}`);
    assert.equal(viewed.status, 200);
    return { id, version: viewed.body.selected_version, sales: viewed.body.sections.find(section => section.dept === 'sales'), revision: await revision(id) };
  }
  const revoke = f => api(`/quote-summary/${f.id}/revoke-confirmation`, 'POST', { base_confirmation_revision: f.revision, reason: 'PR1087 isolated correction' });
  async function snapshot(id) {
    const result = {};
    for (const table of ['quotes', 'quote_sections', 'quote_customer_confirmations', 'quote_verifications', 'quote_verification_versions', 'audit_log']) {
      const key = table === 'quotes' ? 'id' : 'quote_id';
      const order = ['quote_customer_confirmations', 'quote_verifications'].includes(table) ? 'quote_id' : 'id';
      result[table] = await rows(`SELECT * FROM ${table} WHERE ${key}=$1 ORDER BY ${order}`, [id]);
    }
    result.quote_verification_sections = await rows('SELECT s.* FROM quote_verification_sections s JOIN quote_verification_versions v ON v.id=s.version_id WHERE v.quote_id=$1 ORDER BY s.id', [id]);
    return normalized(result);
  }
  const payloadRevision = section => createHash('sha256').update(section.payload_json || '{}').digest('hex');
  const writers = [
    { name: 'department save', table: 'quote_verification_sections', action: null,
      run: f => api(`/verifications/versions/${f.version.id}/sections/${f.sales.id}`, 'PUT', { payload: { note: 'PR1087 acknowledged draft' }, base_revision: f.sales.revision, submit: false }),
      check: async f => { const row = await one('SELECT * FROM quote_verification_sections WHERE id=$1', [f.sales.id]); assert.equal(JSON.parse(row.payload_json).note, 'PR1087 acknowledged draft'); assert.ok(row.filled_by); assert.ok(row.filled_at); } },
    { name: 'order quantity', table: 'quote_verification_sections', action: 'verification_order_quantity',
      run: f => api('/verification-summary/quantity', 'PUT', { version_id: f.version.id, quantity: 237, expected_revision: payloadRevision(f.sales) }),
      check: async f => assert.equal(JSON.parse((await one('SELECT payload_json FROM quote_verification_sections WHERE id=$1', [f.sales.id])).payload_json).summary_order_quantity.value, 237) },
    { name: 'workshop assignment', table: 'quote_verification_sections', action: 'verification_workshop_assign',
      run: f => api('/verifications/workshops', 'PUT', { version_ids: [f.version.id], workshop: '兴信B', expected_revisions: { [f.version.id]: payloadRevision(f.sales) } }),
      check: async f => assert.equal(JSON.parse((await one('SELECT payload_json FROM quote_verification_sections WHERE id=$1', [f.sales.id])).payload_json).workshop_assignment.name, '兴信B') },
    { name: 'version category', table: 'quote_verification_versions', action: 'verification_version_category',
      run: f => api(`/verifications/versions/${f.version.id}`, 'PATCH', { category: 'PR1087 verified category' }),
      check: async f => assert.equal((await one('SELECT category FROM quote_verification_versions WHERE id=$1', [f.version.id])).category, 'PR1087 verified category') },
  ];
  let barrierNumber = 0;
  async function barrier(table, condition) {
    const key = 1087000 + ++barrierNumber;
    await db.query(`CREATE FUNCTION test_writer_barrier() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END$$`);
    await db.query(`CREATE TRIGGER test_writer_barrier BEFORE ${table === 'audit_log' ? 'INSERT' : 'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_writer_barrier()`);
    await gate.query('SELECT pg_advisory_lock($1)', [key]);
    return {
      async entered() { await until(async () => Boolean((await one("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted", [key])))); },
      async release() { await gate.query('SELECT pg_advisory_unlock($1)', [key]); },
      async remove() { await db.query(`DROP TRIGGER test_writer_barrier ON ${table}`); await db.query('DROP FUNCTION test_writer_barrier()'); },
    };
  }
  async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, 'controlled concurrent request reached neither its lock nor a response');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async function observeCompetingRequest(promise) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await until(async () => settled || Boolean(await one("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock' AND wait_event<>'advisory'", [schema])));
  }
  for (const writer of writers) {
    await t.test(`${writer.name}: revoke wins before writer, without acknowledging a deleted write`, async () => {
      const f = await fixture(), before = await snapshot(f.id);
      const pause = await barrier('audit_log', "NEW.action='customer_confirmation_revoke'");
      let undo, write;
      try {
        undo = revoke(f); await pause.entered();
        write = writer.run(f); await observeCompetingRequest(write);
      } finally { await pause.release(); }
      const [undone, written] = await Promise.all([undo, write]);
      await pause.remove();
      const after = await snapshot(f.id);
      t.diagnostic(JSON.stringify({ writer: writer.name, order: 'revoke-first', revokeStatus: undone.status, writeStatus: written.status, survivingVersions: after.quote_verification_versions.length }));
      assert.equal(undone.status, 200, JSON.stringify(undone.body));
      assert.ok([404, 409].includes(written.status), `must not acknowledge a write to the revoked V1: ${JSON.stringify(written)}`);
      assert.equal(after.quote_verification_versions.length, 0);
      assert.equal(after.quote_verification_sections.length, 0);
      assert.equal(after.quote_customer_confirmations[0].status, 'pending');
      assert.deepEqual(after.quotes, before.quotes); assert.deepEqual(after.quote_sections, before.quote_sections);
      const detail = JSON.parse(after.audit_log.find(row => row.action === 'customer_confirmation_revoke').detail);
      assert.deepEqual(detail.unused_versions, before.quote_verification_versions);
      assert.deepEqual(detail.unused_sections, before.quote_verification_sections);
      assert.deepEqual(detail.unused_verification, before.quote_verifications[0]);
      assert.deepEqual(detail.previous_confirmation, before.quote_customer_confirmations[0]);
      if (writer.action) assert.equal(after.audit_log.filter(row => row.action === writer.action).length, 0);
    });
    await t.test(`${writer.name}: writer wins before revoke and preserves the acknowledged content`, async () => {
      const f = await fixture(), before = await snapshot(f.id);
      const pause = await barrier(writer.table, `NEW.id=${writer.table === 'quote_verification_versions' ? f.version.id : f.sales.id}`);
      let write, undo;
      try { write = writer.run(f); await pause.entered(); undo = revoke(f); await observeCompetingRequest(undo); }
      finally { await pause.release(); }
      const [written, undone] = await Promise.all([write, undo]);
      await pause.remove();
      const after = await snapshot(f.id);
      t.diagnostic(JSON.stringify({ writer: writer.name, order: 'write-first', writeStatus: written.status, revokeStatus: undone.status, survivingVersions: after.quote_verification_versions.length }));
      assert.equal(written.status, 200, JSON.stringify(written.body));
      assert.equal(undone.status, 409, JSON.stringify(undone.body));
      assert.equal(after.quote_customer_confirmations[0].status, 'confirmed');
      assert.equal(after.quote_verification_versions.length, 1);
      assert.equal(after.quote_verification_sections.length, before.quote_verification_sections.length);
      assert.equal(after.audit_log.filter(row => row.action === 'customer_confirmation_revoke').length, 0);
      assert.deepEqual(after.quotes, before.quotes); assert.deepEqual(after.quote_sections, before.quote_sections);
      await writer.check(f);
      if (writer.action) assert.equal(after.audit_log.filter(row => row.action === writer.action).length, 1);
    });
  }
  await t.test('even an empty category action commits its audit before revocation may decide eligibility', async () => {
    const f = await fixture();
    const pause = await barrier('audit_log', "NEW.action='verification_version_category'");
    let write, undo;
    try {
      write = api(`/verifications/versions/${f.version.id}`, 'PATCH', { category: '' });
      await pause.entered(); undo = revoke(f); await observeCompetingRequest(undo);
    } finally { await pause.release(); }
    const [written, undone] = await Promise.all([write, undo]);
    await pause.remove();
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(undone.status, 409, JSON.stringify(undone.body));
    const after = await snapshot(f.id);
    assert.equal(after.quote_verification_versions.length, 1);
    assert.equal(after.quote_verification_versions[0].category, null);
    assert.equal(after.audit_log.filter(row => row.action === 'verification_version_category').length, 1);
    assert.equal(after.audit_log.filter(row => row.action === 'customer_confirmation_revoke').length, 0);
  });
  await t.test('a saved empty object is still real work and cannot be revoked', async () => {
    const f = await fixture();
    assert.equal((await api(`/verifications/versions/${f.version.id}/sections/${f.sales.id}`, 'PUT', {
      payload: {}, base_revision: f.sales.revision, submit: false,
    })).status, 200);
    const before = await snapshot(f.id);
    assert.equal((await revoke(f)).status, 409);
    assert.deepEqual(await snapshot(f.id), before);
  });
  await t.test('GET and next-version POST queued behind revoke return conflicts without recreating V1', async () => {
    const f = await fixture();
    const pause = await barrier('audit_log', "NEW.action='customer_confirmation_revoke'");
    let undo, view, next;
    try {
      undo = revoke(f); await pause.entered();
      view = api(`/verifications/${f.id}`);
      next = api(`/verifications/${f.id}/versions`, 'POST', { source_type: 'quote' });
      await until(async () => Number((await one("SELECT COUNT(*) n FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'", [schema])).n) >= 3);
    } finally { await pause.release(); }
    const [undone, viewed, created] = await Promise.all([undo, view, next]);
    await pause.remove();
    assert.equal(undone.status, 200);
    assert.equal(viewed.status, 409, JSON.stringify(viewed.body));
    assert.equal(created.status, 409, JSON.stringify(created.body));
    const after = await snapshot(f.id);
    assert.equal(after.quote_verifications.length, 0);
    assert.equal(after.quote_verification_versions.length, 0);
    assert.equal(after.quote_verification_sections.length, 0);
    assert.equal(after.quote_customer_confirmations[0].status, 'pending');
  });
  await t.test('category audit failure rolls its field update back with no partial acknowledgement', async () => {
    const f = await fixture(), before = await snapshot(f.id);
    await db.query(`CREATE FUNCTION reject_test_category() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='verification_version_category' THEN RAISE EXCEPTION 'synthetic PR1087 category failure'; END IF; RETURN NEW; END$$`);
    await db.query('CREATE TRIGGER reject_test_category BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_test_category()');
    try {
      assert.equal((await api(`/verifications/versions/${f.version.id}`, 'PATCH', { category: 'must roll back' })).status, 500);
      assert.deepEqual(await snapshot(f.id), before);
    } finally { await db.query('DROP TRIGGER reject_test_category ON audit_log'); await db.query('DROP FUNCTION reject_test_category()'); }
  });
  await t.test('a late confirmation update failure restores V1, every department and audit atomically', async () => {
    const f = await fixture(), before = await snapshot(f.id);
    await db.query(`CREATE FUNCTION reject_test_revoke() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.status='pending' AND OLD.status='confirmed' THEN RAISE EXCEPTION 'synthetic PR1087 rollback'; END IF; RETURN NEW; END$$`);
    await db.query('CREATE TRIGGER reject_test_revoke BEFORE UPDATE ON quote_customer_confirmations FOR EACH ROW EXECUTE FUNCTION reject_test_revoke()');
    try { assert.equal((await revoke(f)).status, 500); assert.deepEqual(await snapshot(f.id), before); }
    finally { await db.query('DROP TRIGGER reject_test_revoke ON quote_customer_confirmations'); await db.query('DROP FUNCTION reject_test_revoke()'); }
  });
  await t.test('a deferred commit failure never acknowledges removal of the automatic V1', async () => {
    const f = await fixture(), before = await snapshot(f.id);
    await db.query(`CREATE FUNCTION reject_test_commit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='customer_confirmation_revoke' THEN RAISE EXCEPTION 'synthetic PR1087 commit failure'; END IF; RETURN NEW; END$$`);
    await db.query('CREATE CONSTRAINT TRIGGER reject_test_commit AFTER INSERT ON audit_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_test_commit()');
    try { assert.equal((await revoke(f)).status, 500); assert.deepEqual(await snapshot(f.id), before); }
    finally { await db.query('DROP TRIGGER reject_test_commit ON audit_log'); await db.query('DROP FUNCTION reject_test_commit()'); }
  });
  assert.ok(!/deadlock detected|no transaction is active/.test(errors), errors);
});
