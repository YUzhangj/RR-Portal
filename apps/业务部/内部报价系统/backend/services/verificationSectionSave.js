const { createHash } = require('node:crypto');
const conflict = message => Object.assign(new Error(message), { status: 409 });
function sectionRevision(section) {
  return createHash('sha256').update(JSON.stringify([
    section.id, section.payload_json || '{}', section.status,
    section.filled_at ?? null, section.reviewed_at ?? null,
  ])).digest('hex');
}
function assertSectionRevision(section, revision) {
  if (typeof revision !== 'string' || revision !== sectionRevision(section)) {
    throw conflict('该部门核价资料已更新，本次未覆盖。当前输入已保留，请复制或记录后刷新核对再保存。');
  }
}
async function saveVerificationSection(db, section, payload, submit, actor) {
  const previousTime = Date.parse(section.filled_at || '') || 0;
  const filledAt = new Date(Math.max(Date.now(), previousTime + 1)).toISOString();
  const saved = await db.prepare(`UPDATE quote_verification_sections
    SET payload_json=?, status=CASE WHEN ?=1 THEN 'filled' ELSE status END,
        filled_by=?, filled_at=?
    WHERE id=? AND version_id=? AND payload_json=? AND status=?
      AND filled_at IS NOT DISTINCT FROM ? AND reviewed_at IS NOT DISTINCT FROM ?
      AND EXISTS (SELECT 1 FROM quote_verification_versions v
        WHERE v.id=quote_verification_sections.version_id AND v.status NOT IN ('completed','cancelled'))`)
    .run(JSON.stringify(payload), submit ? 1 : 0, actor, filledAt, section.id, section.version_id,
      section.payload_json, section.status, section.filled_at ?? null, section.reviewed_at ?? null);
  if (!saved.changes) throw conflict('保存期间核价资料或审核状态已更新，本次未覆盖。当前输入已保留，请刷新核对。');
  return filledAt;
}
module.exports = { sectionRevision, assertSectionRevision, saveVerificationSection };
