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

test('verification uses a task, multiple versions, and independent department sections', () => {
  const route = fs.readFileSync(path.join(root, 'backend/routes/verifications.js'), 'utf8');
  const sqliteSchema = fs.readFileSync(path.join(root, 'backend/db/schema.sql'), 'utf8');
  const postgresSchema = fs.readFileSync(path.join(root, 'backend/db/schema.postgres.sql'), 'utf8');
  for (const schema of [sqliteSchema, postgresSchema]) {
    assert.match(schema, /quote_verification_versions/);
    assert.match(schema, /quote_verification_sections/);
    assert.match(schema, /parent_version_id/);
    assert.match(schema, /UNIQUE\(quote_id, version_no\)/);
    assert.match(schema, /UNIQUE\(version_id, dept\)/);
  }
  assert.match(route, /c\.status='confirmed'/);
  assert.match(route, /createVersion/);
  assert.match(route, /source_version_id/);
  assert.match(route, /新版本只能复制已完成的核价版本/);
  assert.match(route, /applyCostingBasisPayload/);
  assert.match(route, /upgradeLegacySectionsForCalculation/);
  assert.match(route, /套用统一核价基准/);
  assert.match(route, /所有部门审核通过后才能完成核价版本/);
});

test('copied imported valuations expose editable converted formulas and dynamic summaries', () => {
  const page = fs.readFileSync(path.join(root, 'frontend', 'verification.js'), 'utf8');
  const workbench = fs.readFileSync(path.join(root, 'frontend', 'workbench.js'), 'utf8');
  const formulas = fs.readFileSync(path.join(root, 'backend', 'services', 'legacyFormula.js'), 'utf8');
  assert.match(page, /复制为可调整版本/);
  assert.match(page, /系统会带入计算公式/);
  assert.match(workbench, /formula_mode === 'itemized_v1'/);
  assert.match(formulas, /数量 × 单价/);
  assert.match(formulas, /核价基数 × 人数 × 小组 ÷ 生产量/);
  assert.match(workbench, /修改部门明细或统一核价基准后自动重算/);
  assert.match(workbench, /保持原 Excel 的汇总格式/);
  assert.match(workbench, /legacy-tax-deduction-block" class="hidden"/);
});

test('each verification version follows the quotation department submit and review workflow', () => {
  const route = fs.readFileSync(path.join(root, 'backend/routes/verifications.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  const workbench = fs.readFileSync(path.join(root, 'frontend/workbench.js'), 'utf8');
  assert.match(route, /verification_submit/);
  assert.match(route, /verification_\$\{action\}/);
  assert.match(route, /verification_reopen/);
  assert.doesNotMatch(page, /部门核价流程/);
  assert.match(page, /填写明细 → 提交审核 → 主管审核/);
  assert.match(page, /保存草稿/);
  assert.match(page, /提交审核/);
  assert.match(page, /审核通过/);
  assert.match(page, /renderEngineering/);
  assert.match(page, /renderElectronic/);
  assert.match(page, /renderMolding/);
  assert.match(page, /renderSummaryPane/);
  assert.match(workbench, /renderSummaryPane,/);
  assert.doesNotMatch(page, /verification-value-input/);
});

test('users can compare the quotation and multiple verification versions together', () => {
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  assert.match(page, /报价 \/ 多版本核价对比/);
  assert.match(page, /data-comparison-source/);
  assert.match(page, /verification-select-all-versions/);
  assert.match(page, /原报价 \+ 最新版/);
  assert.match(page, /loadComparisonSource/);
  assert.match(page, /原报价/);
  assert.match(page, /只看变化/);
  assert.match(page, /部门明细变化/);
  assert.match(page, /当前对比包含未完成核价版本/);
  assert.match(page, /较基准/);
});

test('tax comparison supports multiple valuation versions while excluding quotation tax', () => {
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  assert.match(page, /原报价不展示减税；所选核价版本的减税结果按版本并排列示/);
  assert.match(page, /verificationSources = sources\.map/);
  assert.match(page, /减税后成本/);
});

test('main quotation page links to verification center', () => {
  const index = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
  assert.match(index, /报价板块/);
  assert.match(index, /module-switch/);
  assert.match(index, /href="\.\/verification\.html"/);
  assert.match(server, /\/api\/verifications/);
});

test('quotation and verification pages share the same account and factory controls', () => {
  const quotation = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const verification = fs.readFileSync(path.join(root, 'frontend/verification.html'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'frontend/admin.html'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  for (const id of ['factory-chip', 'factory-switch', 'who-chip', 'btn-change-pwd', 'btn-admin', 'btn-logout']) {
    assert.match(quotation, new RegExp(`id="${id}"`));
    assert.match(verification, new RegExp(`id="${id}"`));
  }
  assert.match(page, /\/auth\/factory/);
  assert.match(page, /\/auth\/change-password/);
  assert.match(page, /\/auth\/logout/);
  assert.match(quotation, /admin\.html\?from=quotes/);
  assert.match(verification, /admin\.html\?from=verification/);
  assert.match(admin, /id="admin-return"/);
  assert.match(admin, /from === 'verification'/);
  assert.match(admin, /link\.href = '\.\/verification\.html'/);
});

test('verification center is a separate master-detail module with filters', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/verification.html'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  assert.match(html, /核价板块/);
  assert.match(html, /module-switch/);
  assert.match(html, /verification-master-detail/);
  assert.match(html, /verification-status-filter/);
  assert.match(html, /verification-customer-filter/);
  assert.doesNotMatch(html, /class="precision-sidebar"/);
  assert.match(html, /verification-summary-button/);
  assert.match(fs.readFileSync(path.join(root, 'frontend/verification-precision.css'), 'utf8'), /Quote-aligned shell/);
  assert.match(html, /option\[data-precision-detail\]/);
  assert.match(html, /dataset\.verificationUi = 'precision'/);
  assert.doesNotMatch(html, /verification-ui-switch|ui=classic|返回旧版|体验新版/);
  assert.match(page, /filterStatus === 'unfinished'/);
  assert.match(page, /renderPreview/);
  assert.match(page, /verification-preview-compact-data/);
  assert.match(page, /进入核价/);
  assert.match(page, /版本对比/);
  assert.doesNotMatch(page, /verification-version-strip/);
});

test('verification page handles a stale backend response without breaking the task list', () => {
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  assert.match(page, /!data\.selected_version/);
  assert.match(page, /核价服务版本未同步/);
  assert.match(page, /核价任务暂时无法打开/);
});

test('verification workflow keeps progress visible while wide workbench tables scroll internally', () => {
  const page = fs.readFileSync(path.join(root, 'frontend/verification.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'frontend/styles.css'), 'utf8');
  assert.match(page, /departments\.filter\(section => section\.status === 'approved'\)/);
  assert.match(page, /activeDepartment !== '__summary__'/);
  assert.match(page, /aria-label="部门审核进度"/);
  assert.match(page, /部门已审核/);
  assert.match(styles, /#verification-detail-content\{overflow:hidden\}/);
  assert.match(styles, /#verification-workbench-body[^}]*overflow-x:auto/);
});

test('desktop valuation list freezes its controls but restores page scrolling while the costing basis is expanded', () => {
  const styles = fs.readFileSync(path.join(root, 'frontend', 'styles.css'), 'utf8');
  assert.match(styles, /@media\(min-width:761px\)/);
  assert.match(styles, /body:has\(#verification-list:not\(\.hidden\)\)\{overflow:hidden\}/);
  assert.match(styles, /#verification-list:not\(\.hidden\) \.verification-list-pane\{min-height:0;overflow:auto\}/);
  assert.match(styles, /#verification-list:not\(\.hidden\) \.verification-preview\{min-height:0;overflow:auto\}/);
  assert.match(styles, /\.verification-list-table thead\{position:sticky/);
  assert.match(styles, /body:has\(#verification-list:not\(\.hidden\)\):has\(#verification-costing-basis details\[open\]\)\{overflow:auto\}/);
  assert.match(styles, /\.verification-ledger-page:has\(#verification-list:not\(\.hidden\)\):has\(#verification-costing-basis details\[open\]\)\{height:auto;[^}]*overflow:visible\}/);
  assert.match(styles, /#verification-costing-basis:has\(details\[open\]\)\+#verification-list:not\(\.hidden\)\{position:sticky;top:0;[^}]*height:100vh;min-height:0;[^}]*\}/);
  assert.match(styles, /\.verification-list-table\{table-layout:fixed\}/);
});

test('valuation task table provides filters for every visible column', () => {
  const html = fs.readFileSync(path.join(root, 'frontend', 'verification.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'frontend', 'verification.js'), 'utf8');
  for (const id of ['verification-no-filter', 'verification-product-filter', 'verification-table-customer-filter',
    'verification-version-filter', 'verification-progress-filter', 'verification-table-status-filter',
    'verification-table-workshop-filter']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(script, new RegExp(id));
  }
});

test('administrators can reopen a completed valuation version for direct correction', () => {
  const route = fs.readFileSync(path.join(root, 'backend', 'routes', 'verifications.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend', 'verification.js'), 'utf8');
  assert.match(route, /router\.post\('\/versions\/:versionId\/reopen'/);
  assert.match(route, /只有管理员可以重新开启已完成的核价版本/);
  assert.match(route, /verification_version_reopen/);
  assert.match(route, /SET status='in_review', completed_by=NULL, completed_at=NULL/);
  assert.match(route, /can_reopen_version: isAdmin/);
  assert.match(page, /解锁修改/);
  assert.match(page, /管理员可稍后重新开启/);
  assert.doesNotMatch(page, /永久锁定/);
});

test('administrators can delete only the latest unfinished valuation version', () => {
  const route = fs.readFileSync(path.join(root, 'backend', 'routes', 'verifications.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'frontend', 'verification.js'), 'utf8');
  assert.match(route, /router\.delete\('\/versions\/:versionId'/);
  assert.match(route, /只有管理员可以删除核价版本/);
  assert.match(route, /初始核价版本不可删除/);
  assert.match(route, /只能删除最新核价版本/);
  assert.match(route, /已完成版本请先解锁修改后再删除/);
  assert.match(route, /verification_version_delete/);
  assert.match(page, /can_delete_version/);
  assert.match(page, /全部部门核价明细将一起删除，且无法恢复/);
  assert.match(page, /method: 'DELETE'/);
});
