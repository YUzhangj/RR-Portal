'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Pricing = require('../frontend/injection-pricing');
const { buildWorkbook } = require('../backend/services/exportInternal');
const source = fs.readFileSync(require.resolve('../frontend/workbench.js'), 'utf8');
const prices = [{ model: '20A', normal: '200T', price: 2020 },
  { model: '10A-12A', normal: '120T', price: 1210 }];

test('four-decimal auto labor uses positive decimal half-up, including exponent and finite extremes', () => {
  const row = { machine_model: '20A', sets: 2, target: 4000 };
  const quote = price => [{ model: '20A', price }];
  assert.equal(Pricing.calculate(row, quote(1490)), .1863);
  assert.equal(Pricing.calculate(row, quote(1489.9999999999)), .1862);
  assert.equal(Pricing.calculate(row, quote(1490.0000000001)), .1863);
  assert.equal(Pricing.calculate(row, quote(0)), 0);
  assert.equal(Pricing.calculate({ ...row, sets: 1, target: 1 }, quote(5e-5)), .0001);
  assert.equal(Pricing.calculate({ ...row, sets: 1, target: 1 }, quote(4.999999e-5)), 0);
  assert.equal(Pricing.calculate({ ...row, sets: 1, target: 1 }, quote(Number.MIN_VALUE)), 0);
  assert.equal(Pricing.calculate({ ...row, sets: 1, target: 1 }, quote(Number.MAX_VALUE)), Number.MAX_VALUE);
  assert.equal(Pricing.calculate({ ...row, sets: 1e-308, target: 1e308 }, quote(1e308)), 1e308);
  assert.equal(Pricing.calculate({ ...row, sets: Number.MIN_VALUE, target: 1 }, quote(Number.MAX_VALUE)), null);
  assert.equal(Pricing.calculate({ ...row, sets: Infinity }, quote(1490)), null);
  const stored = { ...row, shot_price: .1862, shot_price_mode: 'manual' }, before = JSON.stringify(stored);
  assert.equal(Pricing.laborPrice(stored), .1862); assert.equal(JSON.stringify(stored), before);
});
function sync(payload, molds) {
  const context = { window: { InjectionPricing: Pricing } };
  vm.runInNewContext(source.slice(source.indexOf('function engineeringMoldSyncKey('),
    source.indexOf('function engineeringImagesForInjection(')), context);
  vm.runInNewContext(source.slice(source.indexOf('function syncInjectionMolds('),
    source.indexOf('// 啤机部料价表默认值')), context);
  context.syncInjectionMolds(payload, molds);
}

test('01M目标数、套数、机型、台班价变化均重新计算，不保留旧啤价', () => {
  const row = { machine_model: '20A', target: 2600, sets: 1, shot_price: 0.7769 };
  row.target = 1760; Pricing.reprice(row, prices);
  assert.equal(row.shot_price, 1.1477);
  assert.equal(row.shot_price_mode, 'auto');
  row.sets = 2; Pricing.reprice(row, prices);
  assert.equal(row.shot_price, 0.5739);
  row.machine_model = '10A'; Pricing.reprice(row, prices);
  assert.equal(row.shot_price, 0.3438);
  Pricing.reprice(row, [{ model: '10A', price: 1408 }]);
  assert.equal(row.shot_price, 0.4);
});

test('无效公式输入清除旧价，0费用有效，同模后续零件不重复计价', () => {
  for (const patch of [{ target: 0 }, { target: null }, { sets: 0 }, { sets: -1 },
    { machine_model: '未知' }, { machine_model: '200A' }]) {
    const row = { machine_model: '20A', target: 2600, sets: 1, shot_price: 0.7769, ...patch };
    Pricing.reprice(row, prices); assert.equal(row.shot_price, null);
  }
  assert.equal(Pricing.calculate({ machine_model: '20A', target: 1 }, [{ model: '20A', price: 0 }]), 0);
  assert.equal(Pricing.calculate({ mold_part_index: 1, injection_run_id: 'row:2', injection_run_part_index: 1,
    source_sheet_name: '合成工程表', source_sheet_index: 0, mold_no: 'M', machine_model: '20A', target: 2800, sets: 1 },
    [{ model: '20A', price: 1920 }]), 0);
  assert.equal(Pricing.lookupMachinePrice('120A', prices), null);
});

