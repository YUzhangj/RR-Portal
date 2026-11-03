const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { planTransfer, applyTransfer, validateBundle } = require('../backend/services/verificationTransfer');

const departments = ['sales', 'engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly'];

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../backend/db/schema.sql'), 'utf8'));
  db.exec('PRAGMA foreign_keys=ON');
  db.prepare("INSERT INTO factories(code,name_cn) VALUES ('qingxi','清溪')").run();
  for (const department of departments) {
    db.prepare('INSERT INTO departments(code,name_cn,pin_staff,pin_supervisor) VALUES (?,?,?,?)')
      .run(department, department, 'test-hash', 'test-hash');
  }
  db.transaction = fn => async () => {
    db.exec('BEGIN');
    try {
      const result = await fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return db;
}

function bundle(sku = 'TEST-1') {
  const sections = departments.map(dept => ({
    dept,
    payload: dept === 'sales'
      ? { legacy_import: { summary_only: true }, pricing_summary: { t1: { base_price: 12 } } }
      : { test_value: 1 },
    status: 'approved',
  }));
  return {
    format: 'rr-verification-transfer-v1',
    records: [{
      quote: { customer: 'TEST CUSTOMER', quote_no: sku, product_name: '测试产品', qty: 100 },
      confirmation: { confirmed_price: 12, confirmed_qty: 100 },
      baseline: { quote: { quote_no: sku }, sections },
      versions: [{ version_no: 1, status: 'completed', category: '历史导入', sections }],
    }],
  };
}

test('customer valuation transfer previews without writes and imports once', async () => {
  const db = database();
  try {
    const data = bundle();
    const plan = await planTransfer(db, data, 'qingxi');
    assert.equal(plan.new_count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM quotes').get().n, 0);
    await assert.rejects(applyTransfer(db, data, {
      factoryCode: 'qingxi', actor: 'tester', expectedToken: 'stale',
    }), /预览已变化/);
    const result = await applyTransfer(db, data, {
      factoryCode: 'qingxi', actor: 'tester', expectedToken: plan.token,
    });
    assert.equal(result.count, 1);
    const version = db.prepare('SELECT * FROM quote_verification_versions').get();
    assert.equal(version.status, 'completed');
    assert.equal(version.category, '历史导入');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM quote_verification_sections WHERE status='approved'").get().n, 8);
    const replay = await planTransfer(db, data, 'qingxi');
    assert.equal(replay.new_count, 0);
    assert.equal(replay.existing_count, 1);
  } finally {
    db.close();
  }
});

test('customer valuation transfer rejects collisions and malformed bundles', async () => {
  const db = database();
  try {
    db.prepare("INSERT INTO quotes(quote_no,product_name,customer,deleted_at,factory_code) VALUES ('TEST-1','原产品','OTHER',datetime('now'),'qingxi')").run();
    await assert.rejects(planTransfer(db, bundle(), 'qingxi'), /已有资料/);
    const duplicate = bundle();
    duplicate.records.push({ ...duplicate.records[0], quote: { ...duplicate.records[0].quote, customer: 'ANOTHER' } });
    assert.throws(() => validateBundle(duplicate), /重复/);
  } finally {
    db.close();
  }
});
