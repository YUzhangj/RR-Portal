'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const { DEFAULT_COSTING_BASIS, applyCostingBasisPayload } = require('../backend/services/costingBasis');
const { sectionRevision, assertSectionRevision, saveVerificationSection, withVerificationVersion } = require('../backend/services/verificationSectionSave');
const { prepareWorkbookChanges, prepareNativeSectionPayload } = require('../backend/services/excelWorkbookEdit');
const { upgradeLegacySectionsForCalculation, calculateLegacyFormulaCosts } = require('../backend/services/legacyFormula');
const { buildWorkbook: buildQuoteWorkbook } = require('../backend/services/exportInternal');
const { buildVerificationRow, buildVerificationWorkbook, columns } = require('../backend/services/verificationSummary');
const { buildWorkbook: buildWorkshopWorkbook } = require('../backend/services/verificationWorkshopExport');

const basis = () => ({ ...structuredClone(DEFAULT_COSTING_BASIS), machines: [{ model: '20A', normal: '200T', price: 3840 }] });
const injection = (price, mode) => ({ mold_no: 'SYN-M01', name: '合成部件', machine_model: '20A',
  material: 'ABS', material_grade: '750SW', material_unit_price: 0.012, target: 2000, sets: 1,
  cavities: 4, weight_g: 7.5, net_weight_g: 6.25, sprue_pct: 20, technical_note: '保留技术快照',
  shot_price: price, ...(mode === undefined ? {} : { shot_price_mode: mode }) });
const constant = v => ({ v, f: null, t: 'n' });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('PR1064 基准只重算明确自动啤价，手填数值即使恰好等于旧公式也不改', () => {
  const rows = [injection(0.96, 'auto'), injection(0.96, 'manual')];
  for (const mode of [undefined, 'manual', 'unknown']) {
    for (const price of [null, '', 0, 0.96, 5]) rows.push(injection(price, mode));
  }
  const original = structuredClone(rows);
  const { payload } = applyCostingBasisPayload('molding', { injection: structuredClone(rows) }, basis());
  assert.equal(payload.injection[0].shot_price, 1.92);
  for (let i = 1; i < rows.length; i++) {
    assert.equal(payload.injection[i].shot_price, original[i].shot_price);
    assert.equal(payload.injection[i].shot_price_mode, original[i].shot_price_mode);
  }
  for (let i = 0; i < rows.length; i++) {
    for (const key of ['target', 'sets', 'cavities', 'weight_g', 'net_weight_g', 'sprue_pct', 'technical_note']) {
      assert.equal(payload.injection[i][key], original[i][key]);
    }
  }
  assert.deepEqual(rows, original, '计算不能修改调用者的历史源对象');
});

test('PR1064 共模独立分摊的整行技术及价格不被普通基准重写，包含零毛重', () => {
  const rows = [0, 12].map(raw => ({ ...injection(0.1234, 'auto'), catalog_raw_weight: raw,
    catalog_material_unit_price: 0.77, material_unit_price: 0.88, machine: '冻结机型' }));
  const result = applyCostingBasisPayload('molding', { injection: rows }, basis()).payload;
  assert.deepEqual(result.injection, rows);
  assert.deepEqual(result.machine_prices, basis().machines);
  assert.deepEqual(result.material_prices, basis().materials);
});

test('PR1064 机型精确匹配；未知后缀不猜机型，零费用保零，无效套数留空', () => {
  const rows = [injection(8, 'auto'), injection(8, 'auto'), injection(8, 'auto')];
  rows[0].machine_model = '20A-非真实机型';
  rows[1].sets = 0;
  const input = basis(); input.machines[0].price = 0;
  const saved = applyCostingBasisPayload('molding', { injection: rows }, input).payload.injection;
  assert.equal(saved[0].shot_price, null);
  assert.equal(saved[1].shot_price, null);
  assert.equal(saved[2].shot_price, 0);
});

function sqliteFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE quote_sections(id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL);
    CREATE TABLE quote_verification_versions(id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE quote_verification_sections(id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL,
      dept TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
      filled_by TEXT, filled_at TEXT, reviewed_at TEXT);`);
  const db = { prepare: sql => sqlite.prepare(sql), transaction: operation => async () => {
    sqlite.exec('BEGIN');
    try { const result = await operation(); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { db, sqlite };
}

test('PR1064 自动/手填/旧空价经真实 SQLite 保存、重开、Excel 缓存保持同一口径且原报价冻结', async () => {
  const { db, sqlite } = sqliteFixture();
  const source = { injection: [injection(0.96, 'auto'), injection(null), injection('', 'manual'),
    injection(0, 'manual'), injection(0.96, 'manual'), { ...injection(0.125, 'auto'), catalog_raw_weight: 0 }] };
  const raw = JSON.stringify(source);
  sqlite.prepare('INSERT INTO quote_sections VALUES(1,?)').run(raw);
  sqlite.prepare("INSERT INTO quote_verification_versions VALUES(1,'drafting')").run();
  sqlite.prepare("INSERT INTO quote_verification_sections VALUES(1,1,'molding',?,'filled','合成用户','2026-01-01T00:00:00.000Z',NULL)").run(raw);
  try {
    const saved = applyCostingBasisPayload('molding', source, basis()).payload;
    const previous = sqlite.prepare('SELECT * FROM quote_verification_sections WHERE id=1').get();
    await withVerificationVersion(db, 1, async version => {
      assert.equal(version.status, 'drafting');
      assertSectionRevision(previous, sectionRevision(previous));
      await saveVerificationSection(db, previous, saved, false, '合成用户');
    });
    const reopened = JSON.parse(sqlite.prepare('SELECT payload_json FROM quote_verification_sections WHERE id=1').get().payload_json);
    assert.deepEqual(reopened, saved);
    assert.deepEqual(reopened.injection.map(r => r.shot_price), [1.92, null, '', 0, 0.96, 0.125]);
    assert.equal(sqlite.prepare('SELECT payload_json FROM quote_sections WHERE id=1').get().payload_json, raw);
    const wb = await buildQuoteWorkbook({ quote: { qty: 10 }, sections: [{ dept: 'molding', payload_json: JSON.stringify(reopened) }] });
    const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(await wb.xlsx.writeBuffer());
    for (const sheetName of ['报价明细', '啤机明细']) {
      const ws = loaded.getWorksheet(sheetName); let start;
      ws.eachRow(row => { if (row.getCell(1).value === '模号' && row.getCell(2).value === '模具名称') start = row.number + 1; });
      assert.ok(start);
      assert.equal(ws.getCell(start, 9).result, 1.92);
      assert.equal(ws.getCell(start, 9).formula, `ROUND(3840/J${start}/L${start},4)`);
      for (const [index, expected] of [[1, null], [2, null], [3, 0], [4, 0.96], [5, 0.125]]) {
        const cell = ws.getCell(start + index, 9);
        assert.equal(cell.value, expected);
        assert.equal(cell.formula, undefined, '旧值、空值、共模价不伪造公式');
      }
    }
    await assert.rejects(withVerificationVersion(db, 1, () => saveVerificationSection(db, previous, { injection: [] }, false, '过期写入')), error => error.status === 409);
    sqlite.prepare("UPDATE quote_verification_versions SET status='completed' WHERE id=1").run();
    const current = sqlite.prepare('SELECT * FROM quote_verification_sections WHERE id=1').get();
    await assert.rejects(withVerificationVersion(db, 1, () => saveVerificationSection(db, current, { injection: [] }, false, '完成后写入')), error => error.status === 409);
    assert.deepEqual(JSON.parse(sqlite.prepare('SELECT payload_json FROM quote_verification_sections WHERE id=1').get().payload_json), saved);
  } finally { sqlite.close(); }
});

function workbookSections() {
  return [{ id: 1, dept: 'sales', payload_json: JSON.stringify({ legacy_import: { excel_model: { sheet: 'S', cells: {
    'S!A1': { v: 10, owner: 'sales' }, 'S!B1': { v: 2, owner: 'molding' },
    'S!C1': { f: 'A1/B1', v: 5, owner: 'sales' },
  } } }, excel_native: { inputs: {} }, unchanged: { source: 'frozen' } }) },
  { id: 2, dept: 'molding', payload_json: JSON.stringify({ excel_native: { inputs: {} } }) }];
}

test('PR1064 跨部门公式依赖不能因普通数字改动变成除零；原模型和其他部门所有权不可伪造', () => {
  const sections = workbookSections(), before = structuredClone(sections);
  assert.throws(() => prepareWorkbookChanges(sections, [{ section_id: 2, inputs: { 'S!B1': constant(0) }, base_inputs: {} }], () => true), error => error.status === 400 && /DIV\/0/.test(error.message));
  assert.throws(() => prepareWorkbookChanges(sections, [{ section_id: 2, inputs: { 'S!A1': constant(4) }, base_inputs: {} }], () => true), error => error.status === 403);
  const forged = JSON.parse(sections[0].payload_json); forged.legacy_import.excel_model.cells['S!B1'].owner = 'sales';
  assert.throws(() => prepareNativeSectionPayload(sections, 1, forged, () => true), error => error.status === 403);
  const legal = { excel_native: { inputs: { 'S!B1': { v: 4 } } } };
  const saved = prepareNativeSectionPayload(sections, 2, legal, () => true);
  assert.deepEqual(saved.excel_native.inputs['S!B1'], constant(4));
  assert.deepEqual(sections, before);
});

test('PR1064 历史分项核价编辑数量单价后汇总实时变化，源金额和来源报价不变', () => {
  const source = [{ dept: 'sales', payload: { pricing_summary: { t1: { base_price: 12 }, t2: { other_buy: 6 }, t3: {} },
    legacy_import: { summary_only: true, source_cost_including_labor: 6 } } },
  { dept: 'engineering', payload: { legacy_items: [{ name: '合成外购件', quantity: 2, current_hkd: 6 }] } }];
  const before = structuredClone(source);
  const upgraded = upgradeLegacySectionsForCalculation(source, basis());
  const payloads = Object.fromEntries(upgraded.map(s => [s.dept, s.payload]));
  const item = payloads.engineering.legacy_items[0];
  assert.equal(item.formula_quantity, 2); assert.equal(item.formula_unit_hkd, 3);
  const initial = calculateLegacyFormulaCosts({ factory_code: 'synthetic' }, payloads);
  assert.equal(initial.components.other_buy, 6); assert.equal(initial.quotedPrice, 12);
  item.formula_unit_hkd = 4;
  const edited = calculateLegacyFormulaCosts({ factory_code: 'synthetic' }, payloads);
  assert.equal(edited.components.other_buy, 8); assert.equal(edited.quotedPrice, 16);
  assert.equal(item.source_current_hkd, 6);
  assert.deepEqual(payloads.sales.legacy_import.source_pricing_summary, before[0].payload.pricing_summary);
  assert.deepEqual(source, before);
});

function nativeCartonSections() {
  const cells = {}, groups = [];
  const group = (title, row, labels, values) => {
    const headers = labels.map((_, index) => `s!${String.fromCharCode(65 + index)}${row}`);
    const inputs = labels.map((_, index) => `s!${String.fromCharCode(65 + index)}${row + 1}`);
    labels.forEach((v, index) => { cells[headers[index]] = { v }; });
    values.forEach((v, index) => { cells[inputs[index]] = typeof v === 'object' ? v : { v }; });
    groups.push({ title, rows: [headers, inputs] });
  };
  group('货价与材料', 1, ['货价', '进口料', '国内料'], [100, 0, 0]);
  group('包装与外购', 4, ['不含人工成本', '纸箱', '运费', '吊柜费'], [20, 11, 0, 0]);
  group('人工与成本', 7, ['总成本', '啤工', '装配工', '喷油工'], [20, 0, 0, 0]);
  group('减税与税后结果', 10, ['纸箱类'], [0.1]);
  groups[3].rows.push(['s!A13']); cells['s!A13'] = { v: 1.1, f: 'B5*0.1' };
  cells['s!K1'] = { v: 1.1 }; cells['s!K2'] = { v: 18.9 };
  return [{ dept: 'sales', payload_json: JSON.stringify({ summary_order_quantity: { value: 10 }, legacy_import: { excel_model: {
    cells, groups, metrics: { price: 's!A2', total: 's!A8', no_labor: 's!A5', deduction: 's!K1', after_cost: 's!K2' },
  } }, excel_native: { inputs: {} } }) }];
}

test('PR1064 纸箱除1.1的减税同步进入总减税与税后成本，序列化Excel结果与网页一致', async () => {
  const sections = nativeCartonSections(), before = structuredClone(sections);
  const row = buildVerificationRow({ id: 1, customer: 'SYN-CARTON', quote_no: 'SYN-Q1', product_name: '合成纸箱测试' },
    { id: 1, label: 'V1', status: 'drafting' }, sections, []);
  closeTo(row.values.AO, 9.85); closeTo(row.values.CY, 1.15); closeTo(row.values.CZ, 18.85);
  const wb = buildVerificationWorkbook([row], { factoryName: '合成厂区' });
  const saved = new ExcelJS.Workbook(); await saved.xlsx.load(await wb.xlsx.writeBuffer());
  const ws = saved.getWorksheet('SYN-CARTON'); let detail;
  ws.eachRow(r => { if (r.getCell('B').value === 'SYN-Q1' && r.getCell('C').value === '合成纸箱测试') detail = r.number; });
  assert.ok(detail);
  closeTo(ws.getCell(`AO${detail}`).result, row.values.AO);
  closeTo(ws.getCell(`CY${detail}`).result, row.values.CY);
  closeTo(ws.getCell(`CZ${detail}`).result, row.values.CZ);
  assert.equal(ws.getCell(`CZ${detail}`).formula, `IF(COUNT(F${detail},CY${detail})=2,F${detail}-CY${detail},"")`);
  assert.deepEqual(sections, before);
});

function reportRow(customer, workshop, amount) {
  return { id: customer, values: { A: customer, B: `SYN-${customer}`, C: '合成货品', D: amount,
    E: 1, F: 0, DI: amount, J: 0, N: 0, R: 0 }, workshop, sources: {}, formulas: {}, issues: [] };
}

test('PR1064 导出标题来自实际厂区与北京时间，不以历史模板文件名冒充ABS价或汇率', async () => {
  const rows = [reportRow('SYN-A', '兴信A', 100), reportRow('SYN-A', '兴信B', 200)];
  const wb = buildWorkshopWorkbook(rows, columns, { now: new Date('2026-12-31T16:01:00Z'), factoryName: '合成厂区' });
  const saved = new ExcelJS.Workbook(); await saved.xlsx.load(await wb.xlsx.writeBuffer());
  const titles = [];
  for (const ws of saved.worksheets) ws.eachRow(row => {
    const first = row.getCell(1);
    if (first.font?.size === 24 && typeof first.value === 'string') titles.push(first.value);
  });
  assert.ok(titles.length >= 9);
  for (const title of titles) {
    assert.ok(title.startsWith('合成厂区---2027年1月份'), title);
    assert.ok(!title.includes('ABS') && !title.includes('0.87') && !title.includes('6.5'), title);
  }
  assert.ok(titles.some(title => title.includes('兴信A各客')));
  assert.ok(titles.some(title => title.includes('兴信B各客')));
  assert.equal(saved.getWorksheet('SYN-A').getCell('A1').value, '合成厂区---2027年1月份 SYN-A产品核价总表');
  for (const ws of saved.worksheets) ws.eachRow(row => row.eachCell(cell => {
    assert.ok([16, 24].includes(cell.font?.size), `${ws.name}:${cell.address} font=${cell.font?.size}`);
  }));
});

test('PR1064 真实客户名为“全部客户”也不能把车间或总合计公式缩成该客户单独小计', async () => {
  const rows = [reportRow('全部客户', '兴信A', 100), reportRow('SYN-B', '兴信A', 200)];
  const wb = buildWorkshopWorkbook(rows, columns, { now: new Date('2026-11-03T00:00:00Z') });
  const saved = new ExcelJS.Workbook(); await saved.xlsx.load(await wb.xlsx.writeBuffer());
  for (const name of ['总表分车间', '总表不分车间']) {
    const ws = saved.getWorksheet(name), cell = ws.getCell(ws.rowCount, 4);
    assert.equal(cell.result, 300);
    assert.ok(cell.formula.includes("'全部客户'!"), cell.formula);
    assert.ok(cell.formula.includes("'SYN-B'!"), cell.formula);
  }
  const detail = saved.getWorksheet('全部客户');
  assert.equal(detail.getCell(detail.rowCount, 4).result, 100);
});
