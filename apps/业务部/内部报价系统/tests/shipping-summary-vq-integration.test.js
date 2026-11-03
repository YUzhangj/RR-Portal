const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '../frontend');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function element() {
  let html = '';
  const nodes = new Map();
  return {
    textContent: '', style: {}, dataset: {}, disabled: false,
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; nodes.clear(); },
    querySelector(selector) {
      // These old manual-summary inputs are absent from the current renderer.
      if (selector === '#tot-surtax' || selector === '#tot-markup') return null;
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    insertAdjacentHTML(_position, value) { html += value; },
    appendChild(child) { return child; },
    before() {},
  };
}
function setup(send) {
  const requests = [];
  const context = vm.createContext({
    document: { getElementById() { return null; }, createElement: element, activeElement: null },
    setTimeout, clearTimeout, alert() {}, __WORKBENCH_EMBED__: true,
    FormulaInput: { parseFormulaInput: Number, toExcelFormulaInput: String },
  });
  context.window = context;
  // Evaluate the complete scripts in the same order as quote.html, suppressing
  // only the automatic page fetch. HTTP and DOM are isolated test doubles.
  for (const name of ['workbench.js', 'vq-extension.js']) {
    vm.runInContext(fs.readFileSync(path.join(frontend, name), 'utf8'), context, { filename: name });
  }
  context.api = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return send ? send(body, requests.length) : { filled_at: 'v' + requests.length };
  };
  const section = {
    id: 7, dept: 'sales', status: 'empty', filled_at: 'v0',
    payload_json: JSON.stringify({
      header: { currency: 'HKD', fx_rmb_hkd: .85, fx_hkd_usd: 7.8 },
      pricing_summary: { surtax: .1 },
      shipping: { scenarios: [], markup_x: 1.2, divisor: .98 },
    }),
  };
  // renderQuotePage obtains the business draft before mounting the summary.
  const business = context.sectionDraft(section);
  const host = element(), dirty = [];
  host.onShippingSummaryDirty = value => dirty.push(value);
  const me = { dept: 'sales', perms: Object.fromEntries(
    ['报价单详情', '业务部', '汇总分析'].map(name => [name, { can_view: true, can_edit: true }]),
  ) };
  const quote = { id: 1, qty: 1 };
  context.__data = { sections: [section], quote_locked: false };
  const render = () => context.renderSummaryPane(host, [section], quote, me);
  const input = () => host.querySelector('#wb-shipping-sum').querySelector('#sh-markup');
  const status = () => host.querySelector('#shipping-summary-save').querySelector('[data-shipping-save-status]');
  const edit = value => { input().value = String(value); input().oninput(); };
  render();
  return { context, requests, section, business, host, dirty, render, status, edit };
}

test('实际 VQ 扩展加载后，业务保存不会覆盖汇总已确认的算价参数', async () => {
  const s = setup();
  s.edit(1.8);
  await s.host.saveShippingSummary();
  assert.equal(s.requests.at(-1).payload.shipping.markup_x, 1.8);
  assert.equal(s.business.shipping.markup_x, 1.8);
  s.business.header.currency = 'USD';
  await s.context.putSection(s.section, s.business, false);
  assert.equal(s.requests.at(-1).payload.header.currency, 'USD');
  assert.equal(s.requests.at(-1).payload.shipping.markup_x, 1.8);
  assert.equal(s.requests.at(-1).payload.pricing_summary.surtax, .1, '保留旧字段原币值，不做过时汇率转换');
  assert.equal(s.requests.at(-1).payload.__surtax_hkd_adapter, undefined);
});

test('实际 VQ 扩展加载后，失败不提前更新缓存，重新进入汇总保留错误和草稿', async () => {
  let fail = true;
  const gate = deferred();
  const s = setup(async () => {
    await gate.promise;
    if (fail) throw Error('网络连接失败');
    return { filled_at: 'v1' };
  });
  const original = s.section.payload_json;
  s.edit(1.9);
  await tick();
  assert.equal(s.section.payload_json, original, '等待应答时不得提前更新已保存缓存');
  gate.resolve();
  await assert.rejects(() => s.host.saveShippingSummary(), /网络连接失败/);
  assert.equal(s.section.payload_json, original);
  assert.equal(s.business.shipping.markup_x, 1.9);
  s.render();
  assert.match(s.status().textContent, /网络连接失败/);
  assert.equal(s.dirty.at(-1), true);
  fail = false;
  await s.host.saveShippingSummary();
  assert.equal(JSON.parse(s.section.payload_json).shipping.markup_x, 1.9);
  assert.equal(s.dirty.at(-1), false);
});

test('实际 VQ 扩展加载后，保存期间重渲染仍等待同一请求并保留 dirty 状态', async () => {
  const gate = deferred();
  const s = setup(async () => { await gate.promise; return { filled_at: 'v1' }; });
  s.edit(2);
  await tick();
  s.render();
  assert.equal(s.dirty.at(-1), true);
  assert.match(s.status().textContent, /正在保存/);
  let flushed = false;
  const flush = s.host.saveShippingSummary().then(() => { flushed = true; });
  await tick();
  assert.equal(flushed, false);
  assert.equal(s.requests.length, 1);
  gate.resolve();
  await flush;
  assert.equal(s.dirty.at(-1), false);
  assert.match(s.status().textContent, /已保存/);
  assert.equal(JSON.parse(s.section.payload_json).shipping.markup_x, 2);
});

test('报价入口更新 VQ 脚本版本，核价页保留原有嵌入入口', () => {
  const quote = fs.readFileSync(path.join(frontend, 'quote.html'), 'utf8');
  const verification = fs.readFileSync(path.join(frontend, 'verification.html'), 'utf8');
  assert.ok(quote.includes('vq-extension.js?v=20261021-shipping-save-v2'));
  assert.ok(quote.indexOf('workbench.js?v=') < quote.indexOf('vq-extension.js?v='));
  assert.ok(verification.includes('window.__WORKBENCH_EMBED__ = true'));
  assert.ok(!verification.includes('vq-extension.js'), '核价页未加载 VQ，不新增无关扩展');
});

for (const legacy of [
  { formula_mode: 'itemized_v1', formula_markup_x: 1.2, formula_offsets: { other_buy: 10 } },
  { summary_only: true, source_cost_including_labor: 10, source_cost_excluding_labor: 10 },
  { excel_model: { source: 'synthetic' } },
]) test(`VQ扩展保留历史汇总路径与原始税费字段：${legacy.formula_mode || (legacy.summary_only ? 'summary_only' : 'excel_model')}`, () => {
  const s = setup();
  const original = { header: { fx_rmb_hkd: .85 }, legacy_import: legacy, pricing_summary: { surtax: .1 } };
  const section = { ...s.section, id: 8, payload_json: JSON.stringify(original) };
  const persisted = section.payload_json;
  const host = element();
  const sections = [section];
  s.context.__data = { sections };
  let excelSections;
  s.context.ExcelValuation = { renderSummary(_host, values) { excelSections = values; return 'excel-summary'; } };
  const result = s.context.renderSummaryPane(host, sections, { id: 2, qty: 1 }, {});
  if (legacy.excel_model) {
    assert.equal(result, 'excel-summary');
    assert.equal(excelSections, sections);
  } else {
    assert.equal(result.total, 10);
    assert.equal(s.context.sectionDraft(section).pricing_summary.surtax, .1);
  }
  assert.equal(section.payload_json, persisted, '汇总不重写历史持久化字段或提前更新缓存');
  assert.equal(s.requests.length, 0);
});
