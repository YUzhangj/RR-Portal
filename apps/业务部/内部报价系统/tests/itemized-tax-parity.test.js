'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildQuoteSummary, buildSummaryWorkbook } = require('../backend/services/quoteSummary');
const SewingTax = require('../frontend/sewing-tax');
const source = fs.readFileSync(path.join(__dirname, '../frontend/workbench.js'), 'utf8');
const quote = {id: 1, quote_no: 'SYNTHETIC', factory_code: 'qingxi', qty: 10};
const amounts = { imp_mat: 7, dom_mat: 11, blow: 13, slush: 17, sewing_hair: 19,
  sewing_cloth: 23, hardware: 29, electronic: 31, motor: 37, suction: 41,
  glue_bag: 43, color_box: 47, battery: 53, libao: 59, plating: 61, flocking: 67,
  other_buy: 71, carton: 73, freight: 79, cabinet: 83, misc: 89,
  injection_labor: 97, painting_labor: 101, paint_material: 103, assembly_labor: 107,
  abs_cost: 109 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function fixture(values) {
  const payloads = {
    sales: {header: {fx_rmb_hkd: .87, fx_hkd_usd: 7.8},
      legacy_import: {formula_mode: 'itemized_v1', formula_markup_x: 1.234567,
        formula_offsets: Object.fromEntries(Object.keys(amounts).map(key => [key, 0])),
        source_cost_including_labor: 999, source_pricing_summary: {original: true},
        tax_reference: {snapshot: {deduction: 999, after_cost: 999}}},
      pricing_summary: {t1: {base_price: 999}, t2: {misc: 999}, t3: {}, t4: {tax13b: {rate: 999}}}},
    engineering: {legacy_items: Object.entries(values).map(([cost_category, value]) => ({
      cost_category, include_in_summary: true, formula_kind: 'quantity_x_unit',
      formula_quantity: 2, formula_unit_hkd: value / 2, current_hkd: 999,
    }))},
    sewing: {sewing_groups: [
      {category: '车发', tax_label: '含税', items: [{usage: 1, mat_price: 1}]},
      {category: '车发', tax_label: '不含税', items: [{usage: 1, mat_price: 3}]},
      {category: '车衣', tax_label: '含税', items: [{usage: 1, mat_price: 3}]},
      {category: '车衣', tax_label: '不含税', items: [{usage: 1, mat_price: 1}]},
    ]},
  };
  return Object.entries(payloads).map(([dept, payload]) => ({dept, payload_json: JSON.stringify(payload)}));
}
function page(sections) {
  const context = vm.createContext({window: {__data: {sections}, SewingTax},
    num: value => Number(value) || 0, formatNum: String,
    globalCostingBasis: () => ({exchange: {rmb_hkd: .87}}),
    defaultAssemblyBaseRateForFactory: () => 310,
    renderLegacyPricingTail: () => {},
  });
  for (const [start, end] of [
    ['function legacyFormulaAmount(', 'function renderLegacyItems('],
    ['function legacyFormulaComponents(', '// ============== 汇总面板'],
    ['function renderSummaryPane(', '// ============== 汇总 · 减税明细 4 表'],
    ['function renderTaxDeductionBlock(', 'function hasSlushCostingInputs('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {innerHTML: '', querySelector: () => null});
    return nodes.get(selector);
  };
  const host = {innerHTML: '', querySelector: node};
  return {context, host, nodes, result: context.renderSummaryPane(host, sections, quote, {})};
}
for (const sign of [1, -1, 0]) {
  test(`live itemized page and report agree across all categories with signed multiplier ${sign}`, () => {
    const values = Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, value * sign]));
    const sections = fixture(values), original = JSON.stringify(sections);
    const front = page(sections), back = buildQuoteSummary(quote, sections);
    near(front.result.total, back.summary_values.cost_with_labor);
    near(front.result.totalDeduction, back.summary_values.rebate_reduction);
    near(front.result.afterDeduction, back.summary_values.cost_after_rebate);
    near(front.result.financial.noLabor, back.summary_values.cost_without_labor);
    const rows = Object.fromEntries(front.result.financial.taxRows.map(row => [row.key, row]));
    for (const [key, backendKey] of Object.entries({labor13: 'labor_13_cost', tax13: 'tax_13_cost',
      carton: 'carton_13_cost', tax1: 'tax_1_cost', slush3: 'slush_3_cost',
      sewhair13: 'hair_13_cost', sewcloth13: 'cloth_13_cost', suction6: 'suction_6_cost', freight9: 'freight_9_cost'})) {
      near(rows[key].base, back.summary_values[backendKey]);
    }
    near(rows.sewhair13.base, values.sewing_hair * .25);
    near(rows.sewcloth13.base, values.sewing_cloth * .75);
    near(rows.labor13.deduction, (values.injection_labor + values.painting_labor + values.assembly_labor) * .08 * .115);
    assert.ok(front.nodes.get('#legacy-tax-deduction-block').innerHTML.includes('人工类13%（人工×8%）'));
    assert.equal(JSON.stringify(sections), original, 'rendering must not rewrite persisted source or historical snapshots');
  });
}
test('live miscellaneous purchase cost remains non-taxable despite the old imported custom tax layout', () => {
  const sections = fixture({misc: 100}), front = page(sections).result, back = buildQuoteSummary(quote, sections);
  near(front.total, 100); near(front.totalDeduction, 0); near(front.afterDeduction, 100);
  near(back.summary_values.rmb_purchase_cost, 100); near(back.summary_values.tax_13_cost, 0);
  near(back.summary_values.rebate_reduction, 0);
});
test('labor-only regression has matching 0.92 deduction and leaves ordinary shared-table behavior unchanged', () => {
  const sections = fixture({assembly_labor: 100}), front = page(sections);
  near(front.result.totalDeduction, .92); near(front.result.afterDeduction, 99.08);
  const plain = {innerHTML: '', querySelector: () => null};
  const ordinary = front.context.renderTaxDeductionBlock(plain, {}, null, {}, {assembly_labor: 100});
  near(ordinary.totalDeduction, 0); near(ordinary.afterDeduction, 100);
  assert.ok(!ordinary.financial.taxRows.some(row => row.key === 'labor13'));
  assert.ok(!plain.innerHTML.includes('人工类13%（人工×8%）'));
});

test('saved report formulas keep the same all-category deduction as the actual live page', async () => {
  const sections = fixture(amounts), front = page(sections).result;
  const report = buildQuoteSummary(quote, sections);
  const workbook = buildSummaryWorkbook([report]);
  const saved = new (require('exceljs').Workbook)();
  await saved.xlsx.load(await workbook.xlsx.writeBuffer());
  const worksheet = saved.getWorksheet('各客报价汇总');
  const cell = label => worksheet.getCell(5, worksheet.getRow(4).values.indexOf(label));
  const cells = {};
  worksheet.eachRow(row => row.eachCell(current => {
    cells['s!' + current.address] = {v: current.formula ? current.result : current.value,
      ...(current.formula ? {f: current.formula} : {})};
  }));
  const evaluator = require('../frontend/excel-formulas').createEvaluator({cells});
  for (const [label, expected] of [
    ['人工类13%成本', report.summary_values.labor_13_cost],
    ['含税13%成本', report.summary_values.tax_13_cost],
    ['总退税可减少成本', front.totalDeduction],
    ['退税及返点后总成本（含人工）', front.afterDeduction],
  ]) {
    const actual = cell(label);
    near(actual.result, expected);
    near(evaluator.value('s!' + actual.address), expected);
  }
});
