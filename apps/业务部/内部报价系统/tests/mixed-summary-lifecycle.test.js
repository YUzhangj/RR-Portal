const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const MixedMolds = require('../frontend/mixed-molds');

function fixture() {
  const pending = [];
  const window = { MixedMolds, __data: { sections: [] } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/mixed-quotation.js'), 'utf8'), {
    window,
    fetch: () => new Promise((resolve, reject) => pending.push({
      succeed: () => resolve({ ok: true, json: async () => result }),
      fail: message => reject(new Error(message)),
    })),
  });
  const product = { id: 'a', code: 'A', name: '甲', ratio: 1 };
  const result = { enabled: true, errors: [], units_per_pack: 1,
    config: { products: [product] }, products: [{ ...product, weight: 1, components: {} }] };
  const host = {
    isConnected: true, html: '', inputs: [], nodes: {},
    set innerHTML(value) {
      this.html = value;
      this.nodes = {};
      this.inputs = [...value.matchAll(/data-na-product="([^"]+)"[^>]*value="([^"]*)"/g)]
        .map(([, id, saved]) => ({ dataset: { naProduct: id }, value: saved }));
    },
    get innerHTML() { return this.html; },
    querySelectorAll(selector) { return selector === '[data-na-product]' ? this.inputs : []; },
    querySelector(selector) { return this.nodes[selector] ||= {}; },
  };
  return { host, pending, render: () => window.MixedQuotation.summary(host, { id: 97, product_name: '测试报价' }, {}) };
}

test('混装汇总迟到成功或失败保留新页面草稿，当前请求失败仍显示错误', async () => {
  for (const outcome of ['succeed', 'fail']) {
    const f = fixture();
    const earlier = f.render();
    const latest = f.render();
    f.pending[1].succeed();
    await latest;
    assert.match(f.host.innerHTML, /混装报价汇总 · 测试报价/);
    const input = f.host.inputs[0];
    assert.equal(input.value, '1.0000');
    input.value = '0.25';
    f.pending[0][outcome]('过期请求失败');
    await earlier;
    assert.equal(f.host.inputs[0], input, `${outcome}: 旧请求不得替换新表单`);
    assert.equal(f.host.inputs[0].value, '0.25');
    assert.doesNotMatch(f.host.innerHTML, /过期请求失败/);
  }
  const f = fixture();
  const current = f.render();
  f.pending[0].fail('当前请求<失败>');
  await current;
  assert.match(f.host.innerHTML, /混装汇总失败：当前请求&lt;失败&gt;/);
});
