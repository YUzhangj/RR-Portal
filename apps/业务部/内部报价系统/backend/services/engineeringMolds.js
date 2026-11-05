'use strict';
const InjectionPricing = require('../../frontend/injection-pricing');

function expandEngineeringMolds(molds) {
  return (Array.isArray(molds) ? molds : []).flatMap(source => {
    const mold = source && typeof source === 'object' ? source : {};
    const moldImages = [...new Set((Array.isArray(mold.images) ? mold.images : []).filter(Boolean))];
    const common = {
      mold_no: mold.mold_no || '',
      sets: mold.sets ?? 1,
      material: mold.material || '',
      color: mold.color || '',
      material_grade: mold.material_grade || '',
      machine: mold.machine || '',
      machine_model: mold.machine_model || (mold.detail && mold.detail.machine_model) || '',
      target: mold.target ?? (mold.detail && mold.detail.target) ?? null,
      material_unit_price: mold.material_unit_price ?? null,
      shot_price: mold.shot_price ?? null,
      cycle_sec: mold.cycle_sec ?? null,
      product_group_id: mold.product_group_id || '',
      product_group_name: mold.product_group_name || '',
      product_group_rows: mold.product_group_rows || [],
      product_image: mold.product_image || '',
      images: moldImages,
      source_sheet_name: mold._sheet_name || '',
      source_sheet_index: mold._sheet_index ?? null,
      mold_size: mold.mold_size || (mold.detail && mold.detail.mold_size) || '',
      side_action: mold.side_action || mold.structure || '',
    };

    if (Array.isArray(mold.parts) && mold.parts.length) {
      const runCounts = new Map();
      return mold.parts.map((sourcePart, partIndex) => {
        const part = sourcePart && typeof sourcePart === 'object' ? sourcePart : {};
        const runIndex = part.injection_run_id ? (runCounts.get(part.injection_run_id) || 0) : partIndex;
        if (part.injection_run_id) runCounts.set(part.injection_run_id, runIndex + 1);
        const partImages = [...new Set((Array.isArray(part.images) ? part.images : []).filter(Boolean))];
        const expanded = {
          ...common,
          ...(part.injection_run_id ? {
            injection_run_id: part.injection_run_id,
            injection_run_name: part.injection_run_name || '',
            injection_run_part_index: runIndex,
            sets: part.sets ?? common.sets,
            target: part.target ?? common.target,
            machine: part.machine || common.machine,
            machine_model: part.machine_model || common.machine_model,
            cycle_sec: part.cycle_sec ?? common.cycle_sec,
          } : {}),
          images: partImages.length ? partImages : moldImages,
          name: part.name || '',
          material: part.material || common.material,
          color: part.color || common.color,
          material_grade: part.material_grade || common.material_grade,
          cavity: part.cavity || '',
          weight_g: part.weight_g ?? null,
          note: part.note || mold.note || '',
          mold_part_index: partIndex,
          mold_part_count: mold.parts.length,
          shot_price: part.shot_price ?? common.shot_price,
        };
        if (InjectionPricing.isAdditionalPart(expanded)) expanded.shot_price = 0;
        return expanded;
      });
    }

    return [{
      ...common,
      name: mold.name || '',
      cavity: mold.cavity || '',
      weight_g: mold.weight_g ?? null,
      note: mold.note || '',
    }];
  });
}

module.exports = { expandEngineeringMolds };
