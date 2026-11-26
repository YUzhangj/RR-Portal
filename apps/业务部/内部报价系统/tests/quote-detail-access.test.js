'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

test('报价和核价完整明细只允许业务、工程访问，其他部门管理员也不能绕过', { timeout: 60000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-detail-access-'));
  const database = path.join(temporary, 'test.db');
  const password = 'synthetic-detail-access';
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', DB_DRIVER: 'sqlite', DB_FILE: database,
      DATABASE_URL: '', PORT: String(port), HOST: '127.0.0.1',
      SESSION_SECRET: password, ADMIN_INITIAL_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let db;
  t.after(async () => {
    db?.close();
    if (child.exitCode === null) {
      const done = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await done;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  let errors = '';
  child.stderr.on('data', value => { errors += value; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('startup timeout: ' + errors)), 15000);
    child.stdout.on('data', value => {
      if (String(value).includes('listening on')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`server exit ${code}: ${errors}`)); });
  });
  db = new DatabaseSync(database);
  let cookie = '';
  async function api(url, method = 'GET', body) {
    if (['PUT', 'DELETE'].includes(method) && url.endsWith('/output-cell')) {
      const layout = await api(url.replace(/output-cell$/, 'output-layout'));
      body = { ...body, base_revision: layout.data.revision };
    }
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
    const data = response.headers.get('content-type')?.includes('json')
      ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data };
  }
  assert.equal((await api('/auth/login', 'POST', { username: 'admin', password })).status, 200);
  const quote = await api('/quotes', 'POST', { quote_no: 'ACCESS-Q', product_name: 'Synthetic', customer: 'TEST', qty: 1000 });
  assert.equal(quote.status, 200);
  const task = await api('/verifications', 'POST', { quote_no: 'ACCESS-V', product_name: 'Synthetic', customer: 'TEST', qty: 1000 });
  assert.equal(task.status, 201);
  const id = quote.data.id, version = task.data.version_id;
  const routes = [
    [`/quotes/${id}/output-layout`, 'GET'],
    [`/quotes/${id}/output-cell`, 'PUT'], [`/quotes/${id}/output-cell`, 'DELETE'],
    [`/quotes/${id}/output-export`, 'GET'], [`/quotes/${id}/export`, 'GET'],
    [`/verifications/versions/${version}/output-layout`, 'GET'],
    [`/verifications/versions/${version}/output-cell`, 'PUT'],
    [`/verifications/versions/${version}/output-cell`, 'DELETE'],
    [`/verifications/versions/${version}/export`, 'GET'],
  ];
  for (const dept of ['electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly']) {
    await t.test(`${dept} is denied on every full-detail route`, async () => {
      db.prepare("UPDATE users SET dept=? WHERE username='admin'").run(dept);
      assert.equal((await api('/auth/me')).data.can_view_quote_detail, false);
      for (const [url, method] of routes) {
        const result = await api(url, method, method === 'GET' ? undefined : {});
        assert.equal(result.status, 403, `${dept}: ${method} ${url}`);
        assert.match(result.data.error, /仅限业务部和工程部/);
      }
      assert.equal((await api(`/quotes/${id}`)).status, 200, 'ordinary department page stays accessible');
    });
  }
  db.prepare("UPDATE quote_sections SET status='approved' WHERE quote_id=?").run(id);
  db.prepare("UPDATE quote_verification_sections SET status='approved' WHERE version_id=?").run(version);
  for (const dept of ['sales', 'engineering']) {
    await t.test(`${dept} can preview and export both quotation and verification`, async () => {
      db.prepare("UPDATE users SET dept=? WHERE username='admin'").run(dept);
      db.prepare("UPDATE quote_sections SET status='approved' WHERE quote_id=?").run(id);
      assert.equal((await api('/auth/me')).data.can_view_quote_detail, true);
      for (const [url, method] of routes.filter(([, method]) => method === 'GET')) {
        assert.equal((await api(url)).status, 200, `${dept}: ${url}`);
      }
      const save = await api(`/quotes/${id}/output-cell`, 'PUT', {
        sheet_name: '报价明细', cell_address: 'C2', value: 9,
      });
      assert.equal(save.status, 200, JSON.stringify(save.data));
      assert.equal((await api(`/quotes/${id}/output-cell`, 'DELETE', {
        sheet_name: '报价明细', cell_address: 'C2',
      })).status, 200);
    });
  }
  for (const dept of ['sales', 'engineering']) {
    await t.test(`${dept} edits approved parameters in the table and only reopens their source department`, async () => {
      db.prepare("UPDATE users SET dept=? WHERE username='admin'").run(dept);
      db.prepare("UPDATE quote_verification_versions SET status='ready' WHERE id=?").run(version);
      db.prepare("UPDATE quote_verification_sections SET status='approved', reviewed_by='Synthetic reviewer', reviewed_at='2026-11-25' WHERE version_id=?").run(version);
      const before = await api(`/verifications/versions/${version}/output-layout`);
      const cell = before.data.sheets.find(sheet => sheet.name === '报价明细').cells.find(cell => cell.address === 'C2');
      assert.equal(cell.editable, true);
      const changed = await api(`/verifications/versions/${version}/output-cell`, 'PUT', {
        sheet_name: '报价明细', cell_address: 'C2', value: 9,
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.data));
      assert.equal(changed.data.source_dept, 'molding');
      const source = db.prepare("SELECT * FROM quote_verification_sections WHERE version_id=? AND dept='molding'").get(version);
      assert.equal(source.status, 'filled');
      assert.equal(source.reviewed_by, null);
      assert.equal(source.reviewed_at, null);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quote_verification_sections WHERE version_id=? AND status='approved'").get(version).n, 7);
      assert.equal(db.prepare('SELECT status FROM quote_verification_versions WHERE id=?').get(version).status, 'in_review');
      const after = await api(`/verifications/versions/${version}/output-layout`);
      assert.equal(after.data.can_export, false);
      assert.equal(after.data.approved_count, 7);
      const price = after.data.sheets.find(sheet => sheet.name === '报价明细').cells.find(cell => cell.address === 'C4');
      assert.ok(Math.abs(Number(price.rawValue) - 9 / 454) < 0.0001);
      const audit = JSON.parse(db.prepare("SELECT detail FROM audit_log WHERE action='verification_output_edit' ORDER BY id DESC LIMIT 1").get().detail);
      assert.equal(audit.review_reopened, true);
      assert.equal(audit.previous_reviewed_by, 'Synthetic reviewer');
    });
  }
  await t.test('统一印尼比例从明细表保存后同步到所有报价和核价部门', async () => {
    for (const [url, table, key, target] of [
      [`/quotes/${id}/output-cell`, 'quote_sections', 'quote_id', id],
      [`/verifications/versions/${version}/output-cell`, 'quote_verification_sections', 'version_id', version],
    ]) {
      db.prepare(`UPDATE ${table} SET status='approved', reviewed_by='Synthetic reviewer', reviewed_at='2026-11-26' WHERE ${key}=?`).run(target);
      const save = await api(url, 'PUT', { sheet_name: '报价明细', cell_address: 'O7', value: 8 });
      assert.equal(save.status, 200, JSON.stringify(save.data));
      const sections = db.prepare(`SELECT dept,payload_json,status,reviewed_by FROM ${table} WHERE ${key}=?`).all(target);
      for (const section of sections.filter(section => section.dept !== 'assembly')) {
        assert.equal(JSON.parse(section.payload_json).indo_pct, 8, section.dept);
        assert.equal(section.status, 'filled', section.dept);
        assert.equal(section.reviewed_by, null, section.dept);
      }
      assert.equal(sections.find(section => section.dept === 'assembly').status, 'approved');
      const zero = await api(url, 'PUT', { sheet_name: '报价明细', cell_address: 'O7', value: 0 });
      assert.equal(zero.status, 200, JSON.stringify(zero.data));
      const after = db.prepare(`SELECT payload_json FROM ${table} WHERE ${key}=? AND dept='sales'`).get(target);
      assert.equal(JSON.parse(after.payload_json).indo_pct, 0);
      assert.equal((await api(url, 'PUT', { sheet_name: '报价明细', cell_address: 'O7', value: -1 })).status, 400);
    }
    const quoteData = await api(`/quotes/${id}`);
    assert.equal(quoteData.data.quotation_rates.indo_pct, 0);
  });
  await t.test('unified freight requires every affected department and rolls back corrupt sources', async () => {
    for (const [url,table,key,target] of [
      [`/quotes/${id}/output-cell`,'quote_sections','quote_id',id],
      [`/verifications/versions/${version}/output-cell`,'quote_verification_sections','version_id',version],
    ]) {
      db.prepare("UPDATE user_perms SET can_edit=0 WHERE menu='喷油部'").run();
      const before=db.prepare(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY id`).all(target);
      const layout=await api(url.replace('output-cell','output-layout'));
      assert.equal(layout.data.sheets.find(s=>s.name==='报价明细').cells.find(c=>c.address==='O7').editable,false);
      assert.equal((await api(url,'PUT',{sheet_name:'报价明细',cell_address:'O7',value:8})).status,403);
      assert.deepEqual(db.prepare(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY id`).all(target),before);
      db.prepare("UPDATE user_perms SET can_edit=1 WHERE menu='喷油部'").run();
      const prior=db.prepare(`SELECT * FROM ${table} WHERE ${key}=? AND dept='sewing'`).get(target);
      db.prepare(`UPDATE ${table} SET payload_json='[]' WHERE id=?`).run(prior.id);
      const corrupt=db.prepare(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY id`).all(target);
      const audits=db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
      assert.equal((await api(url,'PUT',{sheet_name:'报价明细',cell_address:'O7',value:9})).status,409);
      assert.deepEqual(db.prepare(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY id`).all(target),corrupt);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,audits);
      db.prepare(`UPDATE ${table} SET payload_json=? WHERE id=?`).run(prior.payload_json,prior.id);
    }
  });
  await t.test('editing permissions and completed-version locks still apply', async () => {
    db.prepare("UPDATE user_perms SET can_edit=0 WHERE menu='啤机部'").run();
    const denied = await api(`/verifications/versions/${version}/output-cell`, 'PUT', {
      sheet_name: '报价明细', cell_address: 'C2', value: 11,
    });
    assert.equal(denied.status, 403);
    db.prepare("UPDATE user_perms SET can_edit=1 WHERE menu='啤机部'").run();
    db.prepare("UPDATE quote_verification_versions SET status='completed' WHERE id=?").run(version);
    for (const method of ['PUT', 'DELETE']) {
      assert.equal((await api(`/verifications/versions/${version}/output-cell`, method, {
        sheet_name: '报价明细', cell_address: 'C2', value: 11,
      })).status, 409);
    }
    const locked = await api(`/verifications/versions/${version}/output-layout`);
    assert.equal(locked.data.can_edit_output, false);
    assert.equal(JSON.parse(db.prepare("SELECT value_json FROM quote_verification_output_overrides WHERE version_id=? AND cell_address='C2'").get(version).value_json).value, 9);
  });
});
