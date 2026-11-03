const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Element {
  constructor() { this.children = []; this.nodes = new Map(); this.listeners = {}; this.dataset = {}; this.disabled = false; }
  set innerHTML(value) { this.html = value; this.nodes.clear(); }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.children.push(child); }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
  querySelectorAll() { return []; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}

function setup({ configFailure = false, gate } = {}) {
  const cfg = { enabled: true, version: 1, mode: 'equal', units_per_pack: 1,
    products: [{ id: 'a', code: 'A', name: '原产品', ratio: 1 }, { id: 'b', code: 'B', name: '产品乙', ratio: 1 }] };
  const payload = { mixed_quote: cfg, header: { currency: 'HKD' } };
  const section = { id: 7, dept: 'sales', filled_at: 'v0', payload_json: JSON.stringify(payload) };
  const requests = [];
  let version = 'v0', configAttempts = 0, reloads = 0;
  const send = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.includes('/sections/')) {
      if (gate && requests.length === 1) await gate;
      if (body.base_filled_at !== version) throw Error('该部门资料已更新，本次未覆盖。');
      version = 'v' + (Number(version.slice(1)) + 1);
      return { ok: true, filled_at: version };
    }
    configAttempts++;
    if (configFailure && configAttempts === 1) throw Error('修改混装产品或比例前，请先解除各部门审核');
    return { ok: true };
  };
  const window = { MixedMolds: require('../frontend/mixed-molds'), __data: { sections: [section] } };
  const context = vm.createContext({ window, Map, Promise, alert() {}, api: send,
    document: { createElement: () => new Element(), querySelector: () => null, querySelectorAll: () => [] },
    location: { reload() { reloads++; } },
    fetch: async (url, options) => {
      try { const data = await send(url, options); return { ok: true, json: async () => data }; }
      catch (error) { return { ok: false, json: async () => ({ error: error.message }) }; }
    },
  });
  const workbench = fs.readFileSync(path.join(__dirname, '../frontend/workbench.js'), 'utf8');
  const start = workbench.indexOf('const sectionSaveQueues');
  vm.runInContext(workbench.slice(start, workbench.indexOf('// ====================', start)), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/mixed-quotation.js'), 'utf8'), context);
  const host = new Element();
  window.MixedQuotation.salesPanel(host, payload, { id: 12 }, true, [section], () => {}, context.putSection);
  const panel = host.children[0], button = panel.querySelector('.mixed-save-config');
  const click = () => button.listeners.click({ target: button });
  return { context, panel, button, click, section, payload, requests,
    setServerVersion(value) { version = value; }, reloads: () => reloads };
}

test('混装配置失败后可原地重试：草稿版本同步，保留当前输入', async () => {
  const s = setup({ configFailure: true });
  s.panel.querySelector('[data-field="units_per_pack"]').listeners.input({ target: { value: '2' } });
  await s.click();
  assert.match(s.panel.querySelector('.mixed-message').textContent, /解除各部门审核/);
  assert.equal(s.reloads(), 0);
  assert.equal(s.section.filled_at, 'v1');
  assert.equal(s.button.disabled, false);
  await s.click();
  assert.equal(s.reloads(), 1);
  assert.equal(s.requests.at(-1).body.config.units_per_pack, 2);
  assert.equal(s.requests.filter(r => r.url.includes('/sections/')).at(-1).body.base_filled_at, 'v1');
});

test('普通草稿正在保存时，混装保存等待同一队列并使用成功后的版本', async () => {
  let release;
  const s = setup({ gate: new Promise(resolve => { release = resolve; }) });
  const draft = s.context.putSection(s.section, s.payload, false);
  await new Promise(resolve => setImmediate(resolve));
  const mixed = s.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.requests.length, 1);
  release(); await draft; await mixed;
  assert.equal(s.reloads(), 1);
  assert.equal(s.requests[1].body.base_filled_at, 'v1');
});

test('其他窗口已更新时仍拒绝混装保存，不刷新、不覆盖、不提交配置', async () => {
  const s = setup();
  s.setServerVersion('v9');
  const before = JSON.stringify(s.payload);
  await s.click();
  assert.equal(s.requests.length, 1);
  assert.match(s.panel.querySelector('.mixed-message').textContent, /本次未覆盖/);
  assert.equal(s.reloads(), 0);
  assert.equal(JSON.stringify(s.payload), before);
  assert.equal(s.section.filled_at, 'v0');
  assert.equal(s.button.disabled, false);
});
