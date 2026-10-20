'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_COSTING_BASIS,
  normalizeCostingBasis,
  cartonRate,
  applyCostingBasisPayload,
} = require('../backend/services/costingBasis');
const { upgradeLegacySectionsForCalculation } = require('../backend/services/legacyFormula');

test('2026-07-31 unified basis contains the approved material, exchange and process rates', () => {
  assert.equal(DEFAULT_COSTING_BASIS.exchange.rmb_hkd, 0.87);
  assert.equal(DEFAULT_COSTING_BASIS.exchange.hkd_usd, 7.8);
  assert.equal(DEFAULT_COSTING_BASIS.materials.find(row => row.model === '750SW').price, 6.5);
  assert.equal(DEFAULT_COSTING_BASIS.materials.find(row => row.model === 'PM820/DM220').price, 18);
  assert.deepEqual(DEFAULT_COSTING_BASIS.painting, { pad: 0.04, edge: 0.08, clamp: 0.09 });
  assert.equal(cartonRate(DEFAULT_COSTING_BASIS, 'A=A 加强芯'), 2.9);
});

test('normalization keeps administrator changes while rejecting invalid negative numbers', () => {
  const basis = normalizeCostingBasis({
    ...DEFAULT_COSTING_BASIS,
    exchange: { rmb_hkd: 0.9, hkd_usd: -1 },
  });
  assert.equal(basis.exchange.rmb_hkd, 0.9);
  assert.equal(basis.exchange.hkd_usd, 7.8);
});

test('unified basis updates calculation payloads used by open quotes', () => {
  const sales = applyCostingBasisPayload('sales', { header: { currency: 'USD', fx_rmb_hkd: 0.85 } }, DEFAULT_COSTING_BASIS);
  assert.equal(sales.payload.header.fx_rmb_hkd, 0.87);
  assert.equal(sales.payload.header.fx_hkd_usd, 7.8);

  const molding = applyCostingBasisPayload('molding', {
    injection: [{ material: 'ABS', material_grade: '750SW', machine_model: '10A', target: 1000, sets: 1 }],
  }, DEFAULT_COSTING_BASIS);
  assert.equal(molding.payload.injection[0].material_unit_price, +(6.5 / 454).toFixed(5));
  assert.equal(molding.payload.injection[0].shot_price, 1.16);

  const painting = applyCostingBasisPayload('painting', {
    painting_items: [{ pad_qty: 1, pad_unit: 0.1, edge_qty: 0 }],
  }, DEFAULT_COSTING_BASIS);
  assert.equal(painting.payload.painting_items[0].pad_unit, 0.04);

  const engineering = applyCostingBasisPayload('engineering', {
    carton_calc: { cartons: [{ ka_label: 'K=A' }], paper_rate: 2.75 },
  }, DEFAULT_COSTING_BASIS);
  assert.equal(engineering.payload.carton_calc.paper_rate, 3);
});

