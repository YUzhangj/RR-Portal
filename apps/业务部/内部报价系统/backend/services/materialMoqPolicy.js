'use strict';
const tables = ['hardware','aux_materials','packaging_materials','electronics','injection','blow_items','slush_items','painting_items','sewing_groups'];
function materialInputs(payload) {
  return JSON.stringify(Object.fromEntries(tables.map(key => [key, payload?.[key] || []])));
}
function adoptMaterialMoq(previous, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const active = previous?.output_moq_from_materials === true || materialInputs(previous) !== materialInputs(payload);
  if (active) payload.output_moq_from_materials = true;
  else delete payload.output_moq_from_materials;
  // Only the all-department output transaction may enable unified freight.
  if (previous?.output_unified_indonesia === true) {
    if (Number(previous.indo_pct) !== Number(payload.indo_pct)) throw Object.assign(new Error('请在报价明细的统一印尼运费栏修改比例'), {status:409});
    payload.output_unified_indonesia = true;
  }
  else delete payload.output_unified_indonesia;
  return payload;
}
module.exports = { adoptMaterialMoq };
