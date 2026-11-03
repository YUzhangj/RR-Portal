const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('valuation workspace uses the confirmed precision layout without a legacy switch', () => {
  const html = read('frontend/verification.html');
  const css = read('frontend/verification-precision.css');
  assert.match(html, /dataset\.verificationUi = 'precision'/);
  assert.match(html, /verification-precision\.css/);
  assert.match(html, /verification-master-detail/);
  assert.match(css, /Quote-aligned shell/);
  assert.doesNotMatch(html, /verification-ui-switch|ui=classic|返回旧版|体验新版/);
  assert.doesNotMatch(read('frontend/verification.js'), /部门核价流程/);
});

test('task list exposes the compact status choices and every visible column filter', () => {
  const html = read('frontend/verification.html');
  const script = read('frontend/verification.js');
  for (const id of [
    'verification-no-filter', 'verification-product-filter', 'verification-table-customer-filter',
    'verification-version-filter', 'verification-progress-filter', 'verification-table-status-filter',
    'verification-table-workshop-filter',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(script, new RegExp(id));
  }
  assert.match(html, /<option value="unfinished">待完成<\/option>/);
  assert.match(html, /<option value="completed">已完成<\/option>/);
  assert.match(html, /option\[data-precision-detail\]/);
  assert.match(script, /status === 'unfinished'/);
  assert.match(script, /verification-clear-filters/);
  assert.doesNotMatch(html, /verification-records|verification-export/);
  assert.doesNotMatch(script, /verification-records|verification-export/);
});

test('quotation and valuation pages retain matching account controls and contextual admin return links', () => {
  const quotation = read('frontend/index.html');
  const verification = read('frontend/verification.html');
  const admin = read('frontend/admin.html');
  const script = read('frontend/verification.js');
  for (const id of ['factory-chip', 'factory-switch', 'who-chip', 'btn-change-pwd', 'btn-admin', 'btn-logout']) {
    assert.match(quotation, new RegExp(`id="${id}"`));
    assert.match(verification, new RegExp(`id="${id}"`));
  }
  assert.match(quotation, /admin\.html\?from=quotes/);
  assert.match(verification, /admin\.html\?from=verification/);
  assert.match(admin, /id="admin-return"/);
  assert.match(admin, /from === 'verification'/);
  assert.match(script, /\/auth\/factory/);
  assert.match(script, /\/auth\/change-password/);
  assert.match(script, /\/auth\/logout/);
});

test('valuation summary returns to the task workspace with the compact action style', () => {
  const html = read('frontend/verification-summary.html');
  assert.match(html, /class="vs-back" href="\.\/verification\.html"/);
  assert.match(html, /返回核价任务/);
});
