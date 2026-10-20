'use strict';

const {nextSectionTime} = require('./verificationSectionSave');
const conflict = () => { throw Object.assign(new Error('资料在同步期间已更新，请刷新后重新发布基准'), {status:409}); };

const DEFAULT_COSTING_BASIS = {
  version: '2026-07-31',
  title: '华登集团—清溪厂区2026年成本最新核价方式',
  materials: [
    { name: 'ABS', model: '750SW', price: 6.50 },
    { name: '透明ABS', model: 'TR558/920', price: 10.00 },
    { name: 'HIPS', model: 'HI425', price: 6.00 },
    { name: 'GP', model: 'MW-1', price: 6.80 },
    { name: '1#PP', model: 'JM350/K8009', price: 5.80 },
    { name: '1#PP', model: '7032 E3', price: 5.80 },
    { name: '透明PP', model: '5090T', price: 6.50 },
    { name: 'POM', model: 'F3003/M9044', price: 13.50 },
    { name: 'POM', model: 'PM820/DM220', price: 18.00 },
    { name: 'PVC', model: '普通透明', price: 7.20 },
    { name: 'PVC', model: '普通本白', price: 6.20 },
    { name: 'LDPE', model: 'G812', price: 6.50 },
    { name: 'HDPE', model: 'HMA016', price: 6.90 },
    { name: 'TPR', model: '本白橡胶料', price: 13.80 },
    { name: 'TPR', model: '透明橡胶料', price: 16.10 },
    { name: 'K料', model: 'KR-03NW', price: 12.50 },
    { name: 'PC料', model: '2605', price: 10.80 },
  ],
  machines: [
    { model: '4A-6A', normal: '80T', price: 940 },
    { model: '7A-9A', normal: '60-80T', price: 1050 },
    { model: '10A-12A', normal: '120T', price: 1160 },
    { model: '14A-16A', normal: '150T', price: 1490 },
    { model: '20A', normal: '200T', price: 1920 },
    { model: '24A', normal: '260T', price: 1920 },
    { model: '32A', normal: '320T', price: 2220 },
    { model: '44A', normal: '490T', price: 2500 },
    { model: '46A-49.9A', normal: '', price: 2800 },
    { model: '60A', normal: '500T', price: 3090 },
    { model: '80A', normal: '', price: 3590 },
    { model: '81.3A', normal: '', price: 3600 },
    { model: '105A', normal: '800T', price: 4500 },
  ],
  exchange: { rmb_hkd: 0.87, hkd_usd: 7.8 },
  assembly: {
    base_rate_hkd: 310,
    wage_factor: 1.20,
    social_factor: 1.27,
    overhead_factor: 1.13,
    hunan_freight_pct: 10,
  },
  painting: { pad: 0.04, edge: 0.08, clamp: 0.09 },
  tax: { sewing_exclusion_pct: 5, electronic_exclusion_pct: 5 },
  cartons: [
    { label: 'K=K', rate: 3.30 },
    { label: 'K=A', rate: 3.00 },
    { label: 'A=A', rate: 2.75 },
    { label: 'A=B', rate: 2.60 },
    { label: 'B=B', rate: 2.50 },
    { label: 'B3B单坑', rate: 1.55 },
    { label: 'A=A 加强芯', rate: 2.90 },
    { label: 'A=B 加强芯', rate: 2.80 },
    { label: 'B=B 加强芯', rate: 2.60 },
    { label: 'B3B 单坑加强芯', rate: 1.65 },
    { label: 'B150B', rate: 3.45 },
    { label: 'A535B', rate: 3.10 },
  ],
  default_carton_label: 'A=A',
};

const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, fallback = '') => String(value == null ? fallback : value).trim();
const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

function normalizeRows(rows, defaults, fields) {
  if (!Array.isArray(rows) || !rows.length) return clone(defaults);
  return rows.map((row, index) => {
    const fallback = defaults[index] || {};
    const result = {};
    for (const [key, type] of Object.entries(fields)) {
      result[key] = type === 'number'
        ? number(row?.[key], number(fallback[key], 0))
        : text(row?.[key], fallback[key]);
    }
    return result;
  }).filter(row => Object.values(row).some(value => value !== '' && value !== 0));
}

