const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/workbench.js'), 'utf8');
const taxCode = source.slice(source.indexOf('function renderTaxDeductionBlock('), source.indexOf('function hasSlushCostingInputs('));
test('comparison financial values preserve source precision independently of display rounding', () => {
  const context = vm.createContext({ num: v => Number(v) || 0, formatNum: v => Number(v).toFixed(2) });
  vm.runInContext(taxCode, context);
  const values = { injection_labor: 2.877123456, painting_labor: 0.0836266666666667, carton: 1.461234567, imp_mat: 3.978912345 };
  const host = { innerHTML: '', querySelector: () => null };
  const result = context.renderTaxDeductionBlock(host, {}, null, {}, values);
  for (const [key, value] of Object.entries(values)) assert.equal(result.financial.fields[key], value);
  assert.equal(result.financial.noLabor, values.carton + values.imp_mat);
  assert.equal(result.financial.taxRows.find(r => r.key === 'carton').base, values.carton);
  assert.equal(result.financial.taxRows.find(r => r.key === 'carton').deduction, values.carton / 1.1 * 11.5 / 100);
  const edited = context.renderTaxDeductionBlock(host, {}, null, {}, { ...values, carton: values.carton + 0.01 });
  assert.ok(Math.abs(edited.financial.fields.carton - result.financial.fields.carton - 0.01) < 1e-12);
});
test('all non-native summary branches expose structured financial values', () => {
  const code = source.slice(source.indexOf('function renderSummaryPane('), source.indexOf('function renderTaxDeductionBlock('));
  assert.equal((code.match(/financial:/g) || []).length, 3);
});
