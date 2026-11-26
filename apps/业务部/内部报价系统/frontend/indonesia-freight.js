(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IndonesiaFreight = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const departments = ['sales', 'engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing'];
  const valid = value => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value)) && Number(value) >= 0;
  function payloads(sections) {
    return Object.fromEntries((sections || []).map(section => {
      try { return [section.dept, JSON.parse(section.payload_json || '{}') || {}]; }
      catch { return [section.dept, {}]; }
    }));
  }
  function rate(sections) {
    const data = payloads(sections);
    if (valid(data.sales?.indo_pct)) return Number(data.sales.indo_pct);
    // 旧报价通常只有工程材料表填写比例，其他部门的 0 是占位默认值。
    for (const dept of departments.slice(1)) {
      const payload = data[dept] || {};
      const candidates = [payload, ...Object.values(payload.mixed_products || {}), payload.mixed_shared || {}];
      const match = candidates.find(item => valid(item.indo_pct) && Number(item.indo_pct) > 0);
      if (match) return Number(match.indo_pct);
    }
    return 0;
  }
  function apply(payload, percentage) {
    payload.indo_pct = percentage;
    for (const child of Object.values(payload.mixed_products || {})) apply(child, percentage);
    if (payload.mixed_shared) apply(payload.mixed_shared, percentage);
    return payload;
  }
  function normalizeSections(sections, percentage = rate(sections)) {
    const data = payloads(sections);
    return (sections || []).map(section => section.payload_json === null ? section : ({ ...section,
      payload_json: JSON.stringify(departments.includes(section.dept)
        ? apply(data[section.dept], percentage) : data[section.dept]),
    }));
  }
  return { departments, rate, apply, normalizeSections };
});