function normalizeCostingBasis(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const exchange = source.exchange || {};
  const assembly = source.assembly || {};
  const painting = source.painting || {};
  const tax = source.tax || {};
  return {
    version: text(source.version, DEFAULT_COSTING_BASIS.version),
    title: text(source.title, DEFAULT_COSTING_BASIS.title),
    materials: normalizeRows(source.materials, DEFAULT_COSTING_BASIS.materials,
      { name: 'text', model: 'text', price: 'number' }),
    machines: normalizeRows(source.machines, DEFAULT_COSTING_BASIS.machines,
      { model: 'text', normal: 'text', price: 'number' }),
    exchange: {
      rmb_hkd: number(exchange.rmb_hkd, DEFAULT_COSTING_BASIS.exchange.rmb_hkd),
      hkd_usd: number(exchange.hkd_usd, DEFAULT_COSTING_BASIS.exchange.hkd_usd),
    },
    assembly: {
      base_rate_hkd: number(assembly.base_rate_hkd, DEFAULT_COSTING_BASIS.assembly.base_rate_hkd),
      wage_factor: number(assembly.wage_factor, DEFAULT_COSTING_BASIS.assembly.wage_factor),
      social_factor: number(assembly.social_factor, DEFAULT_COSTING_BASIS.assembly.social_factor),
      overhead_factor: number(assembly.overhead_factor, DEFAULT_COSTING_BASIS.assembly.overhead_factor),
      hunan_freight_pct: number(assembly.hunan_freight_pct, DEFAULT_COSTING_BASIS.assembly.hunan_freight_pct),
    },
    painting: {
      pad: number(painting.pad, DEFAULT_COSTING_BASIS.painting.pad),
      edge: number(painting.edge, DEFAULT_COSTING_BASIS.painting.edge),
      clamp: number(painting.clamp, DEFAULT_COSTING_BASIS.painting.clamp),
    },
    tax: {
      sewing_exclusion_pct: number(tax.sewing_exclusion_pct, DEFAULT_COSTING_BASIS.tax.sewing_exclusion_pct),
      electronic_exclusion_pct: number(tax.electronic_exclusion_pct, DEFAULT_COSTING_BASIS.tax.electronic_exclusion_pct),
    },
    cartons: normalizeRows(source.cartons, DEFAULT_COSTING_BASIS.cartons,
      { label: 'text', rate: 'number' }),
    default_carton_label: text(source.default_carton_label, DEFAULT_COSTING_BASIS.default_carton_label),
  };
}

function cartonRate(basis, label) {
  const normalized = text(label).replace(/\s+/g, '').toUpperCase();
  const rows = basis.cartons || [];
  const exact = rows.find(row => text(row.label).replace(/\s+/g, '').toUpperCase() === normalized);
  const fallback = rows.find(row => row.label === basis.default_carton_label) || rows[0];
  return number((exact || fallback)?.rate, 2.75);
}

const normalized = value => text(value).replace(/\s+/g, '').toUpperCase();

function machineMatch(model, machines) {
  const target = normalized(model);
  const targetNumber = Number.parseFloat(target);
  for (const row of machines || []) {
    const candidate = normalized(row.model);
    const range = candidate.match(/^([\d.]+)A?-([\d.]+)A?$/);
    if (range && Number.isFinite(targetNumber)
      && targetNumber >= Number(range[1]) && targetNumber <= Number(range[2])) return row;
    if (candidate === target) return row;
  }
  return (machines || []).find(row => target.includes(normalized(row.model))) || null;
}

