'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { expandEngineeringMolds } = require('../backend/services/engineeringMolds');
const { buildQuoteSummary } = require('../backend/services/quoteSummary');
const { buildWorkbook } = require('../backend/services/exportInternal');
const { sectionsToData, exportVQ } = require('../backend/services/exportVQ');
const { sectionsToSpinData, exportSpin } = require('../backend/services/exportSpin');

function fixture() {
  // Same printed mold number in different engineering/product groups is not one physical mold.
  const molds = ['A', 'B'].map(product => ({ mold_no: 'INDEX-2', product_group_id: product,
    _sheet_name: '合成工程表', _sheet_index: 0,
    product_group_name: product, machine_model: '20A', target: 2800, sets: 1,
    parts: [{ name: product + '-left', material: 'ABS', weight_g: 10, injection_run_id: 'row:2' },
      { name: product + '-right', material: 'ABS', weight_g: 20, injection_run_id: 'row:2' }] }));
  const injection = expandEngineeringMolds(molds).map(row => ({ ...row, material_unit_price: .1,
    machine: '200T', cycle_sec: 30, shot_price: 1, shot_price_mode: 'manual' }));
  const payload = { injection, injection_loss_pct: 0, machine_prices: [{ model: '20A', price: 2800 }],
    product_mix_ratios: { A: 1, B: 3 } };
  return { quote: { id: 1, quote_no: 'FIXTURE', product_name: 'Fixture', customer: 'TOMY', qty: 1000 },
    sections: [{ dept: 'molding', payload_json: JSON.stringify(payload) }], payload };
}

test('明确啤次的重复价在报价汇总、明细导出均只计首件，原料仍逐条且产品配比保持', async () => {
  const f = fixture(), before = JSON.stringify(f);
  const summary = buildQuoteSummary(f.quote, f.sections);
  assert.equal(summary.components_before_tax.injection_labor, 1);
  assert.equal(summary.components_before_tax.imp_mat, 3);
  const wb = await buildWorkbook(f);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(await wb.xlsx.writeBuffer());
  for (const name of ['报价明细', '啤机明细']) {
    const sheet = loaded.getWorksheet(name); let start;
    sheet.eachRow(row => { if (row.getCell(2).value === '模具名称' && row.getCell(9).value === '啤价 HK$/啤') start = row.number + 1; });
    assert.ok(start);
    assert.deepEqual([0, 1, 2, 3].map(i => sheet.getCell(start + i, 9).value), [1, 0, 1, 0]);
    assert.deepEqual([0, 1, 2, 3].map(i => sheet.getCell(start + i, 7).result), [1, 2, 1, 2]);
    assert.equal(sheet.getCell(start + 4, 9).result, 1);
    assert.equal(sheet.getCell(start + 4, 14).result, 4);
    assert.match(sheet.getCell(start + 1, 9).note, /同模/);
  }
  assert.equal(JSON.stringify(f), before, '核对与导出不重写保存资料');
});

test('报客转换及SPIN最终公式均不重新计入同模后续啤工', async () => {
  const f = fixture();
  assert.deepEqual(sectionsToData(f).moldParts.map(row => row.molding_labor), [1, 0, 1, 0]);
  assert.deepEqual(sectionsToSpinData(f).moldParts.map(row => row.shared_mold_labor), [false, true, false, true]);
  const tomy = new ExcelJS.Workbook(); await tomy.xlsx.load(await exportVQ(f));
  const bcd = tomy.getWorksheet('Body Cost Breakdown'); let tomyMatched = 0;
  bcd.eachRow(row => {
    if (['A-right', 'B-right'].includes(row.getCell(2).text)) {
      assert.equal(row.getCell(5).value, 0); assert.equal(row.getCell(6).result, 0); tomyMatched++;
    }
  });
  assert.equal(tomyMatched, 2, 'actual TOMY workbook does not restore subsequent run labor');
  const base = await require('../backend/services/exportXlsx').buildWorkbook(f);
  const baseLoaded = new ExcelJS.Workbook(); await baseLoaded.xlsx.load(await base.xlsx.writeBuffer());
  const baseSheet = baseLoaded.getWorksheet('啤机明细'); let baseMatched = 0;
  baseSheet.eachRow(row => {
    if (['A-right', 'B-right'].includes(row.getCell(2).text)) {
      assert.equal(row.getCell(9).value, 0); baseMatched++;
    }
  });
  assert.equal(baseMatched, 2, 'base export renderer uses the same explicit run rule');
  f.quote.customer = 'SPIN';
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await exportSpin(f));
  let matched = 0;
  wb.eachSheet(sheet => sheet.eachRow(row => {
    if (row.getCell(3).value === 'A-right' || row.getCell(3).value === 'B-right') {
      assert.equal(row.getCell(14).value, 0, '有机型和周期也不生成重复的人工公式');
      matched++;
    }
  }));
  assert.equal(matched, 2);
});