test('未重新导入的旧工程零件保留逐行计费口径', () => {
  const { expandEngineeringMolds } = require('../backend/services/engineeringMolds');
  const { applyCostingBasisPayload } = require('../backend/services/costingBasis');
  const rows = expandEngineeringMolds([{ mold_no: 'INDEX-2', machine_model: '20A',
    target: 2800, sets: 1, parts: [{ name: '左大身' }, { name: '右大身' }] }]);
  assert.deepEqual(rows.map(row => row.shot_price), [null, null]);
  const result = applyCostingBasisPayload('molding', { injection: rows.map(row => ({ ...row, shot_price_mode: 'auto' })) }, {
    machines: [{ model: '20A', price: 1920 }] });
  assert.deepEqual(result.payload.injection.map(row => row.shot_price), [0.6857, 0.6857]);
});

test('编辑及同步移除自动后续重复价，保留手填来源和共模分摊', () => {
  const payload = { injection: [
    { mold_no: 'M', source_sheet_name: '合成工程表', source_sheet_index: 0, injection_run_id: 'row:2', injection_run_part_index: 0,
      mold_part_index: 0, machine_model: '20A', target: 2800, sets: 1, shot_price: 0.6857 },
    { mold_no: 'M', source_sheet_name: '合成工程表', source_sheet_index: 0, injection_run_id: 'row:2', injection_run_part_index: 1,
      mold_part_index: 1, machine_model: '20A', target: 2800, sets: 1, shot_price: .6857, shot_price_mode: 'auto' },
    { mold_no: 'M', source_sheet_name: '合成工程表', source_sheet_index: 0, injection_run_id: 'row:2', injection_run_part_index: 2,
      mold_part_index: 1, machine_model: '20A', target: 3000, sets: 1, shot_price: .64, shot_price_mode: 'auto' },
    { mold_part_index: 1, shot_price_mode: 'manual', machine_model: '20A', target: 3000, shot_price: 0 },
    { mold_part_index: 1, catalog_raw_weight: 1, machine_model: '20A', target: 3000, shot_price: 0.12 },
  ], machine_prices: [{ model: '20A', price: 1920 }] };
  const context = { window: { InjectionPricing: Pricing }, num: value => Number(value) || 0 };
  vm.runInNewContext(source.slice(source.indexOf('function lookupMachinePrice('),
    source.indexOf('function syncInjectionMolds(')), context);
  vm.runInNewContext(source.slice(source.indexOf('function isBlankInjectionPrice('),
    source.indexOf('function renderMolding(')), context);
  const result = context.applyInjectionReferencePrices(payload, { material: false });
  assert.equal(result.changed, true);
  assert.deepEqual(payload.injection.map(row => row.shot_price), [0.6857, 0, 0, 0, 0.12]);
  assert.equal(payload.injection.slice(0, 3).reduce((total, row) => total + row.shot_price, 0), .6857);
});

test('共模分阶段成本不被普通套数公式覆盖', () => {
  const row = { catalog_raw_weight: 0, machine_model: '20A', target: 2600, shot_price: 0.1234 };
  Pricing.reprice(row, prices); assert.equal(row.shot_price, 0.1234);
});

test('工程同步保留10月9日已填目标数与啤价，新行按真实费用算价', () => {
  const targets = [2600, 2400, 3400, 3400, 3200, 3500, 3500];
  const injection = targets.map((target, index) => ({ mold_no: `0${index + 1}M`, name: '零件',
    machine_model: '20A', target, sets: 1, shot_price: Pricing.calculate({ machine_model: '20A', target, sets: 1 }, prices) }));
  const payload = { machine_prices: prices, injection: structuredClone(injection) };
  const molds = injection.map((row, index) => ({ ...row, target: index < 4 ? 1760 : 2640, shot_price: null }));
  molds.push({ mold_no: '08M', name: '新零件', machine_model: '20A', target: 2000, sets: 2 });
  sync(payload, molds);
  assert.deepEqual(Array.from(payload.injection.slice(0, 7), row => row.target), targets);
  assert.deepEqual(Array.from(payload.injection.slice(0, 7), row => row.shot_price), injection.map(row => row.shot_price));
  assert.equal(payload.injection[7].shot_price, 0.505);
});