function applyCostingBasisPayload(dept, rawPayload, rawBasis) {
  const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
  // Original-workbook versions have an explicit dependency graph. Generic
  // amount replacements must not overwrite it or claim it was synchronized.
  if (payload.excel_native) return { payload, changed: false };
  const before = JSON.stringify(payload);
  const basis = normalizeCostingBasis(rawBasis);

  if (dept === 'sales') {
    payload.header = payload.header || {};
    payload.header.fx_rmb_hkd = basis.exchange.rmb_hkd;
    payload.header.fx_hkd_usd = basis.exchange.hkd_usd;
  }

  if (dept === 'molding') {
    payload.material_prices = clone(basis.materials);
    payload.machine_prices = clone(basis.machines);
    for (const row of Array.isArray(payload.injection) ? payload.injection : []) {
      const grade = normalized(row.material_grade);
      const material = basis.materials.find(item => normalized(item.model) === grade);
      if (material) row.material_unit_price = +(material.price / 454).toFixed(5);
      const machine = machineMatch(row.machine_model, basis.machines);
      const target = number(row.target, 0);
      const sets = number(row.sets, 1) || 1;
      if (machine && target > 0) {
        row.shot_price = number(row.mold_part_index, 0) > 0
          ? 0
          : +(machine.price / sets / target).toFixed(4);
      }
      if (machine?.normal) row.machine = machine.normal;
    }
  }

  if (dept === 'assembly') {
    payload.assembly_base_rate = basis.assembly.base_rate_hkd;
  }

  if (dept === 'engineering') {
    payload.carton_calc = payload.carton_calc || {};
    const firstCarton = Array.isArray(payload.carton_calc.cartons) ? payload.carton_calc.cartons[0] : null;
    const label = firstCarton?.ka_label || payload.carton_calc.ka_label || basis.default_carton_label;
    payload.carton_calc.paper_rate = cartonRate(basis, label);
  }

  if (dept === 'painting') {
    for (const row of Array.isArray(payload.painting_items) ? payload.painting_items : []) {
      for (const key of ['pad', 'edge', 'clamp']) {
        if (number(row[`${key}_qty`], 0) > 0 || row[`${key}_unit`] != null) {
          row[`${key}_unit`] = basis.painting[key];
        }
      }
    }
  }

  return { payload, changed: before !== JSON.stringify(payload) };
}

async function syncOpenVerificationVersionsToCostingBasis(db, { factoryCode, basis, actor }) {
  const rows = await db.prepare(`
    SELECT s.id AS section_id, s.dept, s.payload_json, s.status AS section_status,
           v.id AS version_id, v.quote_id, s.filled_at, s.reviewed_at
    FROM quote_verification_sections s
    JOIN quote_verification_versions v ON v.id = s.version_id
    JOIN quotes q ON q.id = v.quote_id
    WHERE q.factory_code = ?
      AND v.status NOT IN ('completed', 'cancelled')
      AND q.deleted_at IS NULL
      AND s.dept IN ('sales', 'engineering', 'molding', 'painting', 'assembly')
    ORDER BY v.id, s.id
  `).all(factoryCode);
  const stats = { verification_scanned: rows.length, verification_synced: 0, verification_reopened: 0 };
  const changedVersions = new Set();
  const reopenedVersions = new Set();
  for (const row of rows) {
    const version = await db.prepare(`SELECT status FROM quote_verification_versions WHERE id=?${db.pool ? ' FOR UPDATE' : ''}`).get(row.version_id);
    if (!version || ['completed','cancelled'].includes(version.status)) continue;
    let payload;
    try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
    const result = applyCostingBasisPayload(row.dept, payload, basis);
    if (!result.changed) continue;
    const reopen = row.section_status === 'approved';
    const changed = await db.prepare(`
      UPDATE quote_verification_sections
      SET payload_json=?, filled_by=?, filled_at=?,
          status=CASE WHEN ?=1 THEN 'filled' ELSE status END,
          reviewed_by=CASE WHEN ?=1 THEN NULL ELSE reviewed_by END,
          reviewed_at=CASE WHEN ?=1 THEN NULL ELSE reviewed_at END,
          review_comment=CASE WHEN ?=1 THEN ? ELSE review_comment END
      WHERE id=? AND payload_json=? AND status=?
        AND filled_at IS NOT DISTINCT FROM ? AND reviewed_at IS NOT DISTINCT FROM ?
        AND EXISTS (SELECT 1 FROM quote_verification_versions v WHERE v.id=version_id AND v.status NOT IN ('completed','cancelled'))
    `).run(JSON.stringify(result.payload), actor, nextSectionTime(row), reopen?1:0,
      reopen?1:0,reopen?1:0,reopen?1:0,reopen?`【统一核价基准更新】${basis.version}，请重新审核`:null,
      row.section_id,row.payload_json,row.section_status,row.filled_at??null,row.reviewed_at??null);
    if (!changed.changes) conflict();
    await db.prepare(`INSERT INTO audit_log (quote_id, dept, actor, action, detail)
      VALUES (?, ?, ?, 'sync_verification_costing_basis', ?)`)
      .run(row.quote_id, row.dept, actor, `核价版本 #${row.version_id} 套用统一核价基准 ${basis.version}`);
    changedVersions.add(row.version_id);
    if (reopen) reopenedVersions.add(row.version_id);
    stats.verification_synced += 1;
    if (reopen) stats.verification_reopened += 1;
  }
  for (const versionId of changedVersions) {
    await db.prepare(`UPDATE quote_verification_versions
      SET status = CASE WHEN ? = 1 THEN 'in_review' ELSE status END,
          updated_at = datetime('now')
      WHERE id = ? AND status NOT IN ('completed','cancelled')`).run(reopenedVersions.has(versionId) ? 1 : 0, versionId);
  }
  if (changedVersions.size) {
    const marks = [...changedVersions].map(() => '?').join(',');
    await db.prepare(`UPDATE quote_verifications SET status='in_progress', updated_at=datetime('now')
      WHERE quote_id IN (
        SELECT quote_id FROM quote_verification_versions WHERE id IN (${marks})
      )`).run(...changedVersions);
  }
  return stats;
}