test('全部模具兼容概览与后台小产品计费一致，不改写旧行或目录分阶段价格', () => {
  const fs = require('node:fs'), vm = require('node:vm'), Pricing = require('../frontend/injection-pricing');
  const source = fs.readFileSync(require.resolve('../frontend/mixed-quotation'), 'utf8');
  const first = { mold_no: 'M', name: 'RunHead', source_sheet_name: '表1', source_sheet_index: 0,
    injection_run_id: 'row:2', injection_run_part_index: 0, shot_price: .4 };
  const parts = [first, { ...first, name: 'RunLater', injection_run_part_index: 1, shot_price: .9 },
    { mold_no: 'OLD', name: 'LegacyFixed', mold_part_index: 4, shot_price: .8, shot_price_mode: 'manual' },
    { ...first, mold_no: 'CAT', name: 'CatalogStaged', injection_run_part_index: 1, catalog_raw_weight: 0, shot_price: .7 }];
  const cfg = { enabled: true, mode: 'equal', units_per_pack: 1, products: [
    { id: 'A', code: 'A', name: 'A', ratio: 1 }, { id: 'B', code: 'B', name: 'B', ratio: 1 }] };
  const root = { mixed_products: { A: { injection: parts }, B: {} }, mixed_shared: {}, mixed_molds: [] };
  const before = JSON.stringify(root), host = { innerHTML: '', querySelectorAll: () => [] };
  const context = vm.createContext({ window: { InjectionPricing: Pricing, MixedMolds: require('../frontend/mixed-molds'), __data: { quote: { qty: 1000 } } },
    esc: value => String(value ?? ''), fmt: value => Number(value).toFixed(4) });
  vm.runInContext(source.slice(source.indexOf('  function renderAllMolds('), source.indexOf('  function renderAllEngineeringMolds(')) + '\nglobalThis.render = renderAllMolds;', context);
  context.render(host, root, cfg, () => {});
  for (const [name, value] of [['RunHead', '.4000'], ['RunLater', '.0000'], ['LegacyFixed', '.8000'], ['CatalogStaged', '.7000']]) {
    const row = host.innerHTML.match(new RegExp('<tr>(?:(?!<tr>)[\\s\\S])*?<td>' + name + '</td>(?:(?!<tr>)[\\s\\S])*?</tr>'))?.[0];
    assert.ok(row, name); assert.ok(row.includes('<td>0' + value + '</td>'), name + ' uses the correct labor');
  }
  const sections = [{ dept: 'sales', payload_json: JSON.stringify({ mixed_quote: cfg }) }, { dept: 'molding', payload_json: JSON.stringify(root) }];
  const calculated = require('../backend/services/mixedQuotation').calculateMixedQuote({ qty: 1000 }, sections);
  assert.ok(Math.abs(calculated.products[0].components.injection_labor - 1.9) < 1e-10);
  assert.equal(JSON.stringify(root), before);
});