test('同步时机型变动重算啤价，保留目标0且不沿用旧价', () => {
  const payload = { machine_prices: prices, injection: [{ mold_no: '01M', name: '零件',
    machine_model: '20A', target: 2600, sets: 1, shot_price: 0.7769 }] };
  sync(payload, [{ mold_no: '01M', name: '零件', machine_model: '10A', target: 1760 }]);
  assert.equal(payload.injection[0].target, 2600);
  assert.equal(payload.injection[0].shot_price, 0.4654);
  payload.injection[0].target = 0;
  sync(payload, [{ mold_no: '01M', name: '零件', machine_model: '20A', target: 1760 }]);
  assert.equal(payload.injection[0].target, 0);
  assert.equal(payload.injection[0].shot_price, null);
});

test('工程同步参数未变时保留历史及手填的null、空串、零和既有价，不借用源啤价', () => {
  for (const mode of [undefined, 'manual']) for (const savedPrice of [null, '', 0, .3142]) {
    const row = { mold_no: '01M', name: '既有零件', machine_model: '20A', target: 2600,
      sets: 1, shot_price: savedPrice, ...(mode ? { shot_price_mode: mode } : {}) };
    const payload = { machine_prices: prices, injection: [row] };
    sync(payload, [{ ...row, shot_price: .5 }]);
    assert.equal(payload.injection[0].shot_price, savedPrice, `${mode || 'legacy'} / ${String(savedPrice)}`);
    assert.equal(payload.injection[0].shot_price_mode, mode);
    assert.equal(payload.injection[0].target, 2600);
    assert.equal(payload.injection[0].sets, 1);
  }
});

test('工程同步新行及明确机型变化按本单真实费用计算并记录自动来源', () => {
  const payload = { machine_prices: prices, injection: [{ mold_no: '01M', name: '既有零件',
    machine_model: '20A', target: 2600, sets: 1, shot_price: null, shot_price_mode: 'manual' }] };
  sync(payload, [
    { mold_no: '01M', name: '既有零件', machine_model: '10A', target: 2600, sets: 1, shot_price: .5 },
    { mold_no: '02M', name: '新增零件', machine_model: '20A', target: 2000, sets: 2, shot_price: .5 },
  ]);
  assert.equal(payload.injection[0].shot_price, .4654);
  assert.equal(payload.injection[1].shot_price, .505);
  for (const row of payload.injection) assert.equal(row.shot_price_mode, 'auto');
});

