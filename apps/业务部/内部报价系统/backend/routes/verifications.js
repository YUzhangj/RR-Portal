const express = require('express');
const db = require('../db');
const { requireAuth, quoteAccess } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const parseJson = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

function canManage(user) {
  return user.dept === 'sales' || user.role === 'admin' || Boolean(user.perms?.['账号管理']?.can_admin);
}

async function loadConfirmedQuote(user, quoteId) {
  const access = await quoteAccess(user, quoteId);
  if (access.status !== 200) return { error: access.status };
  const quote = await db.prepare(`SELECT q.*, c.confirmed_price, c.confirmed_qty, c.confirmed_by, c.confirmed_at
    FROM quotes q JOIN quote_customer_confirmations c ON c.quote_id = q.id
    WHERE q.id = ? AND q.deleted_at IS NULL AND c.status = 'confirmed'`).get(quoteId);
  return quote ? { quote } : { error: 409 };
}

router.get('/', async (req, res) => {
  let rows;
  if (req.user.role === 'admin' || req.user.perms?.['账号管理']?.can_admin) {
    rows = await db.prepare(`SELECT q.id, q.quote_no, q.product_name, q.version, q.customer,
      c.confirmed_price, c.confirmed_qty, c.confirmed_at,
      COALESCE(v.status, 'not_started') AS verification_status, v.updated_at
      FROM quotes q JOIN quote_customer_confirmations c ON c.quote_id=q.id
      LEFT JOIN quote_verifications v ON v.quote_id=q.id
      WHERE q.factory_code=? AND q.deleted_at IS NULL AND c.status='confirmed'
      ORDER BY c.confirmed_at DESC, q.id DESC`).all(req.user.active_factory_code);
  } else {
    const customers = (await db.prepare('SELECT customer FROM user_customers WHERE user_id=?').all(req.user.id)).map(r => r.customer);
    if (!customers.length) return res.json({ rows: [], can_edit: canManage(req.user) });
    const marks = customers.map(() => '?').join(',');
    rows = await db.prepare(`SELECT q.id, q.quote_no, q.product_name, q.version, q.customer,
      c.confirmed_price, c.confirmed_qty, c.confirmed_at,
      COALESCE(v.status, 'not_started') AS verification_status, v.updated_at
      FROM quotes q JOIN quote_customer_confirmations c ON c.quote_id=q.id
      LEFT JOIN quote_verifications v ON v.quote_id=q.id
      WHERE q.factory_code=? AND q.deleted_at IS NULL AND c.status='confirmed' AND q.customer IN (${marks})
      ORDER BY c.confirmed_at DESC, q.id DESC`).all(req.user.active_factory_code, ...customers);
  }
  res.json({ rows, can_edit: canManage(req.user) });
});

router.get('/:quoteId', async (req, res) => {
  const quoteId = Number(req.params.quoteId);
  const loaded = await loadConfirmedQuote(req.user, quoteId);
  if (loaded.error) return res.status(loaded.error).json({ error: loaded.error === 409 ? '报价尚未确认，不能创建核价单' : '无权查看该报价' });
  let verification = await db.prepare('SELECT * FROM quote_verifications WHERE quote_id=?').get(quoteId);
  if (!verification) {
    const sections = await db.prepare(`SELECT s.dept, d.name_cn AS dept_name, s.status, s.payload_json
      FROM quote_sections s JOIN departments d ON d.code=s.dept
      WHERE s.quote_id=? ORDER BY d.sort_order`).all(quoteId);
    const baseline = {
      quote: loaded.quote,
      sections: sections.map(s => ({ dept: s.dept, dept_name: s.dept_name, status: s.status, payload: parseJson(s.payload_json, {}) })),
      frozen_at: new Date().toISOString(),
    };
    await db.prepare(`INSERT INTO quote_verifications
      (quote_id, baseline_json, verified_values_json, created_by, updated_by)
      VALUES (?, ?, '{}', ?, ?)`)
      .run(quoteId, JSON.stringify(baseline), req.user.name, req.user.name);
    verification = await db.prepare('SELECT * FROM quote_verifications WHERE quote_id=?').get(quoteId);
    await db.prepare(`INSERT INTO audit_log (quote_id, dept, actor, action, detail)
      VALUES (?, ?, ?, 'verification_create', '从已确认报价生成核价基准快照')`)
      .run(quoteId, req.user.dept, req.user.name);
  }
  res.json({
    quote: loaded.quote,
    baseline: parseJson(verification.baseline_json, {}),
    values: parseJson(verification.verified_values_json, {}),
    verified_sections: parseJson(verification.verified_sections_json, {}),
    status: verification.status,
    note: verification.note || '',
    updated_at: verification.updated_at,
    can_edit: canManage(req.user),
  });
});

router.put('/:quoteId', async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ error: '只有业务或管理员可以填写核价' });
  const quoteId = Number(req.params.quoteId);
  const loaded = await loadConfirmedQuote(req.user, quoteId);
  if (loaded.error) return res.status(loaded.error).json({ error: '报价未确认或无权操作' });
  const existing = await db.prepare('SELECT quote_id FROM quote_verifications WHERE quote_id=?').get(quoteId);
  if (!existing) return res.status(409).json({ error: '请先打开核价单生成基准快照' });
  const rawValues = req.body?.values;
  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues) || Object.keys(rawValues).length > 5000) {
    return res.status(400).json({ error: '核价数据格式不正确' });
  }
  const values = {};
  for (const [key, value] of Object.entries(rawValues)) {
    if (typeof key !== 'string' || key.length > 300) continue;
    if (value === '' || value == null) continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return res.status(400).json({ error: `核价值不正确：${key}` });
    values[key] = number;
  }
  const rawSections = req.body?.sections || {};
  if (!rawSections || typeof rawSections !== 'object' || Array.isArray(rawSections)) {
    return res.status(400).json({ error: '核价部门数据格式不正确' });
  }
  const allowedDepartments = new Set(['sales', 'engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly']);
  const sections = {};
  for (const [department, payload] of Object.entries(rawSections)) {
    if (!allowedDepartments.has(department) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ error: `核价部门数据不正确：${department}` });
    }
    sections[department] = payload;
  }
  const sectionsJson = JSON.stringify(sections);
  if (sectionsJson.length > 2_000_000) return res.status(413).json({ error: '核价部门数据过大' });
  const status = req.body?.status === 'completed' ? 'completed' : 'in_progress';
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  await db.prepare(`UPDATE quote_verifications SET verified_values_json=?, verified_sections_json=?, status=?, note=?,
    updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE quote_id=?`)
    .run(JSON.stringify(values), sectionsJson, status, note, req.user.name, quoteId);
  await db.prepare(`INSERT INTO audit_log (quote_id, dept, actor, action, detail)
    VALUES (?, ?, ?, 'verification_save', ?)`)
    .run(quoteId, req.user.dept, req.user.name, status === 'completed' ? '完成核价' : '保存核价进度');
  res.json({ ok: true, status });
});

module.exports = router;