async function twoRuns({ target = 3200, sets = 1 } = {}) {
  const wb = new ExcelJS.Workbook(), sheet = wb.addWorksheet('排模资料');
  sheet.addRow(['模具编号', '名称', '配件名称', '机型(TON)', '套数', '材料', '净重', '周期', '目标数', '模具价格 RMB']);
  sheet.addRow(['INDEX-260309-05', '左手(转水口)', '左手外侧', '150T', 1, 'ABS', 12, 25, 3200, 5000]);
  sheet.addRow(['', '', '左手内侧', '', '', 'ABS', 9]);
  sheet.addRow(['INDEX-260309-05', '袖圈(转水口)', '左脚袖圈', '150T', sets, 'ABS', 8.1, 25, target]);
  sheet.addRow(['', '', '右脚袖圈', '', '', 'ABS', 8.1]);
  for (const col of ['A', 'B', 'D']) {
    sheet.mergeCells(`${col}2:${col}3`); sheet.mergeCells(`${col}4:${col}5`);
  }
  return require('../backend/services/parseMoldSheet').parseWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
}

test('相同模号分两次啤：导入保留一副模具两组啤次，每组首件计价，汇总与导出算两次', async () => {
  const parsed = await twoRuns(); assert.equal(parsed.error, undefined);
  assert.equal(parsed.molds.length, 1, '实体模具和模费仍只记录一次');
  assert.equal(parsed.molds[0].price_rmb, 5000);
  const rows = expandEngineeringMolds(JSON.parse(JSON.stringify(parsed.molds)));
  assert.deepEqual(rows.map(row => row.mold_part_index), [0, 1, 2, 3]);
  assert.deepEqual(rows.map(row => row.injection_run_part_index), [0, 1, 0, 1]);
  assert.deepEqual(rows.map(row => row.injection_run_name), ['左手(转水口)', '左手(转水口)', '袖圈(转水口)', '袖圈(转水口)']);
  const prices = [{ model: '14A-16A', normal: '150T', price: 1490 }];
  const Pricing = require('../frontend/injection-pricing');
  rows.forEach(row => Pricing.reprice(row, prices));
  assert.deepEqual(rows.map(row => row.shot_price), [.4656, 0, .4656, 0]);
  const f = fixture(); f.sections[0].payload_json = JSON.stringify({ injection: rows, machine_prices: prices });
  assert.equal(buildQuoteSummary(f.quote, f.sections).components_before_tax.injection_labor, .9312);
  const wb = await buildWorkbook(f);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(await wb.xlsx.writeBuffer());
  for (const name of ['报价明细', '啤机明细']) {
    const sheet = loaded.getWorksheet(name); let start;
    sheet.eachRow(row => { if (row.getCell(2).value === '模具名称' && row.getCell(9).value === '啤价 HK$/啤') start = row.number + 1; });
    for (const i of [0, 2]) {
      assert.equal(sheet.getCell(start + i, 9).formula, `ROUND(1490/J${start + i}/L${start + i},4)`);
      assert.equal(sheet.getCell(start + i, 9).result, .4656);
    }
    for (const i of [1, 3]) assert.equal(sheet.getCell(start + i, 9).value, 0);
    assert.equal(sheet.getCell(start + 4, 9).result, .9312);
  }
});

test('从旧版同模一组同步到两次啤，只恢复第二次首件，目标数仍保留', async () => {
  const rows = expandEngineeringMolds((await twoRuns()).molds);
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../frontend/workbench.js'), 'utf8');
  const Pricing = require('../frontend/injection-pricing');
  const context = vm.createContext({ window: { InjectionPricing: Pricing } });
  vm.runInContext(source.slice(source.indexOf('function engineeringMoldSyncKey('), source.indexOf('function engineeringImagesForInjection(')) +
    source.slice(source.indexOf('function syncInjectionMolds('), source.indexOf('// 啤机部料价表默认值')), context);
  const payload = { machine_prices: [{ model: '14A-16A', price: 1490 }], injection: rows.map((row, i) => ({ ...row,
    injection_run_id: undefined, injection_run_name: undefined, injection_run_part_index: undefined,
    target: 3000, shot_price: i ? 0 : .4967, shot_price_mode: 'auto' })) };
  context.syncInjectionMolds(payload, rows);
  assert.deepEqual(Array.from(payload.injection, row => row.target), [3000, 3000, 3000, 3000]);
  assert.deepEqual(Array.from(payload.injection, row => row.shot_price), [.4967, 0, .4967, 0]);
  assert.equal(payload.injection[2].injection_run_name, '袖圈(转水口)');
});


