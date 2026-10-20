'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/workbench.js'), 'utf8');
const start = source.indexOf('function renderLegacyTaxSummary(');
const end = source.indexOf('\nfunction num(', start);
assert.ok(start >= 0 && end > start);

// Synthetic source values keep customer pricing out of the public repository.
const originalPricing = {t1:{base_price:20,imp_mat:2,dom_mat:3},t2:{misc:1,carton:1},t3:{injection_labor:1,assembly_labor:2},t4:{}};
const sourceLegacy = {source_cost_including_labor:10,source_cost_excluding_labor:7};

function render(legacy, pricing, totalCost, live) {
  const blocks = [];
  const context = {
    num: value => Number(value) || 0,
    document: { createElement: () => ({ innerHTML: '', style: {} }) },
  };
  vm.runInNewContext(`${source.slice(start, end)}\nthis.renderTax = renderLegacyTaxSummary`, context);
  const host = { querySelector: () => null, appendChild: block => blocks.push(block) };
  context.renderTax(host, legacy, pricing, { totalCost }, live);
  return blocks[0]?.innerHTML || '';
}

test('imported customer summary exposes costs, deductions and RMB purchase totals', () => {
  const html = render(sourceLegacy, originalPricing, 10, false);
  for (const heading of ['一、货价与材料', '二、包装与外购', '三、人工与总成本', '四、减税明细', '人民币外购件成本', '减税后成本']) {
    assert.ok(html.includes(heading), heading);
  }
  assert.ok(html.includes('按已导入成本和统一减税口径测算'));
});
