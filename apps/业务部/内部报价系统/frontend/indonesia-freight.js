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
    if (data.sales?.output_unified_indonesia === true && valid(data.sales?.indo_pct)) return Number(data.sales.indo_pct);
    // 未明确保存统一比例的历史单，继续使用各部门原始值；0 也是有效业务值。
    return null;
  }

  function apply(payload, percentage) {
    payload.indo_pct = percentage;
    for (const child of Object.values(payload.mixed_products || {})) apply(child, percentage);
    if (payload.mixed_shared) apply(payload.mixed_shared, percentage);
    return payload;
  }
  function normalizeSections(sections, percentage = rate(sections)) {
    if (!valid(percentage)) return sections || [];
    const data = payloads(sections);
    return (sections || []).map(section => section.payload_json === null ? section : ({ ...section,
      payload_json: JSON.stringify(departments.includes(section.dept)
        ? apply(data[section.dept], percentage) : data[section.dept]),
    }));
  }
  return { departments, rate, apply, normalizeSections };
});