test('同模两次啤独立使用各自的目标数和套数', async () => {
  const rows = expandEngineeringMolds((await twoRuns({ target: 3000, sets: 2 })).molds);
  const Pricing = require('../frontend/injection-pricing');
  const prices = [{ model: '14A-16A', price: 1490 }];
  rows.forEach(row => Pricing.reprice(row, prices));
  assert.deepEqual(rows.map(row => row.target), [3200, 3200, 3000, 3000]);
  assert.deepEqual(rows.map(row => row.sets), [1, 1, 2, 2]);
  assert.deepEqual(rows.map(row => row.shot_price), [.4656, 0, .2483, 0]);
});


test('删除某次啤首件后，剩余首件仍计价且不丢失另一啤次', async () => {
  const molds = (await twoRuns()).molds;
  molds[0].parts.splice(2, 1);
  const rows = expandEngineeringMolds(molds);
  const Pricing = require('../frontend/injection-pricing');
  rows.forEach(row => Pricing.reprice(row, [{ model: '14A-16A', price: 1490 }]));
  assert.deepEqual(rows.map(row => row.injection_run_part_index), [0, 1, 0]);
  assert.deepEqual(rows.map(row => row.shot_price), [.4656, 0, .4656]);
});

test('结构变更只交接准确源表、产品和完整模号下的同次啤，零价与空手填价独立保留', () => {
  const Pricing = require('../frontend/injection-pricing');
  for (const price of [0, null]) for (const mode of [undefined, null, 'manual']) {
    const first = { mold_no: 'M-01', source_sheet_name: '表1', source_sheet_index: 0,
      product_group_id: 'A', injection_run_id: 'row:2', injection_run_part_index: 0,
      shot_price: price, target: 2000, sets: 2, ...(mode === undefined ? {} : { shot_price_mode: mode }) };
    const next = { ...first, injection_run_part_index: 1, shot_price: .9, shot_price_mode: 'auto', name: '保留零件' };
    const otherHeads = [
      { ...first, source_sheet_name: '表2', source_sheet_index: 1, shot_price: 2 },
      { ...first, product_group_id: 'B', shot_price: 3 },
      { ...first, mold_no: 'M-010', shot_price: 4 },
      { ...first, injection_run_id: 'row:8', shot_price: 5 },
    ];
    const beforeOthers = JSON.stringify(otherHeads), previousRows = [first, next, ...otherHeads];
    const rows = previousRows.slice(1);
    assert.deepEqual(Pricing.applyRunStructureChange({ type: 'delete', row: first, rows, previousRows }), { allowed: true, changed: true });
    assert.equal(next.injection_run_part_index, 0); assert.equal(next.shot_price, price);
    assert.equal(next.shot_price_mode, mode);
    assert.equal(Object.hasOwn(next, 'shot_price_mode'), Object.hasOwn(first, 'shot_price_mode'));
    assert.equal(next.target, first.target); assert.equal(next.sets, first.sets);
    assert.equal(next.name, '保留零件'); assert.equal(JSON.stringify(otherHeads), beforeOthers);
  }
});

test('旧零件顺序与缺准确啤次来源不构成零价依据，目录分阶段价格独立保留', () => {
  const Pricing = require('../frontend/injection-pricing');
  const legacy = { mold_no: 'M', mold_part_index: 7, shot_price: .7, shot_price_mode: 'manual' };
  const partial = { ...legacy, injection_run_id: 'row:2', injection_run_part_index: 1 };
  const catalog = { ...partial, source_sheet_name: '表1', source_sheet_index: 0, catalog_raw_weight: 0 };
  for (const row of [legacy, partial, catalog]) {
    assert.equal(Pricing.isAdditionalPart(row), false);
    assert.equal(Pricing.laborPrice(row), .7);
  }
  const explicit = { ...partial, source_sheet_name: '表1', source_sheet_index: 0 };
  for (const invalid of [true, false, [1], { value: 1 }, '1', -1, 1.5, null, undefined]) {
    const malformed = { ...explicit, injection_run_part_index: invalid };
    assert.equal(Pricing.hasRunIdentity(malformed), false, 'non-integer JSON never becomes a billing identity');
    assert.equal(Pricing.laborPrice(malformed), .7);
  }
  assert.equal(Pricing.hasRunIdentity(explicit), true);
});
