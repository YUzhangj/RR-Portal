(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InjectionPricing = factory();
})(typeof window === 'undefined' ? this : window, function () {
  'use strict';
  const blank = value => value === '' || value == null;
  const positive = value => !blank(value) && Number.isFinite(Number(value)) && Number(value) > 0;
  const normalize = value => String(value || '').replace(/\s+/g, '').toUpperCase();

  function lookupMachinePrice(model, prices) {
    const key = normalize(model);
    if (!key || !Array.isArray(prices)) return null;
    const exact = prices.find(item => normalize(item.model) === key);
    if (exact) return exact;
    const match = key.match(/^(\d+(?:\.\d+)?)A?$/);
    if (!match) return null;
    return prices.find(item => {
      const range = normalize(item.model).match(/^(\d+(?:\.\d+)?)A?-(\d+(?:\.\d+)?)A?$/);
      return range && +match[1] >= +range[1] && +match[1] <= +range[2];
    }) || null;
  }

  function parameters(row, prices) {
    const machine = lookupMachinePrice(row.machine_model, prices);
    const sets = blank(row.sets) ? 1 : Number(row.sets);
    const price = machine && !blank(machine.price) ? Number(machine.price) : null;
    return { machine, price, sets, target: Number(row.target), valid:
      price !== null && Number.isFinite(price) && price >= 0 && positive(row.target) && positive(sets) };
  }

  // 工程明确标记的同次啤后续零件不重复计啤工；目录分阶段分摊另行计算。
  function isAdditionalPart(row) {
    return row.catalog_raw_weight == null && Number(row.injection_run_part_index ?? row.mold_part_index) > 0;
  }

  function laborPrice(row) {
    return isAdditionalPart(row) ? 0 : row.shot_price;
  }

  function calculate(row, prices) {
    if (isAdditionalPart(row)) return 0;
    const p = parameters(row, prices);
    return p.valid ? +(p.price / p.sets / p.target).toFixed(4) : null;
  }

  function reprice(row, prices) {
    // 共模分阶段封穴的零件单价由分摊模型计算，不能再按普通整模公式覆盖。
    if (row.catalog_raw_weight != null) return;
    row.shot_price = calculate(row, prices);
    row.shot_price_mode = 'auto';
    const machine = lookupMachinePrice(row.machine_model, prices);
    row.machine = machine?.normal || '';
  }

  function signature(row, prices) {
    const p = parameters(row, prices);
    return JSON.stringify([normalize(row.machine_model), p.price, p.sets,
      blank(row.target) ? null : row.target, Number(row.injection_run_part_index ?? row.mold_part_index) || 0]);
  }

  return { lookupMachinePrice, parameters, isAdditionalPart, laborPrice, calculate, reprice, signature };
});
