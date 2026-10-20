const { createHash } = require('node:crypto');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function reviewState(version, sections, canReview) {
  let imported = false;
  try { imported = Boolean(JSON.parse(sections.find(s => s.dept === 'sales')?.payload_json || '{}').legacy_import?.excel_model); } catch {}
  const allowed = imported && sections.length > 0 && !['completed','cancelled'].includes(version.status)
    && sections.every(canReview);
  const token = createHash('sha256').update(JSON.stringify([version.id, version.status,
    [...sections].sort((a,b) => a.id-b.id).map(s => [s.id,s.status,s.payload_json,s.filled_at,s.reviewed_at])])).digest('hex');
  return { imported, allowed, ready: allowed && sections.some(s => s.status === 'filled')
    && sections.every(s => ['filled','approved'].includes(s.status)), token };
}
function prepareWorkbookReview(version, sections, canReview, token) {
  const state = reviewState(version, sections, canReview);
  if (!state.imported) fail(409, '一键审核仅适用于导入的整表核价');
  if (['completed','cancelled'].includes(version.status)) fail(409, '该核价版本已锁定');
  if (!state.allowed) fail(403, '没有整表审核权限');
  if (typeof token !== 'string' || token !== state.token) fail(409, '核价内容或审核状态已变动，请刷新确认后再审核');
  if (sections.some(s => !['filled','approved'].includes(s.status))) fail(409, '请先提交整表审核，不能直接通过草稿或已驳回的内容');
  return sections.filter(s => s.status === 'filled');
}
module.exports = { reviewState, prepareWorkbookReview };
