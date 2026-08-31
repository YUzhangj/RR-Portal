const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { syncOpenQuotes } = require('../services/materialPriceSync');

const router = express.Router();
router.use(requireAuth);

const ALLOWED = new Set(['material_prices', 'machine_prices']);

// GET /api/refs/:key — 拉全局参考表
router.get('/:key', async (req, res) => {
  const key = req.params.key;
  if (!ALLOWED.has(key)) return res.status(400).json({ error: 'invalid key' });
  const row = await db.prepare('SELECT data_json, updated_at, updated_by FROM factory_ref_tables WHERE factory_code = ? AND key = ?')
    .get(req.user.active_factory_code, key);
  if (!row) return res.json({ data: [], updated_at: null, updated_by: null });
  let data = [];
  try { data = JSON.parse(row.data_json); } catch {}
  if (key !== 'material_prices') {
    return res.json({ data, updated_at: row.updated_at, updated_by: row.updated_by });
  }
  const control = await db.prepare(`SELECT last_effective_at FROM factory_material_price_control
    WHERE factory_code = ?`).get(req.user.active_factory_code);
  const managers = await db.prepare(`SELECT u.id, u.username, u.display_name
    FROM factory_material_price_managers m JOIN users u ON u.id = m.user_id
    WHERE m.factory_code = ? ORDER BY u.display_name, u.username`).all(req.user.active_factory_code);
  res.json({
    data,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    can_manage_global: managers.some(manager => Number(manager.id) === Number(req.user.id)),
    manager_user_ids: managers.map(manager => manager.id),
    manager_names: managers.map(manager => manager.display_name || manager.username),
    manager_name: managers.map(manager => manager.display_name || manager.username).join('、') || null,
    last_effective_at: control?.last_effective_at || null,
  });
});

// PUT /api/refs/:key — 料价仅允许本厂区指定账号发布；机型价沿用原权限。
router.put('/:key', async (req, res) => {
  const key = req.params.key;
  if (!ALLOWED.has(key)) return res.status(400).json({ error: 'invalid key' });
  const data = Array.isArray(req.body && req.body.data) ? req.body.data : [];

  if (key === 'material_prices') {
    const manager = await db.prepare(`SELECT 1 FROM factory_material_price_managers
      WHERE factory_code = ? AND user_id = ?`).get(req.user.active_factory_code, req.user.id);
    if (!manager) {
      return res.status(403).json({ error: '只有本厂区指定的全局料价管理员可以发布并同步全部报价' });
    }
    const requestedEffectiveAt = String((req.body && req.body.effective_at) || '').trim();
    const effectiveDate = new Date(requestedEffectiveAt);
    if (!requestedEffectiveAt || Number.isNaN(effectiveDate.getTime())) {
      return res.status(400).json({ error: '请选择有效的料价生效时间' });
    }
    if (effectiveDate.getTime() > Date.now() + 60 * 1000) {
      return res.status(400).json({ error: '生效时间不能晚于当前时间；此时间用于划分已审核历史报价' });
    }
    const effectiveAt = effectiveDate.toISOString();
    const actor = `[全局料价] ${req.user.name}`;
    const publish = db.transaction(async () => {
      await db.prepare(`
        INSERT INTO factory_ref_tables (factory_code, key, data_json, updated_at, updated_by)
        VALUES (?, 'material_prices', ?, datetime('now'), ?)
        ON CONFLICT(factory_code,key) DO UPDATE SET
          data_json = excluded.data_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(req.user.active_factory_code, JSON.stringify(data), actor);
      const stats = await syncOpenQuotes(db, {
        factoryCode: req.user.active_factory_code, prices: data, effectiveAt, actor,
      });
      await db.prepare(`UPDATE factory_material_price_control
        SET last_effective_at = ?, updated_at = datetime('now'), updated_by = ?
        WHERE factory_code = ?`)
        .run(effectiveAt, req.user.name, req.user.active_factory_code);
      await db.prepare(`INSERT INTO audit_log (actor, action, detail)
        VALUES (?, 'publish_global_material_prices', ?)`)
        .run(actor, `${req.user.active_factory_code}; 生效时间 ${effectiveAt}; 同步 ${stats.synced}; 保留已审 ${stats.skipped_approved}`);
      return stats;
    });
    const stats = await publish();
    return res.json({ ok: true, effective_at: effectiveAt, ...stats });
  }

  if (!['sales', 'engineering', 'molding'].includes(req.user.dept)) {
    return res.status(403).json({ error: '没有权限修改参考表' });
  }
  await db.prepare(`
    INSERT INTO factory_ref_tables (factory_code, key, data_json, updated_at, updated_by) VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(factory_code, key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(req.user.active_factory_code, key, JSON.stringify(data), `[${req.user.dept}] ${req.user.name}`);
  res.json({ ok: true });
});

module.exports = router;
