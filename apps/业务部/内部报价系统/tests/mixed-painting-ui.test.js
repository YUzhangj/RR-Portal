'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { calculateSingleQuoteCosts } = require('../backend/services/quoteCostSummary');

// A small DOM harness exercises the actual wrapper and add-product event handlers.
// Browser geometry and native inputs are verified separately by the offline UI fixture.
class Element {
  constructor() { this.children = []; this.nodes = new Map(); this.listeners = {}; this.style = {}; this.dataset = {}; }
  set innerHTML(value) { this.html = value; this.nodes.clear(); }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child) { this.children.push(child); }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
  querySelectorAll() { return []; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}

function load(config) {
  const summaries = [], state = {};
  const window = {
    __data: { quote: { id: 1, qty: 5000 }, mixed_quote: config, sections: [] },
    MixedMolds: { validateConfig: value => { state.validated = value; throw new Error('stop before network'); } },
    renderPaintingTable: (_host, view, changed, edit) => { Object.assign(state, { view, changed, edit }); },
    weightedPaintingSum: value => (value.painting_items || []).reduce((sum, row) => sum + Number(row.clamp_qty || 0) * Number(row.clamp_unit || 0), 0),
    renderLossSummary: (_host, title, raw, loss, fx, currency, indo) => {
      const summary = { title, raw, loss, fx, currency, indo, refreshes: 0 }; summaries.push(summary);
      return () => summary.refreshes++;
    },
  };
  const context = vm.createContext({ window, crypto: { getRandomValues: bytes => bytes.fill(7) }, Uint8Array,
    document: { createElement: () => new Element(), querySelector: () => null },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/mixed-quotation.js'), 'utf8'), context);
  return { window, state, summaries };
}

const config = () => ({ enabled: true, version: 1, mode: 'equal', units_per_pack: 1, products: [
  { id: 'a', code: 'A', name: '<img src=x onerror=alert(1)>', ratio: 1 },
  { id: 'b', code: 'B', name: '产品乙', ratio: 1 },
] });
const rootPayload = () => ({ mixed_products: {
  a: { indo_pct: 12, painting_items: [{ name: '甲', note: '甲备注', clamp_qty: 1, clamp_unit: 10 }] },
  b: { indo_pct: 20, painting_items: [{ name: '乙', note: '乙备注', clamp_qty: 2, clamp_unit: 5 }] },
}, mixed_shared: { indo_pct: 8, painting_items: [{ name: '共用', note: '共用备注', clamp_qty: 1, clamp_unit: 4 }] }, preserved_note: '保留其他部门资料' });

test('HTTP contexts without randomUUID can still add a mixed product', async () => {
  const cfg = config(); cfg.products = [];
  const { window, state } = load(cfg), host = new Element();
  window.MixedQuotation.salesPanel(host, { mixed_quote: cfg }, { id: 1 }, true,
    [{ id: 1, dept: 'sales', status: 'filled' }], () => {});
  const panel = host.children[0];
  panel.querySelector('.mixed-add').listeners.click();
  assert.match(panel.innerHTML, /data-product="0"/);
  await panel.querySelector('.mixed-save-config').listeners.click({ target: {} });
  assert.equal(state.validated.products.length, 1);
  assert.match(state.validated.products[0].id, /^p_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('one mixed painting table retains per-product and shared freight costs', () => {
  const { window, state, summaries } = load(config()), root = rootPayload(), host = new Element(); let changes = 0;
  window.MixedQuotation.wrap(() => assert.fail('overall view must use one table'), 'painting')(
    host, root, true, () => changes++, .85);
  assert.equal(state.view.painting_items.length, 3);
  assert.equal(summaries.length, 3);
  assert.deepEqual(summaries.map(row => row.indo.host.indo_pct), [12, 20, 8]);
  assert.deepEqual(summaries.map(row => row.indo.base()), [3, 3, 1.2]);
  assert.equal(summaries.every(row => !row.indo.readonly), true);
  assert.equal(summaries[0].title.includes('<img'), false);
  assert.match(summaries[0].title, /&lt;img/);
  const costs = payload => calculateSingleQuoteCosts({ qty: 5000 }, [{ dept: 'painting', payload_json: JSON.stringify(payload) }], {mixed:true}).components.misc;
  assert.equal(costs(root.mixed_products.a), .36);
  summaries[0].indo.host.indo_pct = 25; summaries[0].indo.onChange();
  summaries[2].indo.host.indo_pct = 30; summaries[2].indo.onChange();
  assert.equal(costs(root.mixed_products.a), .75);
  assert.equal(costs(root.mixed_products.b), .6);
  assert.equal(costs(root.mixed_shared), .36);
  assert.equal(changes, 2);
  assert.equal(root.preserved_note, '保留其他部门资料');
});

test('moving a painting row refreshes the correct summaries and preserves unrelated fields', () => {
  const { window, state, summaries } = load(config()), root = rootPayload(), host = new Element();
  window.MixedQuotation.wrap(() => {}, 'painting')(host, root, true, () => {}, .85);
  state.view.painting_items[0].mixed_product_id = 'b'; state.view.painting_items[0].name = '修改甲';
  state.changed();
  assert.equal(root.mixed_products.a.painting_items.length, 0);
  assert.equal(root.mixed_products.b.painting_items.length, 2);
  assert.equal(root.mixed_products.b.painting_items[0].name, '修改甲');
  assert.equal(root.mixed_products.b.painting_items[0].note, '甲备注');
  assert.equal('mixed_product_id' in root.mixed_products.b.painting_items[0], false);
  assert.equal(root.mixed_shared.painting_items[0].note, '共用备注');
  assert.equal(root.mixed_products.a.indo_pct, 12);
  assert.equal(root.mixed_products.b.indo_pct, 20);
  assert.equal(root.mixed_shared.indo_pct, 8);
  assert.deepEqual(summaries.map(row => row.raw()), [0, 20, 4]);
  assert.deepEqual(summaries.map(row => row.refreshes), [1, 1, 1]);
});

test('read-only mixed painting keeps freight parameters visible and disabled for empty products too', () => {
  const { window, state, summaries } = load(config()), root = { mixed_products: {}, mixed_shared: {} };
  window.MixedQuotation.wrap(() => {}, 'painting')(new Element(), root, false, () => {}, .85);
  assert.equal(state.edit, false);
  assert.equal(state.view.painting_items.length, 0);
  assert.equal(summaries.length, 3);
  assert.equal(summaries.every(row => row.indo.readonly && row.raw() === 0), true);
});
