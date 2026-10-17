const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSummary(window) {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/workbench.js'), 'utf8');
  const start = source.indexOf('function renderSummaryPane(');
  const next = source.slice(start + 1).search(/^function /m);
  assert.ok(start >= 0 && next >= 0);
  const context = vm.createContext({ window });
  vm.runInContext(source.slice(start, start + 1 + next), context);
  return context.renderSummaryPane;
}

test('混装汇总读取各款及共有费用的专用汇总，不进入普通单品计算', async () => {
  const host = {}, quote = { id: 97 }, me = {};
  const result = Promise.resolve('mixed summary');
  const calls = [];
  const render = loadSummary({
    __data: { mixed_quote: { enabled: true } },
    MixedQuotation: { summary(...args) { calls.push(args); return result; } },
  });
  const sections = { find() { assert.fail('不得读取普通单品字段'); } };
  assert.equal(render(host, sections, quote, me), result);
  assert.deepEqual(calls, [[host, quote, me]]);
  await result;
});

for (const [label, config, embedded] of [
  ['普通报价', { enabled: false }, false],
  ['未配置混装的历史报价', undefined, false],
  ['核价嵌入页面', { enabled: true }, true],
]) {
  test(`${label}保留原有汇总入口`, () => {
    const reachedOriginalSummary = new Error('original summary');
    const render = loadSummary({
      __data: { mixed_quote: config },
      __WORKBENCH_EMBED__: embedded,
      MixedQuotation: { summary() { assert.fail('不应进入混装报价汇总'); } },
    });
    assert.throws(() => render({}, {
      find() { throw reachedOriginalSummary; },
    }, {}, {}), error => error === reachedOriginalSummary);
  });
}
