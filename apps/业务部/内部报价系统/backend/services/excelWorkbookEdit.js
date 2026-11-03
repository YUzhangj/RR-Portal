const Excel = require('../../frontend/excel-formulas');
const { isDeepStrictEqual } = require('node:util');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);

// Only cell overrides are writable. Never accept a replacement source model.
function prepareWorkbookChanges(sections, changes, canEdit) {
  const payloads = Object.fromEntries(sections.map(s => [s.dept, JSON.parse(s.payload_json || '{}')]));
  const originalOverrides = Object.assign({}, ...Object.values(payloads).map(p => p.excel_native?.inputs || {}));
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
      if (!Object.hasOwn(change.inputs, id)) changedCells.push(id);
    }
    payload.excel_native = { ...payload.excel_native, inputs: change.inputs };
    updates.push({ id: section.id, payload });
  }
  const overrides = Object.assign({}, ...Object.values(payloads).map(p => p.excel_native?.inputs || {}));
  const evaluator = Excel.createEvaluator(model, overrides);
  for (const id of changedCells) {
    try { evaluator.value(id); } catch (e) { fail(400, `${id}：${e.message}`); }
  }
  // An edited input can be valid itself while breaking a dependent total or a
  // locked department's formula. Check the affected graph, including cleared
  // overrides, without rejecting unrelated errors already present in the file.
  const dependents = new Map();
  for (const [id, source] of Object.entries(model.cells)) {
    for (const previous of [originalOverrides, overrides]) {
      const cell = { ...source, ...(previous[id] || {}) };
      if (!cell.f || cell.external_input) continue;
      let references;
      try { references = Excel.references(cell.f, Excel.split(id)[0]); } catch { continue; }
      for (const reference of references) {
        if (!dependents.has(reference)) dependents.set(reference, new Set());
        dependents.get(reference).add(id);
      }
    }
  }
  const affected = new Set(changedCells), queue = [...affected];
  for (let i = 0; i < queue.length; i++) {
    for (const id of dependents.get(queue[i]) || []) if (!affected.has(id)) {
      affected.add(id);
      queue.push(id);
    }
  }
  const originalEvaluator = Excel.createEvaluator(model, originalOverrides);
  for (const id of affected) {
    try { evaluator.value(id); }
    catch (error) {
      let previousError;
      try { originalEvaluator.value(id); } catch (previous) { previousError = previous; }
      if (!previousError || previousError.message !== error.message) fail(400, `${id}：${error.message}`);
    }
  }
  return updates;
}

// The older department form submits the full payload and uses compact {v} or
// {f} overrides. Give it the same immutable-source and dependency validation as
// the whole-sheet endpoint rather than allowing it to bypass that boundary.
function prepareNativeSectionPayload(sections, sectionId, submittedPayload, canEdit) {
  const current = sections.find(section => Number(section.id) === Number(sectionId));
  if (!current) fail(404, '核价部门明细不存在');
  const payload = JSON.parse(current.payload_json || '{}');
  const sales = JSON.parse(sections.find(section => section.dept === 'sales')?.payload_json || '{}');
  const model = sales.legacy_import?.excel_model;
  if (!model) {
    if (submittedPayload?.legacy_import?.excel_model || submittedPayload?.excel_native) fail(400, '不能替换原表来源模型');
    return submittedPayload;
  }
  if (!object(payload.excel_native) || !object(submittedPayload?.excel_native)
    || !object(submittedPayload.excel_native.inputs)) fail(400, '原表单元格修改格式不正确');
  const withoutInputs = value => ({ ...value, excel_native: { ...value.excel_native, inputs: {} } });
  if (!isDeepStrictEqual(withoutInputs(payload), withoutInputs(submittedPayload))) fail(403, '只能修改本部门原表单元格，不能替换来源或其他核价资料');
  function normalized(inputs) {
    return Object.fromEntries(Object.entries(inputs || {}).map(([id, input]) => {
      if (!object(input)) fail(400, '单元格内容不正确');
      const override = { ...input };
      override.t ??= model.cells[id]?.t === 's' ? 's' : 'n';
      if (typeof override.f === 'string' && override.f) override.external_input ??= false;
      else if (!Object.hasOwn(override, 'f')) override.f = null;
      return [id, override];
    }));
  }
  const preparedSections = sections.map(section => {
    const original = JSON.parse(section.payload_json || '{}');
    if (original.excel_native) original.excel_native.inputs = normalized(original.excel_native.inputs);
    return { ...section, payload_json: JSON.stringify(original) };
  });
  const updates = prepareWorkbookChanges(preparedSections, [{ section_id: current.id,
    base_inputs: normalized(payload.excel_native.inputs), inputs: normalized(submittedPayload.excel_native.inputs) }], canEdit);
  return updates[0].payload;
}
module.exports = { prepareWorkbookChanges, prepareNativeSectionPayload };
