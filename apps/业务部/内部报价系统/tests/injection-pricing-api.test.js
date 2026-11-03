'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Pricing = require('../frontend/injection-pricing');
const Supplier = require('../frontend/supplier-material-sync');

test('真实隔离保存接口保留自动/手填/历史来源及供应商精确归属', { timeout: 30000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'injection-pricing-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['backend/server.js'], { cwd: path.join(__dirname, '..'), env: {
    ...process.env, NODE_ENV: 'test', DB_DRIVER: 'sqlite', DB_FILE: path.join(temporary, 'test.db'),
    DATABASE_URL: '', TEST_DATABASE_URL: '', PORT: String(port), HOST: '127.0.0.1',
    SESSION_SECRET: 'injection-pricing-test-only', COOKIE_SECURE: '0', ADMIN_INITIAL_PASSWORD: 'pricing-test-only',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await ended;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('test server start timeout: ' + logs)), 15000);
    child.stdout.on('data', data => { if (String(data).includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(Error('test server exited ' + code + ': ' + logs)); });
  });
  let cookie = '';
  async function api(url, method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, { method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data)); return data;
  }
  await api('/auth/login', 'POST', { username: 'admin', password: 'pricing-test-only' });
  const created = await api('/quotes', 'POST', { quote_no: 'PR1060-ISOLATED', product_name: '定价隔离夹具', customer: 'TEST', qty: 1000 });
  const read = () => api('/quotes/' + created.id);
  let quote = await read();
  const section = dept => quote.sections.find(row => row.dept === dept);
  const historical = { mold_no: '01M', machine_model: '20A', target: 2000, sets: 1, shot_price: 1.01 };
  const auto = { ...historical, mold_no: '02M', target: 1000 };
  const molding = { machine_prices: [{ model: '20A', price: 2020 }], injection: [historical, auto] };
  Pricing.reprice(auto, molding.machine_prices);
  const first = await api('/sections/' + section('molding').id, 'PUT', { payload: molding, base_filled_at: section('molding').filled_at });
  quote = await read();
  assert.deepEqual(JSON.parse(section('molding').payload_json), molding);
  const loaded = JSON.parse(section('molding').payload_json);
  loaded.injection[1].shot_price_mode = 'manual'; // Explicit same-value hand edit remains fixed.
  await api('/sections/' + section('molding').id, 'PUT', { payload: loaded, base_filled_at: first.filled_at });
  quote = await read();
  assert.equal(JSON.parse(section('molding').payload_json).injection[1].shot_price_mode, 'manual');
  assert.deepEqual(JSON.parse(section('molding').payload_json).injection[0], historical);
  const row = { name: '隔离物料', supplier_id: 'A', supplier_name: '同名供应商', qty: 1 };
  const other = { name: '其他供应商物料', supplier_id: 'B', supplier_name: '同名供应商', qty: 5 };
  Supplier.setSupplier(row, '同名供应商', [row, other]);
  const engineering = { hardware: [row, other], aux_materials: [], packaging_materials: [] };
  await api('/sections/' + section('engineering').id, 'PUT', { payload: engineering, base_filled_at: section('engineering').filled_at });
  quote = await read();
  assert.deepEqual(JSON.parse(section('engineering').payload_json), engineering);
});
