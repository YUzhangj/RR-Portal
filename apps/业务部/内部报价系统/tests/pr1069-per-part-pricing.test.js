 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Pricing = require('../frontend/injection-pricing');
const { expandEngineeringMolds } = require('../backend/services/engineeringMolds');
const { applyCostingBasisPayload } = require('../backend/services/costingBasis');
const { buildWorkbook } = require('../backend/services/exportInternal');
const { calculateQuoteCosts } = require('../backend/services/quoteCostSummary');
const source = fs.readFileSync(require.resolve('../frontend/workbench.js'), 'utf8');
const prices = [{ model: '20A', normal: '200T', price: 1920 }];
function renderOpening(payload, canEdit = true) {
  const context = vm.createContext({ payload, canEdit, refMolds: [], window: { InjectionPricing: Pricing,
    __refs: { _loaded: true, _ready: true } }, num: value => Number(value) || 0,
    defaultMachinePricesForFactory: () => prices, DEFAULT_MATERIAL_PRICES: [] });
  vm.runInContext(source.slice(source.indexOf('function lookupMachinePrice('), source.indexOf('function syncInjectionMolds(')), context);
  vm.runInContext(source.slice(source.indexOf('function isBlankInjectionPrice('), source.indexOf('function renderMolding(')), context);
  const begin = source.indexOf('function renderMolding('), end = source.indexOf('  const canEditPrices', begin);
  vm.runInContext(source.slice(begin, end) + '\nreturn payload;\n}', context);
  vm.runInContext('renderMolding(null, payload, canEdit, () => {}, refMolds, 1, "staff")', context);
  return context;
}
function row(price, mode) { return { mold_no: 'PR1069-M', name: 'Synthetic part', mold_part_index: 1,
  machine_model: '20A', machine: '200T', target: 2800, sets: 1, material_unit_price: 0,
  shot_price: price, ...(mode === undefined ? {} : { shot_price_mode: mode }) }; }
function payload(rows) { return { material_prices: [{ name: 'Synthetic', model: 'Fixture', price: 0 }], machine_prices: prices, injection: rows }; }
for (const mode of [undefined, null, 'manual']) test(`opening editable department preserves historical zero with origin=${String(mode)}`, () => {
  const p = payload([row(0, mode)]), before = structuredClone(p.injection);
  renderOpening(p);
  assert.deepEqual(p.injection, before, 'opening without input or explicit pricing action must not rewrite a fixed/unmarked zero');
});

test('explicit auto later part calculates, readonly opening remains fixed, explicit button can opt legacy zero into auto', () => {
  const editable = payload([row(0, 'auto')]); renderOpening(editable);
  assert.equal(editable.injection[0].shot_price, .6857);
  const readonly = payload([row(0, 'auto')]); renderOpening(readonly, false);
  assert.equal(readonly.injection[0].shot_price, 0);
  const legacy = payload([row(0)]), context = renderOpening(legacy);
  vm.runInContext('applyInjectionReferencePrices(payload, { overwrite: true, material: false })', context);
  assert.equal(legacy.injection[0].shot_price, .6857); assert.equal(legacy.injection[0].shot_price_mode, 'auto');
});

test('every new engineering part receives labor while explicit zero and staged shared allocation remain fixed', () => {
  const original = [{ mold_no: 'PR1069-NEW', machine_model: '20A', target: 2800, sets: 1,
    parts: [{ name: 'Synthetic left' }, { name: 'Synthetic right' }, { name: 'Explicit zero', shot_price: 0 }] }];
  const before = JSON.stringify(original), expanded = expandEngineeringMolds(original);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(expanded.map(r => r.shot_price), [null, null, 0]);
  const p = payload(expanded.map(r => ({ ...r, material_unit_price: 0, ...(r.shot_price == null ? { shot_price_mode: 'auto' } : { shot_price_mode: 'manual' }) })));
  const shared = { ...row(.1234, 'auto'), catalog_raw_weight: 0, catalog_part_id: 'PR1069-STAGED', technical: { stage: [1, 2] } };
  p.injection.push(shared); const sharedBefore = structuredClone(shared);
  renderOpening(p);
  assert.deepEqual(p.injection.map(r => r.shot_price), [.6857, .6857, 0, .1234]);
  assert.deepEqual(p.injection[3], sharedBefore);
  const recost = applyCostingBasisPayload('molding', structuredClone(p), { machines: [{ model: '20A', normal: '200T', price: 2800 }] }).payload;
  assert.deepEqual(recost.injection.map(r => r.shot_price), [1, 1, 0, .1234]);
  assert.deepEqual(recost.injection[3], sharedBefore);
  const summarize = value => calculateQuoteCosts({ qty: 1000 }, [{ dept: 'molding', payload_json: JSON.stringify(value) }]).components.injection_labor;
  assert.ok(Math.abs(summarize(p) - 1.4948) < 1e-10, `real summary ${summarize(p)} charges both parts plus the separate staged allocation`);
  assert.ok(Math.abs(summarize(recost) - 2.1234) < 1e-10);
  const mixed = { ...p, product_mix_ratios: { A: 3, B: 1 }, injection: p.injection.map((r, i) => ({ ...r, product_group_id: i < 3 ? 'A' : 'B' })) };
  assert.ok(Math.abs(summarize(mixed) - 1.0594) < 1e-10, 'same-mold parts sum within their product before the existing mix weighting');
});

test('opening and export keep historical zero consistent; each explicit auto part exports its own real-fee formula', async () => {
  const p = payload([row(0), { ...row(.6857, 'auto'), mold_no: 'PR1069-AUTO-1' },
    { ...row(.6857, 'auto'), mold_no: 'PR1069-AUTO-2', mold_part_index: 2 }]);
  renderOpening(p);
  const wb = await buildWorkbook({ quote: { qty: 1000 }, sections: [{ dept: 'molding', payload_json: JSON.stringify(p) }] });
  const loaded = new (require('exceljs').Workbook)(); await loaded.xlsx.load(await wb.xlsx.writeBuffer());
  for (const name of ['报价明细', '啤机明细']) {
    const ws = loaded.getWorksheet(name); let start;
    ws.eachRow(r => { if (r.getCell(1).value === '模号' && r.getCell(2).value === '模具名称') start = r.number + 1; });
    assert.ok(start); assert.equal(ws.getCell(start, 9).value, 0); assert.equal(ws.getCell(start, 9).formula, undefined);
    for (const index of [1, 2]) {
      assert.equal(ws.getCell(start + index, 9).formula, `ROUND(1920/J${start + index}/L${start + index},4)`);
      assert.equal(ws.getCell(start + index, 9).result, .6857);
    }
  }
});
