const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('confirmed quotations create an immutable verification baseline snapshot', () => {
  const summary = fs.readFileSync(path.join(root, 'backend/routes/summary.js'), 'utf8');
  const sections = fs.readFileSync(path.join(root, 'backend/routes/sections.js'), 'utf8');
  const quotes = fs.readFileSync(path.join(root, 'backend/routes/quotes.js'), 'utf8');
  assert.match(summary, /INSERT INTO quote_verifications/);
  assert.match(summary, /ON CONFLICT \(quote_id\) DO NOTHING/);
  assert.match(summary, /客价已经确认并锁定/);
  assert.match(sections, /quote_verifications WHERE quote_id/);
  assert.match(quotes, /报价基本资料已锁定/);
});

test('verification center exposes department detail comparison and independent prices', () => {
  const route = fs.readFileSync(path.join(root, 'backend/routes/verifications.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  assert.match(route, /verified_values_json/);
  assert.match(route, /c\.status='confirmed'/);
  assert.match(page, /data-dept-panel/);
  assert.match(page, /确认报价/);
  assert.match(page, /核价价格/);
  assert.match(page, /差异率/);
  assert.match(page, /detailState\.values/);
  assert.match(page, /renderOriginalWorkbench/);
  assert.match(page, /VerificationWorkbench/);
  assert.match(page, /原报价完整明细|原报价明细/);
  assert.match(page, /只列实际录入的成本\/单价/);
  assert.doesNotMatch(page, /collectMoneyFields/);
});

test('main quotation page links to verification center', () => {
  const index = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
  assert.match(index, /href="\.\/verification\.html"/);
  assert.match(server, /\/api\/verifications/);
});