async function syncOpenQuotesToCostingBasis(db, { factoryCode, basis: rawBasis, actor }) {
  const basis = normalizeCostingBasis(rawBasis);
  await require('./quoteFreeze').lockFactoryQuotes(db, factoryCode);
  const rows = await db.prepare(`
    SELECT s.id AS section_id, s.quote_id, s.dept, s.payload_json, s.status AS section_status,
           q.status AS quote_status
    FROM quote_sections s
    JOIN quotes q ON q.id = s.quote_id
    WHERE q.factory_code = ?
      AND q.deleted_at IS NULL
      AND q.status NOT IN ('fully_approved', 'exported')
      AND NOT EXISTS (SELECT 1 FROM quote_verifications v WHERE v.quote_id=q.id)
      AND NOT EXISTS (SELECT 1 FROM quote_customer_confirmations c WHERE c.quote_id=q.id AND c.status='confirmed')
      AND s.dept IN ('sales', 'engineering', 'molding', 'painting', 'assembly')
  `).all(factoryCode);
  const stats = { scanned: rows.length, synced: 0, reopened: 0 };
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
    const result = applyCostingBasisPayload(row.dept, payload, basis);
    if (!result.changed) continue;
    const reopen = row.section_status === 'approved';
    const changed = await db.prepare(`
      UPDATE quote_sections
      SET payload_json = ?,
          status = CASE WHEN ? = 1 THEN 'filled' ELSE status END,
          reviewed_by = CASE WHEN ? = 1 THEN NULL ELSE reviewed_by END,
          reviewed_at = CASE WHEN ? = 1 THEN NULL ELSE reviewed_at END,
          review_comment = CASE WHEN ? = 1 THEN ? ELSE review_comment END
      WHERE id = ? AND payload_json = ? AND status = ?
    `).run(
      JSON.stringify(result.payload), reopen ? 1 : 0, reopen ? 1 : 0, reopen ? 1 : 0,
      reopen ? 1 : 0, reopen ? `【统一核价基准更新】${basis.version}，请重新审核` : null,
      row.section_id, row.payload_json, row.section_status,
    );
    if (!changed.changes) conflict();
    await db.prepare(`INSERT INTO audit_log (quote_id, dept, actor, action, detail)
      VALUES (?, ?, ?, 'sync_global_costing_basis', ?)`)
      .run(row.quote_id, row.dept, actor, `统一核价基准 ${basis.version}`);
    stats.synced += 1;
    if (reopen) stats.reopened += 1;
  }
  const verificationStats = await syncOpenVerificationVersionsToCostingBasis(db, {
    factoryCode,
    basis,
    actor,
  });
  return { ...stats, ...verificationStats };
}

module.exports = {
  DEFAULT_COSTING_BASIS,
  normalizeCostingBasis,
  cartonRate,
  applyCostingBasisPayload,
  syncOpenVerificationVersionsToCostingBasis,
  syncOpenQuotesToCostingBasis,
  clone,
};
