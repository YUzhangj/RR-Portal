const Excel = require('../../frontend/excel-formulas');
const { isDeepStrictEqual } = require('node:util');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);

// Only cell overrides are writable. Never accept a replacement source model.
function prepareWorkbookChanges(sections, changes, canEdit) {
  const payloads = Object.fromEntries(sections.map(s => [s.dept, JSON.parse(s.payload_json || '{}')]));
  const model = payloads.sales?.legacy_import?.excel_model;
  if (!model) fail(409, '该版本不是原表公式核价');
  if (!Array.isArray(changes) || !changes.length || changes.length > sections.length) fail(400, '表格修改格式不正确');
  const seen = new Set(), updates = [], changedCells = [];
  for (const change of changes) {
    const section = sections.find(s => Number(s.id) === Number(change.section_id));
    if (!section || seen.has(section.id)) fail(400, '核价部门不存在或重复');
    seen.add(section.id);
    if (!canEdit(section)) fail(403, '没有修改该部分的权限，或该部分已审核锁定');
    if (!object(change.inputs) || !object(change.base_inputs)) fail(400, '单元格修改格式不正确');
    const payload = payloads[section.dept], original = payload.excel_native?.inputs || {};
    if (!isDeepStrictEqual(original, change.base_inputs)) fail(409, '表格已被其他人修改，请刷新后重新编辑');
    for (const [id, override] of Object.entries(change.inputs)) {
      if (isDeepStrictEqual(original[id], override)) continue;
      const cell = model.cells[id];
      if (!cell || cell.missing_sheet || (cell.owner || 'sales') !== section.dept) fail(403, '不能修改其他部门或未导入的单元格');
      if (!object(override) || Object.keys(override).some(k => !['v', 'f', 't', 'external_input'].includes(k))) fail(400, '单元格内容不正确');
      if (!['n', 's'].includes(override.t)) fail(400, '单元格类型不正确');
      if (typeof override.f === 'string' && override.f.length && override.f.length < 10000) {
        let refs;
        try { refs = Excel.references(override.f, Excel.split(id)[0]); } catch (e) { fail(400, e.message); }
        if (refs.some(ref => !Object.hasOwn(model.cells, ref))) fail(400, '引用的单元格未导入');
        if (override.external_input !== false) fail(400, '公式必须重新计算');
      } else if (override.f !== null || !(override.v === null || typeof override.v === 'string' || (typeof override.v === 'number' && Number.isFinite(override.v)))) {
        fail(400, '数值或公式不正确');
      }
      changedCells.push(id);
    }
    for (const id of Object.keys(original)) {
      if (!Object.hasOwn(change.inputs, id) && (model.cells[id]?.owner || 'sales') !== section.dept) fail(403, '不能移除其他部门的修改');
    }
    payload.excel_native = { ...payload.excel_native, inputs: change.inputs };
    updates.push({ id: section.id, payload });
  }
  const overrides = Object.assign({}, ...Object.values(payloads).map(p => p.excel_native?.inputs || {}));
  const evaluator = Excel.createEvaluator(model, overrides);
  for (const id of changedCells) {
    try { evaluator.value(id); } catch (e) { fail(400, `${id}：${e.message}`); }
  }
  return updates;
}
module.exports = { prepareWorkbookChanges };
