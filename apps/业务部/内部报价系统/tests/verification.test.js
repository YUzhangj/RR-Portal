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

test('verification center exposes a quotation-style department workflow with a frozen comparison', () => {
  const route = fs.readFileSync(path.join(root, 'backend/routes/verifications.js'), 'utf8');
  const sqliteSchema = fs.readFileSync(path.join(root, 'backend/db/schema.sql'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  assert.match(route, /verified_values_json/);
  assert.match(route, /verified_sections_json/);
  assert.match(route, /sectionsJson/);
  assert.match(route, /allowedDepartments/);
  assert.match(sqliteSchema, /verified_sections_json/);
  assert.match(route, /c\.status='confirmed'/);
  assert.match(route, /核价已经完成并锁定/);
  assert.match(page, /data-dept-panel/);
  assert.match(page, /核价工作台/);
  assert.match(page, /原报价参考/);
  assert.match(page, /verified_sections/);
  assert.match(page, /renderVerificationWorkbench/);
  assert.match(page, /sections: detailState\.verified_sections/);
  assert.match(page, /VerificationWorkbench/);
  assert.match(page, /操作方式与报价一致/);
  assert.doesNotMatch(page, /collectMoneyFields/);
});

test('verification details show the full frozen quotation beside editable costing and only verification tax', () => {
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  const workbench = fs.readFileSync(path.join(root, 'frontend/workbench.js'), 'utf8');
  assert.match(page, /data-live-workbench/);
  assert.match(page, /data-original-workbench/);
  assert.match(page, /客价确认时冻结 · 不可修改/);
  assert.match(page, /汇总与减税/);
  assert.match(page, /下方减税明细只显示并计算核价数据/);
  assert.match(page, /renderSummaryPane/);
  assert.match(workbench, /renderSummaryPane,/);
  assert.match(workbench, /renderFreightCalc\(host\.querySelector\('#wb-freight'\), payload\.freight_calc, eCarton, canEditPricing/);
});

test('main quotation page links to verification center', () => {
  const index = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
  assert.match(index, /href="\.\/verification\.html"/);
  assert.match(server, /\/api\/verifications/);
});

test('verification center uses a master-detail workbench with workflow and filters', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/verification.html'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  assert.match(html, /报价核价中心/);
  assert.match(html, /verification-flow/);
  assert.match(html, /verification-master-detail/);
  assert.match(html, /verification-status-filter/);
  assert.match(html, /verification-customer-filter/);
  assert.match(page, /renderPreview/);
  assert.match(page, /进入核价明细/);
});
