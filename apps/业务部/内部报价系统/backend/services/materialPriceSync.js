function parsePayload(raw) {
  try {
    const payload = JSON.parse(raw || '{}');
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  } catch {
    return {};
  }
}

function normalized(value) {
  return String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

function sameRows(left, right) {
  return JSON.stringify(Array.isArray(left) ? left : []) === JSON.stringify(Array.isArray(right) ? right : []);
}

function applyMaterialPrices(payload, prices) {
  const next = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const referenceChanged = !sameRows(next.material_prices, prices);
  next.material_prices = JSON.parse(JSON.stringify(prices));

  let injectionRowsChanged = 0;
  for (const row of Array.isArray(next.injection) ? next.injection : []) {
    const grade = normalized(row.material_grade);
    if (!grade) continue;
    const match = prices.find((item) => normalized(item.model) === grade);
    if (!match) continue;
    const unitPrice = +(Number(match.price || 0) / 454).toFixed(5);
    if (Number(row.material_unit_price) !== unitPrice) {
      row.material_unit_price = unitPrice;
      injectionRowsChanged += 1;
    }
  }
  return { payload: next, referenceChanged, injectionRowsChanged };
}

function completedBeforeEffective(row, effectiveAt) {
  // 已导出的文件属于历史快照，任何后续料价发布都不能回写。
  if (row.quote_status === 'exported') return true;
  if (row.quote_status !== 'fully_approved' || !row.fully_approved_at) return false;
  const raw = String(row.fully_approved_at);
  const approvalTime = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z').getTime();
  return approvalTime < new Date(effectiveAt).getTime();
}

async function syncOpenQuotes(db, { factoryCode, prices, effectiveAt, actor }) {
  const rows = await db.prepare(`
    SELECT s.id AS section_id, s.quote_id, s.payload_json, s.status AS section_status,
           q.status AS quote_status,
           (SELECT MAX(reviewed_at) FROM quote_sections x WHERE x.quote_id = q.id) AS fully_approved_at
    FROM quote_sections s
    JOIN quotes q ON q.id = s.quote_id
    WHERE q.factory_code = ? AND s.dept = 'molding'
  `).all(factoryCode);

  const stats = { scanned: rows.length, synced: 0, skipped_approved: 0, reopened: 0, injection_rows_changed: 0 };
  for (const row of rows) {
    if (completedBeforeEffective(row, effectiveAt)) {
      stats.skipped_approved += 1;
      continue;
    }
    const result = applyMaterialPrices(parsePayload(row.payload_json), prices);
    if (!result.referenceChanged && result.injectionRowsChanged === 0) continue;

    const reopen = row.section_status === 'approved' && result.injectionRowsChanged > 0;
    await db.prepare(`
      UPDATE quote_sections
      SET payload_json = ?,
          status = CASE WHEN ? = 1 THEN 'filled' ELSE status END,
          reviewed_by = CASE WHEN ? = 1 THEN NULL ELSE reviewed_by END,
          reviewed_at = CASE WHEN ? = 1 THEN NULL ELSE reviewed_at END,
          review_comment = CASE WHEN ? = 1 THEN ? ELSE review_comment END
      WHERE id = ?
    `).run(
      JSON.stringify(result.payload), reopen ? 1 : 0, reopen ? 1 : 0, reopen ? 1 : 0,
      reopen ? 1 : 0, reopen ? `【全局料价更新】${effectiveAt} 起生效，请重新审核` : null,
      row.section_id,
    );
    if (reopen) {
      await db.prepare("UPDATE quotes SET status = 'drafting' WHERE id = ? AND status IN ('fully_approved', 'exported')")
        .run(row.quote_id);
      stats.reopened += 1;
    }
    await db.prepare(`INSERT INTO audit_log (quote_id, dept, actor, action, detail)
      VALUES (?, 'molding', ?, 'sync_global_material_prices', ?)`)
      .run(row.quote_id, actor, `生效时间 ${effectiveAt}; 更新注塑单价 ${result.injectionRowsChanged} 行`);
    stats.synced += 1;
    stats.injection_rows_changed += result.injectionRowsChanged;
  }
  return stats;
}

module.exports = { applyMaterialPrices, completedBeforeEffective, syncOpenQuotes };