test('导出引用真实2020费用且四舍五入与缓存一致；历史手填价不伪造费用', async () => {
  const rows = [
    { mold_no: '01M', machine_model: '20A', sets: 1, target: 2600, shot_price: 0.7769 },
    { mold_no: '02M', machine_model: '20A', sets: 1, target: 1760, shot_price: 0.7769 },
    { mold_no: '03M', machine_model: '20A', sets: 1, target: 1760, shot_price: 1.1477, shot_price_mode: 'auto' },
    { mold_no: '04M', machine_model: '20A', sets: 1, target: 1760, shot_price: 1.1477, mold_part_index: 1, shot_price_mode: 'auto' },
    { mold_no: '05M', machine_model: '20A', sets: 1, target: 1760, shot_price: 0.5, catalog_raw_weight: 1 },
    { mold_no: '06M', machine_model: '20A', sets: 1, target: 1760, shot_price: 1.1477, shot_price_mode: 'manual' },
  ];
  const payload = { machine_prices: prices, injection: rows };
  const before = JSON.stringify(payload);
  const wb = await buildWorkbook({ quote: { qty: 1000 }, sections: [{ dept: 'molding', payload_json: before }] });
  assert.equal(JSON.stringify(payload), before);
  const loaded = new (require('exceljs').Workbook)();
  await loaded.xlsx.load(await wb.xlsx.writeBuffer());
  for (const name of ['报价明细', '啤机明细']) {
    const ws = loaded.getWorksheet(name); let start;
    ws.eachRow(row => { if (row.getCell(1).value === '模号' && row.getCell(2).value === '模具名称') start = row.number + 1; });
    assert.ok(start);
    assert.equal(ws.getCell(start, 9).value, 0.7769);
    assert.match(ws.getCell(start, 9).note, /固定值/);
    assert.equal(ws.getCell(start + 1, 9).value, 0.7769);
    assert.match(ws.getCell(start + 1, 9).note, /固定值/);
    assert.equal(ws.getCell(start + 2, 9).formula, `ROUND(2020/J${start + 2}/L${start + 2},4)`);
    assert.equal(ws.getCell(start + 2, 9).result, 1.1477);
    assert.equal(ws.getCell(start + 3, 9).formula, `ROUND(2020/J${start + 3}/L${start + 3},4)`);
    assert.equal(ws.getCell(start + 3, 9).result, 1.1477);
    assert.equal(ws.getCell(start + 4, 9).value, 0.5);
    assert.equal(ws.getCell(start + 5, 9).value, 1.1477);
    assert.match(ws.getCell(start + 5, 9).note, /固定值/);
  }
});

test('进入页面仅补明确自动行，不覆盖历史值及未标记/手填空值；明确套价记录自动来源', () => {
  const context = { window: { InjectionPricing: Pricing }, num: value => Number(value) || 0,
    isBlankInjectionPrice: value => value == null || value === '', lookupMachinePrice: Pricing.lookupMachinePrice };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function applyInjectionReferencePrices('), source.indexOf('function renderMolding(')), context);
  const payload = { machine_prices: prices, injection: [
    { machine_model: '20A', sets: 1, target: 2600, shot_price: .7769 },
    { machine_model: '20A', sets: 1, target: 2600, shot_price: .7769, shot_price_mode: 'manual' },
    { machine_model: '20A', sets: 1, target: 2600, shot_price: null, shot_price_mode: 'manual' },
    { machine_model: '20A', sets: 1, target: 2600, shot_price: null },
    { machine_model: '20A', sets: 1, target: 2600, shot_price: null, shot_price_mode: 'auto' },
  ] };
  context.applyInjectionReferencePrices(payload, { material: false });
  assert.equal(payload.injection[0].shot_price_mode, undefined);
  assert.equal(payload.injection[1].shot_price_mode, 'manual');
  assert.equal(payload.injection[2].shot_price, null);
  assert.equal(payload.injection[2].shot_price_mode, 'manual');
  assert.equal(payload.injection[3].shot_price, null);
  assert.equal(payload.injection[3].shot_price_mode, undefined);
  assert.equal(payload.injection[4].shot_price, .7769);
  assert.equal(payload.injection[4].shot_price_mode, 'auto');
  context.applyInjectionReferencePrices(payload, { overwrite: true, material: false });
  for (const row of payload.injection) {
    assert.equal(row.shot_price, .7769); assert.equal(row.shot_price_mode, 'auto');
  }
  context.payload = { injection: [], machine_prices: prices };
  context.refMolds = [{ name: '工程新增行', machine_model: '20A', sets: 1, target: 2600 }];
  context.canEdit = true;
  const initialStart = source.indexOf('  // 首次进入时若注塑表为空且工程已有模具');
  vm.runInContext(source.slice(initialStart, source.indexOf('  // 已有本单参考表', initialStart)), context);
  context.applyInjectionReferencePrices(context.payload, { material: false });
  assert.equal(context.payload.injection[0].shot_price, .7769);
  assert.equal(context.payload.injection[0].shot_price_mode, 'auto');
});