test('unified basis is displayed on the verification page and editable only through the admin API', () => {
  const root = path.join(__dirname, '..');
  const verificationHtml = fs.readFileSync(path.join(root, 'frontend', 'verification.html'), 'utf8');
  const verificationJs = fs.readFileSync(path.join(root, 'frontend', 'verification.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(root, 'frontend', 'admin.html'), 'utf8');
  assert.match(verificationHtml, /id="verification-costing-basis"/);
  assert.match(verificationJs, /api\('\/refs\/costing_basis'\)/);
  assert.match(verificationJs, /api\('\/admin\/costing-basis'/);
  assert.match(verificationJs, /canManageCostingBasis\(\)/);
  assert.doesNotMatch(adminHtml, /id="cb-materials"/);
});

test('basis publishing updates open valuation versions but preserves completed history', () => {
  const root = path.join(__dirname, '..');
  const service = fs.readFileSync(path.join(root, 'backend', 'services', 'costingBasis.js'), 'utf8');
  assert.match(service, /quote_verification_sections/);
  assert.match(service, /v\.status NOT IN \('completed', 'cancelled'\)/);
  assert.match(service, /sync_verification_costing_basis/);
  assert.match(service, /verification_reopened/);
});

test('a copied historical valuation receives editable system formulas while its source values stay available', () => {
  const sections = upgradeLegacySectionsForCalculation([
    { dept: 'sales', payload: {
      pricing_summary: {
        t1: { base_price: 12, imp_mat: 2 },
        t2: { other_buy: 1 },
        t3: { injection_labor: 1, assembly_labor: 2 },
      },
      legacy_import: { summary_only: true, source_cost_including_labor: 6 },
    } },
    { dept: 'molding', payload: {
      injection_loss_pct: 0,
      injection: [{ material: 'ABS', weight_g: 1, material_unit_price: 2, shot_price: 1 }],
      legacy_items: [{ name: '料金额', current_hkd: 2 }, { name: '啤工', current_hkd: 1 }],
    } },
    { dept: 'assembly', payload: {
      legacy_items: [{ name: '包装人工：2人/1000PCS', current_hkd: 0.5 }],
    } },
    { dept: 'engineering', payload: {
      legacy_items: [{ name: '外购配件', quantity: 2, current_hkd: 1 }],
    } },
  ], DEFAULT_COSTING_BASIS);
  const byDept = Object.fromEntries(sections.map(section => [section.dept, section.payload]));
  assert.equal(byDept.sales.legacy_import.summary_only, false);
  assert.equal(byDept.sales.legacy_import.formula_mode, 'itemized_v1');
  assert.equal(byDept.molding.legacy_items[0].formula_kind, 'derived_from_injection');
  assert.equal(byDept.molding.legacy_items[0].include_in_summary, false);
  assert.equal(byDept.assembly.legacy_items[0].formula_kind, 'assembly_base_per_output');
  assert.equal(byDept.assembly.legacy_items[0].people, 2);
  assert.equal(byDept.assembly.legacy_items[0].output, 1000);
  assert.equal(byDept.engineering.legacy_items[0].formula_kind, 'quantity_x_unit');
  assert.equal(byDept.engineering.legacy_items[0].formula_unit_hkd, 0.5);
  assert.equal(byDept.engineering.legacy_items[0].source_current_hkd, 1);
});

test('a verified Excel exchange formula stays linked to the shared basis in a copied version', () => {
  const sourceAmount = 0.2 / 0.87;
  const sections = upgradeLegacySectionsForCalculation([
    { dept: 'sales', payload: {
      pricing_summary: { t1: { base_price: sourceAmount }, t2: {}, t3: {} },
      legacy_import: { summary_only: true, source_cost_including_labor: sourceAmount },
    } },
    { dept: 'engineering', payload: { legacy_items: [
      { name: '收藏指南', current_hkd: sourceAmount, source_formula: '0.2/D10',
        source_formula_cell: 'C46', source_formula_basis: 'rmb_hkd' },
      { name: '未知公式项目', current_hkd: 1, source_formula: '0.2/D10' },
    ] } },
  ], DEFAULT_COSTING_BASIS);
  const rows = sections.find(section => section.dept === 'engineering').payload.legacy_items;
  assert.equal(rows[0].formula_kind, 'rmb_divided_by_fx');
  assert.equal(rows[0].formula_rmb_value, 0.2);
  assert.equal(rows[0].source_current_hkd, sourceAmount);
  assert.equal(rows[1].formula_kind, 'quantity_x_unit');
});

test('publishing keeps confirmed quotes and completed versions frozen and invalidates reviewed open sections', async()=>{
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname,'../backend/db/schema.sql'),'utf8'));
  db.prepare("INSERT INTO factories(code,name_cn) VALUES ('qingxi','清溪')").run();
  db.prepare("INSERT INTO departments(code,name_cn,pin_staff,pin_supervisor) VALUES ('sales','业务','test','test')").run();
  const payload=JSON.stringify({header:{fx_rmb_hkd:.85}});
  for(const [id,status] of [[1,'drafting'],[2,'drafting'],[3,'drafting']]){
    db.prepare('INSERT INTO quotes(id,quote_no,product_name,factory_code,status) VALUES (?,?,?,\'qingxi\',?)').run(id,'TEST-'+id,'测试',status);
    db.prepare("INSERT INTO quote_sections(quote_id,dept,payload_json,status) VALUES (?,'sales',?,'approved')").run(id,payload);
  }
  db.prepare("INSERT INTO quote_customer_confirmations(quote_id,status) VALUES (2,'confirmed')").run();
  db.prepare("INSERT INTO quote_verifications(quote_id,baseline_json,status) VALUES (3,'{}','in_progress')").run();
  for(const [id,status] of [[1,'completed'],[2,'in_review']]){
    db.prepare('INSERT INTO quote_verification_versions(id,quote_id,version_no,label,status) VALUES (?,3,?,?,?)').run(id,id,'V'+id,status);
    db.prepare("INSERT INTO quote_verification_sections(version_id,dept,payload_json,status,reviewed_at) VALUES (?,'sales',?,'approved','2026-01-01')").run(id,payload);
  }
  try {
    const stats=await require('../backend/services/costingBasis').syncOpenQuotesToCostingBasis(db,{factoryCode:'qingxi',basis:DEFAULT_COSTING_BASIS,actor:'tester'});
    assert.equal(stats.synced,1);assert.equal(stats.verification_synced,1);
    assert.equal(db.prepare('SELECT payload_json FROM quote_sections WHERE quote_id=2').get().payload_json,payload);
    assert.equal(db.prepare('SELECT payload_json FROM quote_sections WHERE quote_id=3').get().payload_json,payload);
    assert.equal(db.prepare('SELECT payload_json FROM quote_verification_sections WHERE version_id=1').get().payload_json,payload);
    const changed=db.prepare('SELECT * FROM quote_verification_sections WHERE version_id=2').get();
    assert.equal(changed.status,'filled');assert.equal(changed.reviewed_at,null);assert.ok(changed.filled_at);
    assert.equal(JSON.parse(changed.payload_json).header.fx_rmb_hkd,.87);
  } finally {db.close();}
});
