const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const ExcelJS = require('exceljs');

test('统一装工基数经真实草稿保存、重新读取、混装汇总及部门Excel一致，零值与只读权限保留', { timeout: 30000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-bulk-base-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const database = path.join(temporary, 'test.db');
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', DB_DRIVER: 'sqlite', DB_FILE: database, DATABASE_URL: '',
      PORT: String(port), HOST: '127.0.0.1', SESSION_SECRET: 'bulk-base-synthetic-only', COOKIE_SECURE: '0',
      ADMIN_INITIAL_PASSWORD: 'bulk-base-synthetic-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic server did not start: ' + logs)), 15000);
    child.stdout.on('data', data => { if (String(data).includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Synthetic server exited ${code}: ${logs}`)); });
  });
  let cookie = '';
  async function api(url, method = 'GET', body, expected = 200) {
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, { method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const isJson = response.headers.get('content-type')?.includes('json');
    const result = isJson ? await response.json() : Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, `${method} ${url}: ${isJson ? JSON.stringify(result) : 'xlsx response'}`);
    return result;
  }
  await api('/auth/login', 'POST', { username: 'admin', password: 'bulk-base-synthetic-only' });
  const created = await api('/quotes', 'POST', { quote_no: 'BULK-BASE-FIXTURE', product_name: '合成混装', customer: 'TEST', qty: 12000, quote_type: 'mixed' });
  let detail = await api('/quotes/' + created.id);
  const cfg = { enabled: true, mode: 'ratio', na_direct: true, units_per_pack: 6,
    products: [{ id: 'a', code: 'A', name: '甲款', ratio: .4, na_ratio: .4 }, { id: 'b', code: 'B', name: '乙款', ratio: .6, na_ratio: .6 }] };
  await api(`/quotes/${created.id}/mixed`, 'PUT', { config: cfg, expected_config: detail.mixed_quote });
  detail = await api('/quotes/' + created.id);
  const sales = detail.sections.find(s => s.dept === 'sales');
  await api('/sections/' + sales.id, 'PUT', { base_filled_at: sales.filled_at, submit: false,
    payload: { mixed_quote: cfg, header: { fx_hkd_usd: 1, fx_rmb_hkd: 1 }, shipping: { markup_x: 1, divisor: 1 }, mixed_pricing: { surtax_pct: 0 } } });
  const group = (name, count, team = 1) => ({ product: name, qty: 12000, team, steps: [{ name: '安装工序', count, note: '保留工序备注' }] });
  const root = { mixed_products: {
    a: { assembly_base_rate: 290, assembly_std_time: 10.5, assembly_step_groups: [group('甲装配', 14, 2)], packaging_step_groups: [group('甲包装', 4)], assembly_labor: [{ name: '原手填', qty: 1, unit_price: .1 }] },
    b: { assembly_base_rate: 310, assembly_std_time: 11, assembly_step_groups: [group('乙装配', 13)] },
  }, mixed_shared: { assembly_base_rate: 310, assembly_std_time: 9, packaging_step_groups: [group('共包装', 27)], packaging_materials: [{ name: '原资料', qty: 1, unit_price: 0 }] } };
  const initial = structuredClone(root);
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/mixed-quotation.js'), 'utf8'), { window });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
  for (const base of [320, 0]) {
    window.MixedQuotation.applyAssemblyBaseRate(root, cfg, String(base));
    detail = await api('/quotes/' + created.id);
    const assembly = detail.sections.find(s => s.dept === 'assembly');
    await api('/sections/' + assembly.id, 'PUT', { payload: root, submit: false, base_filled_at: assembly.filled_at });
    const saved = (await api('/quotes/' + created.id)).sections.find(s => s.dept === 'assembly');
    const restored = JSON.parse(saved.payload_json);
    assert.deepEqual(restored, root);
    for (const id of ['a', 'b']) {
      assert.equal(restored.mixed_products[id].assembly_base_rate, base);
      const { assembly_base_rate: _old, ...before } = initial.mixed_products[id];
      const { assembly_base_rate: _new, ...after } = restored.mixed_products[id];
      assert.deepEqual(after, before, '人数、目标、工时、工序、人工单价不能被统一基数覆盖');
    }
    const { assembly_base_rate: _old, ...beforeShared } = initial.mixed_shared;
    const { assembly_base_rate: _new, ...afterShared } = restored.mixed_shared;
    assert.deepEqual(afterShared, beforeShared);
    const amounts = [base * (28 + 4) / 12000 + .1, base * 13 / 12000, base * 27 / 12000];
    const summary = await api(`/quotes/${created.id}/mixed`);
    near(summary.products[0].components.assembly_labor, amounts[0]);
    near(summary.products[1].components.assembly_labor, amounts[1]);
    near(summary.common_components.assembly_labor, amounts[2]);
    near(summary.components.assembly_labor, amounts[0] * .4 + amounts[1] * .6 + amounts[2]);
    near(summary.final_usd, summary.components.assembly_labor);
    const download = await api(`/quotes/${created.id}/export-department/assembly`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(download);
    const sheet = workbook.getWorksheet('部门成本汇总');
    assert.ok(sheet, '真实部门下载必须使用混装成本');
    for (let row = 2; row <= 4; row++) near(sheet.getCell(row, 3).value, amounts[row - 2]);
  }
  const final = (await api('/quotes/' + created.id)).sections.find(s => s.dept === 'assembly');
  const { DatabaseSync } = require('node:sqlite');
  const local = new DatabaseSync(database);
  const admin = local.prepare("SELECT id FROM users WHERE username='admin'").get();
  local.prepare('UPDATE user_perms SET can_edit=0,can_review=0 WHERE user_id=?').run(admin.id);
  local.close();
  const forbidden = structuredClone(root);
  window.MixedQuotation.applyAssemblyBaseRate(forbidden, cfg, '999');
  await api('/sections/' + final.id, 'PUT', { payload: forbidden, submit: false, base_filled_at: final.filled_at }, 403);
  const protectedRow = (await api('/quotes/' + created.id)).sections.find(s => s.dept === 'assembly');
  assert.equal(protectedRow.payload_json, final.payload_json);
  assert.equal(protectedRow.filled_at, final.filled_at);
});
