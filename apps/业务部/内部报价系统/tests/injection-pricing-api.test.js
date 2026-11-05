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
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { buildWorkbook } = require('../backend/services/exportInternal');
const workbench = fs.readFileSync(require.resolve('../frontend/workbench.js'), 'utf8');
function openMolding(payload) {
  const context = vm.createContext({ payload, window: { InjectionPricing: Pricing, __refs: { _loaded: true, _ready: true } },
    num: value => Number(value) || 0, defaultMachinePricesForFactory: () => payload.machine_prices, DEFAULT_MATERIAL_PRICES: [] });
  vm.runInContext(workbench.slice(workbench.indexOf('function lookupMachinePrice('), workbench.indexOf('function syncInjectionMolds(')), context);
  vm.runInContext(workbench.slice(workbench.indexOf('function isBlankInjectionPrice('), workbench.indexOf('function renderMolding(')), context);
  const begin = workbench.indexOf('function renderMolding('), end = workbench.indexOf('  const canEditPrices', begin);
  vm.runInContext(workbench.slice(begin, end) + '\nreturn payload;\n}', context);
  vm.runInContext('renderMolding(null, payload, true, () => {}, [], 1, \"staff\")', context);
}


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
  const historical = { mold_no: '01M', machine_model: '20A', machine: '200T', material_unit_price: 0, target: 2000, sets: 1, shot_price: 1.01 };
  const auto = { ...historical, mold_no: '02M', target: 1000 };
  const molding = { material_prices: [{ name: 'Synthetic fixture', price: 0 }], machine_prices: [{ model: '20A', normal: '200T', price: 2020 }], injection: [historical, auto,
    { ...historical, mold_no: 'LEGACY-ZERO', mold_part_index: 1, shot_price: 0 },
    { ...historical, mold_no: 'NULL-ORIGIN-ZERO', mold_part_index: 2, shot_price: 0, shot_price_mode: null },
    { ...historical, mold_no: 'MANUAL-ZERO', mold_part_index: 1, shot_price: 0, shot_price_mode: 'manual' },
    { ...historical, mold_no: 'MANUAL-BLANK', mold_part_index: 2, shot_price: null, shot_price_mode: 'manual' },
    { ...historical, mold_no: 'SAME-MOLD', name: 'Synthetic left', mold_part_index: 0, sets: 2, shot_price: null, shot_price_mode: 'auto' },
    { ...historical, mold_no: 'SAME-MOLD', name: 'Synthetic right', mold_part_index: 1, sets: 2, shot_price: 0, shot_price_mode: 'auto' },
    { ...historical, mold_no: 'STAGED', mold_part_index: 1, catalog_raw_weight: 0, shot_price: .1234, shot_price_mode: 'auto' },
    { ...historical, mold_no: 'SAME-MOLD', name: 'Second run first', mold_part_index: 7,
      source_sheet_name: '合成工程表', source_sheet_index: 0,
      injection_run_id: 'row:28', injection_run_part_index: 0, injection_run_name: '袖圈',
      shot_price: .6313, target: 3200, shot_price_mode: 'auto' },
    { ...historical, mold_no: 'SAME-MOLD', name: 'Second run next', mold_part_index: 8,
      source_sheet_name: '合成工程表', source_sheet_index: 0,
      injection_run_id: 'row:28', injection_run_part_index: 1, injection_run_name: '袖圈',
      shot_price: 0, target: 3200, shot_price_mode: 'auto' },
  ] };
  for (const index of [6, 7]) Object.assign(molding.injection[index], {
    source_sheet_name: '合成工程表', source_sheet_index: 0, injection_run_id: 'row:2', injection_run_part_index: index - 6,
  });
  Pricing.reprice(auto, molding.machine_prices);
  openMolding(molding);
  assert.deepEqual(molding.injection.map(row => row.shot_price), [1.01, 2.02, 0, 0, 0, null, .505, 0, .1234, .6313, 0]);
  const first = await api('/sections/' + section('molding').id, 'PUT', { payload: molding, base_filled_at: section('molding').filled_at });
  quote = await read();
  assert.deepEqual(JSON.parse(section('molding').payload_json), JSON.parse(JSON.stringify(molding)),
    'compare all transport fields after normalizing only VM-created object prototypes');
  const loaded = JSON.parse(section('molding').payload_json);
  loaded.injection[1].shot_price_mode = 'manual'; // Explicit same-value hand edit remains fixed.
  await api('/sections/' + section('molding').id, 'PUT', { payload: loaded, base_filled_at: first.filled_at });
  quote = await read();
  assert.equal(JSON.parse(section('molding').payload_json).injection[1].shot_price_mode, 'manual');
  assert.deepEqual(JSON.parse(section('molding').payload_json).injection[0], historical);
  const savedMolding = JSON.parse(section('molding').payload_json);
  assert.deepEqual(savedMolding.injection, loaded.injection, 'all per-part provenance/zero/null fields survive real save and reopen');
  const sql = new DatabaseSync(path.join(temporary, 'test.db'), { readOnly: true });
  try {
    const persisted = sql.prepare('SELECT payload_json FROM quote_sections WHERE id=?').get(section('molding').id);
    assert.deepEqual(JSON.parse(persisted.payload_json), savedMolding, 'actual SQLite bytes match all fields reopened through the API');
  } finally { sql.close(); }
  const workbook = await buildWorkbook({ quote: { qty: 1000 }, sections: [{ dept: 'molding', payload_json: JSON.stringify(savedMolding) }] });
  const roundtrip = new (require('exceljs').Workbook)(); await roundtrip.xlsx.load(await workbook.xlsx.writeBuffer());
  for (const name of ['报价明细', '啤机明细']) {
    const sheet = roundtrip.getWorksheet(name); let start;
    sheet.eachRow(row => { if (row.getCell(1).value === '模号' && row.getCell(2).value === '模具名称') start = row.number + 1; });
    assert.ok(start);
    for (const index of [2, 3, 4]) { assert.equal(sheet.getCell(start + index, 9).value, 0); assert.equal(sheet.getCell(start + index, 9).formula, undefined); }
    assert.equal(sheet.getCell(start + 5, 9).value, null);
    for (const index of [6]) { assert.equal(sheet.getCell(start + index, 9).formula, `ROUND(2020/J${start + index}/L${start + index},4)`); assert.equal(sheet.getCell(start + index, 9).result, .505); }
    assert.equal(sheet.getCell(start + 7, 9).value, 0);
    assert.equal(sheet.getCell(start + 8, 9).value, .1234);
    assert.equal(sheet.getCell(start + 9, 9).formula, `ROUND(2020/J${start + 9}/L${start + 9},4)`);
    assert.equal(sheet.getCell(start + 9, 9).result, .6313);
    assert.equal(sheet.getCell(start + 10, 9).value, 0);
  }
  // Exercise the actual table buttons before the real save endpoint. The row
  // being removed is the exact head of one explicit run, not a guessed mold.
  const working = structuredClone(savedMolding);
  const head = working.injection[6];
  Object.assign(head, { shot_price: .3142, shot_price_mode: 'manual', target: 1234, sets: 3, cycle_sec: 31 });
  const later = working.injection[7], laterName = later.name;
  const otherRunBefore = JSON.stringify(working.injection.slice(9));
  const legacyBefore = JSON.stringify(working.injection.slice(0, 6));
  const buttons = require('./helpers/injection-structure-ui.cjs')(working.injection);
  buttons.action('在下方插入副本（用于拆分）', 6);
  assert.equal(working.injection.filter(row => row.injection_run_id === 'row:2')
    .reduce((sum, row) => sum + Number(Pricing.laborPrice(row) || 0), 0), .3142);
  buttons.action('删除', 6);
  assert.equal(later.injection_run_part_index, 0);
  assert.equal(later.name, laterName);
  assert.equal(later.shot_price, .3142); assert.equal(later.shot_price_mode, 'manual');
  assert.equal(later.target, 1234); assert.equal(later.sets, 3); assert.equal(later.cycle_sec, 31);
  assert.equal(JSON.stringify(working.injection.slice(9)), otherRunBefore);
  assert.equal(JSON.stringify(working.injection.slice(0, 6)), legacyBefore);
  quote = await read();
  await api('/sections/' + section('molding').id, 'PUT', { payload: working, base_filled_at: section('molding').filled_at });
  quote = await read();
  const reopened = JSON.parse(section('molding').payload_json);
  assert.deepEqual(reopened, JSON.parse(JSON.stringify(working)), 'button-generated source and manual billing metadata survive real save/reopen');
  const stored = new DatabaseSync(path.join(temporary, 'test.db'), { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(stored.prepare('SELECT payload_json FROM quote_sections WHERE id=?')
      .get(section('molding').id).payload_json), JSON.parse(JSON.stringify(working)));
  } finally { stored.close(); }
  const response = await fetch(`http://127.0.0.1:${port}/api/quotes/${created.id}/export-department/molding`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const exported = new (require('exceljs').Workbook)(); await exported.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const exportedSheet = exported.getWorksheet('啤机明细'); let exportedStart;
  exportedSheet.eachRow(row => { if (row.getCell(1).value === '模号' && row.getCell(2).value === '模具名称') exportedStart = row.number + 1; });
  assert.ok(exportedStart);
  assert.equal(exportedSheet.getCell(exportedStart + 6, 9).value, 0, 'copied row never repeats the run labor');
  assert.equal(exportedSheet.getCell(exportedStart + 7, 9).value, .3142, 'promoted head exports the exact manual fee');
  assert.equal(exportedSheet.getCell(exportedStart + 7, 9).formula, undefined);
  assert.equal(exportedSheet.getCell(exportedStart + 7, 10).value, 3);
  assert.equal(exportedSheet.getCell(exportedStart + 7, 12).value, 1234);
  assert.equal(exportedSheet.getCell(exportedStart + 9, 9).result, .6313, 'the distinct second run remains independent');
  assert.equal(exportedSheet.getCell(exportedStart + 5, 9).value, null, 'legacy manual blank is not interpreted as a zero-price run member');

  const rounding = JSON.parse(JSON.stringify(working));
  rounding.machine_prices[0].price = 1490;
  Object.assign(rounding.injection[9], { sets: 2, target: 4000, shot_price: .1862, shot_price_mode: 'auto' });
  quote = await read();
  await api('/sections/' + section('molding').id, 'PUT', { payload: rounding, base_filled_at: section('molding').filled_at });
  quote = await read();
  const oldPriceResponse = await fetch(`http://127.0.0.1:${port}/api/quotes/${created.id}/export-department/molding`, { headers: { Cookie: cookie } });
  assert.equal(oldPriceResponse.status, 200);
  const oldPriceBook = new (require('exceljs').Workbook)(); await oldPriceBook.xlsx.load(Buffer.from(await oldPriceResponse.arrayBuffer()));
  const oldPriceCell = oldPriceBook.getWorksheet('啤机明细').getCell(exportedStart + 9, 9);
  assert.equal(oldPriceCell.value, .1862); assert.equal(oldPriceCell.formula, undefined,
    'a saved auto value from the earlier rounding rule stays fixed until explicit recalculation');
  const beforeInput = JSON.stringify(rounding.injection);
  const priceUi = require('./helpers/injection-structure-ui.cjs').pricing(rounding);
  assert.equal(JSON.stringify(rounding.injection), beforeInput, 'opening never silently upgrades a saved price');
  assert.equal(priceUi.input('target', 9).value, '4000');
  priceUi.edit('target', '4000', 9); // Actual production input callback is an explicit recalculation.
  assert.equal(rounding.injection[9].shot_price, .1863); assert.equal(priceUi.input('shot_price', 9).value, '0.1863');
  assert.equal(rounding.injection[7].shot_price, .3142); assert.equal(rounding.injection[7].shot_price_mode, 'manual');
  assert.equal(rounding.injection[4].shot_price_mode, 'manual');
  await api('/sections/' + section('molding').id, 'PUT', { payload: rounding, base_filled_at: section('molding').filled_at });
  quote = await read();
  const roundedReopened = JSON.parse(section('molding').payload_json);
  assert.deepEqual(roundedReopened, rounding);
  const roundedStored = new DatabaseSync(path.join(temporary, 'test.db'), { readOnly: true });
  try { assert.deepEqual(JSON.parse(roundedStored.prepare('SELECT payload_json FROM quote_sections WHERE id=?')
    .get(section('molding').id).payload_json), rounding); } finally { roundedStored.close(); }
  const roundedResponse = await fetch(`http://127.0.0.1:${port}/api/quotes/${created.id}/export-department/molding`, { headers: { Cookie: cookie } });
  assert.equal(roundedResponse.status, 200);
  const roundedBook = new (require('exceljs').Workbook)(); await roundedBook.xlsx.load(Buffer.from(await roundedResponse.arrayBuffer()));
  const roundedCell = roundedBook.getWorksheet('啤机明细').getCell(exportedStart + 9, 9);
  assert.equal(roundedCell.formula, `ROUND(1490/J${exportedStart + 9}/L${exportedStart + 9},4)`);
  assert.equal(roundedCell.result, .1863);
  const row = { name: '隔离物料', supplier_id: 'A', supplier_name: '同名供应商', qty: 1 };
  const other = { name: '其他供应商物料', supplier_id: 'B', supplier_name: '同名供应商', qty: 5 };
  Supplier.setSupplier(row, '同名供应商', [row, other]);
  const engineering = { hardware: [row, other], aux_materials: [], packaging_materials: [] };
  await api('/sections/' + section('engineering').id, 'PUT', { payload: engineering, base_filled_at: section('engineering').filled_at });
  quote = await read();
  assert.deepEqual(JSON.parse(section('engineering').payload_json), engineering);
});
