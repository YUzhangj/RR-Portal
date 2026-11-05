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

  function hasRunIdentity(row) {
    return row.catalog_raw_weight == null && typeof row.injection_run_id === 'string' &&
      /^row:[1-9]\d*$/.test(row.injection_run_id) &&
      typeof row.source_sheet_name === 'string' && row.source_sheet_name.trim() !== '' &&
      Number.isSafeInteger(row.source_sheet_index) && row.source_sheet_index >= 0 &&
      typeof row.mold_no === 'string' && row.mold_no.trim() !== '' && !blank(row.injection_run_part_index) &&
      Number.isSafeInteger(row.injection_run_part_index) && row.injection_run_part_index >= 0;
  }

  // 旧的零件顺序不是啤次身份。未重新导入并明确同步的历史行保留原价。
  function isAdditionalPart(row) {
    return hasRunIdentity(row) && Number(row.injection_run_part_index) > 0;
  }

  function laborPrice(row) {
    return isAdditionalPart(row) ? 0 : row.shot_price;
  }

  function decimalFraction(value) {
    // Values have already passed finite/non-negative validation. Number's
    // canonical decimal string also covers scientific notation without using
    // the binary approximation at a four-decimal rounding boundary.
    const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    const coefficient = BigInt(whole + fraction);
    const scale = fraction.length - Number(exponent);
    return scale >= 0 ? [coefficient, 10n ** BigInt(scale)] : [coefficient * 10n ** BigInt(-scale), 1n];
  }

  function roundedLabor(price, sets, target) {
    const [pn, pd] = decimalFraction(price), [sn, sd] = decimalFraction(sets), [tn, td] = decimalFraction(target);
    const numerator = pn * sd * td * 10000n, denominator = pd * sn * tn;
    let rounded = numerator / denominator;
    if ((numerator % denominator) * 2n >= denominator) rounded++;
    // Convert after inserting the decimal point: converting the scaled integer
    // first could overflow even when the final four-decimal value is finite.
    const result = Number(`${rounded / 10000n}.${String(rounded % 10000n).padStart(4, '0')}`);
    return Number.isFinite(result) ? result : null;
  }

  function calculate(row, prices) {
    if (isAdditionalPart(row)) return 0;
    const p = parameters(row, prices);
    return p.valid ? roundedLabor(p.price, p.sets, p.target) : null;
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
      blank(row.target) ? null : row.target, hasRunIdentity(row)
        ? ['run', row.injection_run_id, Number(row.injection_run_part_index)]
        : ['legacy', Number(row.mold_part_index) || 0]]);
  }

  function runKey(row) {
    if (!hasRunIdentity(row)) return null;
    return JSON.stringify([row.source_sheet_index, row.source_sheet_name,
      row.product_group_id || row.product_group_name || '', row.mold_no, row.injection_run_id]);
  }

  function applyRunStructureChange({ type, row, copy, rows, previousRows }) {
    if (!['copy', 'delete'].includes(type) || row.catalog_raw_weight != null || !row.injection_run_id) {
      return { allowed: true, changed: false };
    }
    const key = runKey(row);
    const previous = key == null ? [] : previousRows.filter(item => runKey(item) === key);
    const indexes = previous.map(item => Number(item.injection_run_part_index));
    if (key == null || !previous.includes(row) || new Set(indexes).size !== indexes.length ||
        previous.filter(item => Number(item.injection_run_part_index) === 0).length !== 1) {
      return { allowed: false, changed: false,
        message: '啤次来源或计费行不明确，请先重新导入源排模表并同步模具后再拆分或删除。' };
    }
    if (type === 'copy') {
      const nextIndex = Math.max(...indexes) + 1;
      if (!copy || !rows.includes(copy) || !Number.isSafeInteger(nextIndex)) return { allowed: false, changed: false };
      copy.injection_run_part_index = nextIndex;
      copy.shot_price = 0;
      copy.shot_price_mode = 'auto';
      return { allowed: true, changed: true };
    }
    if (Number(row.injection_run_part_index) !== 0) return { allowed: true, changed: false };
    const remaining = rows.filter(item => runKey(item) === key)
      .sort((a, b) => Number(a.injection_run_part_index) - Number(b.injection_run_part_index));
    if (!remaining.length) return { allowed: true, changed: false };
    const next = remaining[0];
    // 同一准确啤次仍存在：原计费值及来源原样交接，不从别的零件猜价或重算手填价。
    for (const field of ['shot_price', 'shot_price_mode', 'machine_model', 'machine', 'target', 'sets', 'cycle_sec']) {
      if (Object.prototype.hasOwnProperty.call(row, field)) next[field] = row[field];
      else delete next[field];
    }
    next.injection_run_part_index = 0;
    return { allowed: true, changed: true };
  }

  return { lookupMachinePrice, parameters, hasRunIdentity, isAdditionalPart, laborPrice,
    calculate, reprice, signature, applyRunStructureChange };
});
