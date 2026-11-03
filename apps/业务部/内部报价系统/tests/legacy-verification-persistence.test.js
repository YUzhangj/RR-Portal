const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { importLegacyVerificationItems, createLegacyVerificationBatchVersion } = require('../backend/services/legacyVerificationImport');

const departments = ['sales', 'engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly'];
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../backend/db/schema.sql'), 'utf8'));
  db.exec('PRAGMA foreign_keys=ON');
  db.prepare("INSERT INTO factories(code,name_cn) VALUES ('qingxi','清溪')").run();
  for (const dept of departments) db.prepare('INSERT INTO departments(code,name_cn,pin_staff,pin_supervisor) VALUES (?,?,?,?)')
    .run(dept, dept, 'fixture-only', 'fixture-only');
  db.transaction = operation => async () => {
    db.exec('BEGIN');
    try { const result = await operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return db;
}
function workbook(status) {
  return {
    sourceDate: '2026-10-20', sourceFile: 'fixture.xlsx',
    items: [{ quoteNo: 'FIXTURE', productName: 'Fixture', qty: null, confirmedPrice: 3,
      ...(status ? { verificationStatus: status } : {}),
      salesPayload: { legacy_import: { summary_only: true, import_review_issues: status === 'drafting' ? ['Missing metric source'] : [] } },
      departmentPayloads: Object.fromEntries(departments.slice(1).map(dept => [dept, { legacy_items: [{ name: dept, current_hkd: 1 }] }])),
    }],
  };
}

test('legacy imports obtain the real persisted version ID and retain completed source approvals', async () => {
  const db = database();
  try {
    const parsed = workbook();
    await importLegacyVerificationItems(db, parsed, { apply: true, skipReady: true });
    const version = db.prepare('SELECT * FROM quote_verification_versions').get();
    assert.equal(version.status, 'completed');
    const sections = db.prepare('SELECT * FROM quote_verification_sections ORDER BY dept').all();
    assert.equal(sections.length, 8);
    for (const section of sections) {
      assert.equal(section.version_id, version.id);
      assert.equal(section.status, 'approved');
      assert.ok(section.reviewed_by && section.reviewed_at);
      assert.deepEqual(JSON.parse(section.payload_json), section.dept === 'sales' ? parsed.items[0].salesPayload : parsed.items[0].departmentPayloads[section.dept]);
    }
    assert.equal(db.prepare('SELECT status FROM quote_verifications').get().status, 'completed');
    assert.equal(db.prepare('SELECT status FROM quotes').get().status, 'fully_approved');
  } finally { db.close(); }
});

test('unreviewed legacy source rows stay editable and are never auto-approved', async () => {
  const db = database();
  try {
    await importLegacyVerificationItems(db, workbook('drafting'), { apply: true, skipReady: true });
    const version = db.prepare('SELECT * FROM quote_verification_versions').get();
    assert.equal(version.status, 'drafting');
    assert.equal(version.completed_by, null);
    assert.equal(version.completed_at, null);
    assert.equal(db.prepare('SELECT status FROM quotes').get().status, 'drafting');
    assert.equal(db.prepare('SELECT status FROM quote_verifications').get().status, 'in_progress');
    for (const table of ['quote_sections', 'quote_verification_sections']) {
      const sections = db.prepare(`SELECT * FROM ${table}`).all();
      assert.equal(sections.length, 8);
      for (const section of sections) {
        assert.equal(section.status, 'filled');
        assert.equal(section.reviewed_by, null);
        assert.equal(section.reviewed_at, null);
      }
    }
    const baseline = JSON.parse(db.prepare('SELECT baseline_json FROM quote_verifications').get().baseline_json);
    assert.ok(baseline.sections.every(section => section.status === 'filled'));
    assert.deepEqual(baseline.sections.find(section => section.dept === 'sales').payload.legacy_import.import_review_issues, ['Missing metric source']);
  } finally { db.close(); }
});

test('invalid imported lifecycle status is rejected before writing any data', async () => {
  const db = database();
  try {
    await assert.rejects(importLegacyVerificationItems(db, workbook('cancelled'), { apply: true, skipReady: true }), /状态无效/);
    for (const table of ['quotes', 'quote_verification_versions', 'audit_log', 'app_migrations']) {
      assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0);
    }
  } finally { db.close(); }
});

test('batch synchronization preserves V1 and creates a correctly linked next version', async () => {
  const db = database();
  try {
    const parsed = workbook();
    await importLegacyVerificationItems(db, parsed, { apply: true, skipReady: true });
    const originalVersion = db.prepare('SELECT * FROM quote_verification_versions').get();
    const originalSections = db.prepare('SELECT * FROM quote_verification_sections ORDER BY id').all();
    const result = await createLegacyVerificationBatchVersion(db, parsed, { skipReady: true });
    assert.equal(result.itemCount, 1);
    const versions = db.prepare('SELECT * FROM quote_verification_versions ORDER BY version_no').all();
    assert.equal(versions.length, 2);
    assert.deepEqual(versions[0], originalVersion);
    assert.equal(versions[1].parent_version_id, originalVersion.id);
    assert.equal(versions[1].status, 'completed');
    assert.deepEqual(db.prepare('SELECT * FROM quote_verification_sections WHERE version_id=? ORDER BY id').all(originalVersion.id), originalSections);
  } finally { db.close(); }
});

test('batch synchronization rechecks lifecycle changes after preflight without partial writes', async () => {
  const db = database();
  try {
    const parsed = workbook();
    await importLegacyVerificationItems(db, parsed, { apply: true, skipReady: true });
    const originalSections = db.prepare('SELECT * FROM quote_verification_sections ORDER BY id').all();
    const auditCount = db.prepare('SELECT COUNT(*) count FROM audit_log').get().count;
    const transaction = db.transaction;
    db.transaction = operation => transaction(async () => {
      // Simulate another lifecycle writer winning after preflight but before
      // this transaction owns the version. This change must not be ignored.
      db.prepare("UPDATE quote_verification_versions SET status='drafting'").run();
      return operation();
    });
    await assert.rejects(createLegacyVerificationBatchVersion(db, parsed, { skipReady: true }),
      error => error.code === 'LEGACY_BATCH_CONFLICT');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM quote_verification_versions').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM audit_log').get().count, auditCount);
    assert.deepEqual(db.prepare('SELECT * FROM quote_verification_sections ORDER BY id').all(), originalSections);
  } finally { db.close(); }
});
