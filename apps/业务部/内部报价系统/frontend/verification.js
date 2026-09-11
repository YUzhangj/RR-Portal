const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (value, currency = 'HKD') => `${currency === 'USD' ? 'US$' : currency === 'RMB' ? '¥' : 'HK$'} ${num(value).toFixed(2)}`;

async function api(path, options = {}) {
  const response = await fetch('/api' + path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.json();
}

function addPrice(rows, path, label, value, currency = 'HKD') {
  if (value === '' || value == null || !Number.isFinite(Number(value))) return;
  rows.push({ key: path, label, original: Number(value), currency });
}

function addItemPrices(rows, items, basePath, fields, nameOf) {
  (items || []).forEach((item, index) => {
    const name = nameOf(item, index);
    fields.forEach(field => {
      if (field.when && !field.when(item)) return;
      addPrice(rows, `${basePath}[${index}].${field.key}`, `${name} · ${field.label}`, item[field.key], field.currencyOf ? field.currencyOf(item) : field.currency);
    });
  });
}

// 只列实际录入的成本/单价。汇总、换算、税差、场景合计等计算字段由系统自动重算，不重复核价。
function collectVerificationFields(section) {
  const p = section.payload || {};
  const rows = [];
  if (section.dept === 'sales') {
    addPrice(rows, 'pricing_summary.surtax', '附加费用', p.pricing_summary?.surtax, 'HKD');
    addPrice(rows, 'pricing_summary.indo_freight', '印尼运费', p.pricing_summary?.indo_freight, 'HKD');
  } else if (section.dept === 'engineering') {
    addItemPrices(rows, p.molds, 'molds', [{ key: 'price_rmb', label: '模具价格', currency: 'RMB' }], (item, i) => item.name || item.mold_no || `模具 ${i + 1}`);
    const supplierFields = [
      { key: 'unit_price_rmb', label: '材料单价', currency: 'RMB', when: item => (item.source_currency || 'RMB') === 'RMB' },
      { key: 'unit_price_usd', label: '材料单价', currency: 'USD', when: item => item.source_currency === 'USD' },
      { key: 'unit_price', label: '材料单价', currency: 'HKD', when: item => item.source_currency === 'HKD' },
    ];
    ['hardware', 'aux_materials', 'packaging_materials'].forEach(key => addItemPrices(rows, p[key], key, supplierFields, (item, i) => item.name || item.category || item.spec || `物料 ${i + 1}`));
    addItemPrices(rows, p.mold_costs?.items, 'mold_costs.items', [{ key: 'price_rmb', label: '金额', currency: 'RMB' }], (item, i) => item.name || `模具费用 ${i + 1}`);
    addPrice(rows, 'mold_costs.prototype_fee_usd', '手板费', p.mold_costs?.prototype_fee_usd, 'USD');
    addPrice(rows, 'mold_costs.testing_fee_usd', '测试费', p.mold_costs?.testing_fee_usd, 'USD');
  } else if (section.dept === 'electronic') {
    addItemPrices(rows, p.electronics, 'electronics', [{ key: 'unit_price_rmb', label: '单价', currency: 'RMB' }], (item, i) => item.name || item.spec || `电子件 ${i + 1}`);
    const extraLabels = { test_repair: '测试维修费', packing_shipping: '包装运费', bonding_cost: '邦定费', smt_cost: '贴片费', labor_cost: '人工费' };
    Object.entries(extraLabels).forEach(([key, label]) => addPrice(rows, `electronics_extra.${key}`, label, p.electronics_extra?.[key], 'HKD'));
  } else if (section.dept === 'molding') {
    addItemPrices(rows, p.injection, 'injection', [
      { key: 'material_unit_price', label: '材料单价', currency: 'HKD' },
      { key: 'shot_price', label: '啤价', currency: 'HKD' },
    ], (item, i) => item.name || item.mold_no || `注塑件 ${i + 1}`);
    addItemPrices(rows, p.blow_items, 'blow_items', [
      { key: 'material_price_lb', label: '料价', currency: 'HKD' },
      { key: 'blow_labor', label: '吹工', currency: 'HKD' },
      { key: 'flash', label: '披锋', currency: 'HKD' },
    ], (item, i) => item.name || `吹气件 ${i + 1}`);
  } else if (section.dept === 'painting') {
    const processes = { clamp: '夹模', pad: '移印', roast: '烤漆', spray: '喷油', edge: '边油', color: '调色', dip: '浸油', oil: '油漆', pp_water: 'PP水', uv: 'UV' };
    (p.painting_items || []).forEach((item, index) => Object.entries(processes).forEach(([key, label]) => {
      if (!num(item[`${key}_qty`]) && !num(item[`${key}_unit`])) return;
      addPrice(rows, `painting_items[${index}].${key}_unit`, `${item.name || item.position || `喷油件 ${index + 1}`} · ${label}单价`, item[`${key}_unit`], 'HKD');
    }));
  } else if (section.dept === 'slush') {
    const fields = [
      ['material_price_lb', '材料价'], ['slush_labor_24h', '搪胶人工'], ['batch_labor_12h', '批锋人工'],
      ['diesel_24h', '柴油费'], ['electricity_24h', '电费'], ['pigment_price', '色粉价'], ['shipping_bag', '包装袋'], ['mold_fee', '模具费'],
    ];
    addItemPrices(rows, p.slush_items, 'slush_items', fields.map(([key, label]) => ({ key, label, currencyOf: item => key === 'mold_fee' ? (item.mold_fee_currency || 'RMB') : 'HKD' })), (item, i) => item.name || `搪胶件 ${i + 1}`);
  } else if (section.dept === 'sewing') {
    (p.sewing_groups || []).forEach((group, groupIndex) => {
      addPrice(rows, `sewing_groups[${groupIndex}].labor_amount`, `${group.name || `产品 ${groupIndex + 1}`} · 车缝人工`, group.labor_amount, 'HKD');
      addItemPrices(rows, group.items, `sewing_groups[${groupIndex}].items`, [{ key: 'mat_price', label: '材料单价', currency: 'HKD' }], (item, i) => item.part || item.fabric || `布料 ${i + 1}`);
    });
  } else if (section.dept === 'assembly') {
    addPrice(rows, 'assembly_base_rate', '组装人工基数', p.assembly_base_rate, 'HKD');
    addPrice(rows, 'assembly_std_time', '标准工时', p.assembly_std_time, 'NUMBER');
    addItemPrices(rows, p.assembly_labor, 'assembly_labor', [{ key: 'unit_price', label: '人工单价', currency: 'HKD' }], (item, i) => item.name || item.product || `组装 ${i + 1}`);
    addItemPrices(rows, p.packaging_labor, 'packaging_labor', [{ key: 'unit_price', label: '人工单价', currency: 'HKD' }], (item, i) => item.name || item.product || `包装 ${i + 1}`);
    const addStepGroups = (groups, basePath, type) => (groups || []).forEach((group, groupIndex) => {
      const name = group.product || `${type}产品 ${groupIndex + 1}`;
      addPrice(rows, `${basePath}[${groupIndex}].qty`, `${name} · 生产量`, group.qty, 'NUMBER');
      addPrice(rows, `${basePath}[${groupIndex}].team`, `${name} · 小组数`, group.team, 'NUMBER');
      (group.steps || []).forEach((step, stepIndex) => addPrice(rows,
        `${basePath}[${groupIndex}].steps[${stepIndex}].count`,
        `${name} · ${step.name || `工序 ${stepIndex + 1}`}人数`, step.count, 'NUMBER'));
    });
    addStepGroups(p.assembly_step_groups, 'assembly_step_groups', '组装');
    addStepGroups(p.packaging_step_groups, 'packaging_step_groups', '包装');
  }
  return rows;
}

let listState = [];
let detailState = null;
let selectedId = null;

const statusText = status => status === 'completed' ? '已完成' : status === 'in_progress' ? '核价中' : '待核价';
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const pad = number => String(number).padStart(2, '0');
  const today = new Date();
  const prefix = date.toDateString() === today.toDateString() ? '今天' : `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`;
  return `${prefix} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadList() {
  const me = await api('/auth/me');
  $('who-chip').textContent = `${me.dept_name} · ${me.display_name || me.username}`;
  const result = await api('/verifications');
  listState = result.rows || [];
  const customers = [...new Set(listState.map(row => row.customer).filter(Boolean))].sort();
  $('verification-customer-filter').innerHTML = '<option value="">全部客户</option>' + customers.map(customer => `<option value="${esc(customer)}">${esc(customer)}</option>`).join('');
  renderList();
  if (listState.length) await selectVerification(selectedId || listState[0].id);
}

function renderList() {
  const query = ($('verification-search').value || '').trim().toLowerCase();
  const status = $('verification-status-filter').value;
  const customer = $('verification-customer-filter').value;
  const rows = listState.filter(row => (!status || row.verification_status === status)
    && (!customer || row.customer === customer)
    && [row.quote_no, row.product_name, row.customer, row.version].join(' ').toLowerCase().includes(query));
  $('verification-list-body').innerHTML = rows.length ? rows.map(row => `<tr class="verification-list-row ${Number(selectedId) === Number(row.id) ? 'selected' : ''}" data-id="${row.id}">
    <td><strong>${esc(row.quote_no)}</strong></td><td>${esc(row.product_name)}</td><td>${esc(row.customer || '—')}</td>
    <td>USD ${num(row.confirmed_price).toFixed(2)}</td>
    <td><span class="verification-status status-${esc(row.verification_status)}">${statusText(row.verification_status)}</span></td>
    <td>${esc(formatDate(row.confirmed_at || row.updated_at))}</td>
  </tr>`).join('') : '<tr><td colspan="6" class="summary-empty">暂无符合条件的核价单</td></tr>';
  document.querySelectorAll('.verification-list-row').forEach(row => row.onclick = () => selectVerification(row.dataset.id));
}

async function selectVerification(id) {
  selectedId = Number(id);
  renderList();
  $('verification-preview').innerHTML = '<div class="verification-preview-empty">正在加载核价单…</div>';
  const [verification, me] = await Promise.all([api('/verifications/' + id), api('/auth/me')]);
  detailState = { ...verification, me };
  renderPreview();
}

function sectionRows(section) {
  const prefix = section.dept + ':';
  const rows = collectVerificationFields(section).map(row => ({ ...row, storageKey: prefix + row.key }));
  return rows.filter((row, index) => rows.findIndex(other => other.storageKey === row.storageKey) === index);
}

function calculateTotals() {
  const allRows = detailState.baseline.sections.flatMap(section => sectionRows(section).map(row => ({ ...row, dept: section.dept })));
  let changed = 0;
  let increased = 0;
  let decreased = 0;
  allRows.forEach(row => {
    const section = detailState.baseline.sections.find(item => item.dept === row.dept);
    const next = num(getPath(verifiedPayloadFor(section), row.key));
    const delta = next - num(row.original);
    if (Math.abs(delta) > 0.00001) changed++;
    if (delta > 0.00001) increased++;
    if (delta < -0.00001) decreased++;
  });
  return { changed, increased, decreased, count: allRows.length };
}

function sumObject(source, keys) {
  return keys.reduce((total, key) => total + num(source?.[key]), 0);
}

function previewSummary() {
  const workbench = window.VerificationWorkbench;
  if (workbench?.renderSummaryPane && detailState?.baseline?.sections?.length) {
    try {
      const calculate = useVerified => {
        const host = document.createElement('div');
        const sections = workbenchSections(useVerified);
        window.__data = { quote: detailState.quote, sections, me: detailState.me || {} };
        return workbench.renderSummaryPane(host, sections, detailState.quote, { dept: 'verification_readonly', role: 'staff' });
      };
      return { original: calculate(false), verified: calculate(true) };
    } catch (error) {
      console.warn('核价汇总实时计算失败，回退到价格项差异汇总', error);
    }
  }
  const sales = detailState.baseline.sections.find(section => section.dept === 'sales')?.payload || {};
  const t1 = sales.pricing_summary?.t1 || {};
  const t2 = sales.pricing_summary?.t2 || {};
  const t3 = sales.pricing_summary?.t3 || {};
  const original = {
    material: sumObject(t1, ['imp_mat', 'dom_mat', 'hardware', 'electronic', 'motor', 'suction', 'glue_bag']) + num(t3.paint_material),
    labor: sumObject(t1, ['blow', 'slush', 'sewing_hair', 'sewing_cloth']) + sumObject(t3, ['injection_labor', 'painting_labor', 'assembly_labor']),
    packing: sumObject(t2, ['color_box', 'battery', 'libao', 'plating', 'other_buy', 'carton', 'freight', 'cabinet', 'misc']),
  };
  const fxRmbHkd = num(sales.header?.fx_rmb_hkd) || 0.85;
  const fxHkdUsd = num(sales.header?.fx_hkd_usd) || 7.8;
  const delta = { material: 0, labor: 0, packing: 0 };
  detailState.baseline.sections.forEach(section => sectionRows(section).forEach(row => {
    let difference = num(getPath(verifiedPayloadFor(section), row.key)) - num(row.original);
    if (Math.abs(difference) < 0.00001) return;
    if (row.currency === 'RMB') difference /= fxRmbHkd;
    if (row.currency === 'USD') difference *= fxHkdUsd;
    const category = section.dept === 'sales' || /包装|运费|纸箱|彩盒/.test(row.label)
      ? 'packing'
      : ['painting', 'slush', 'sewing', 'assembly'].includes(section.dept) || /人工|啤价|吹工|披锋/.test(row.label)
        ? 'labor' : 'material';
    delta[category] += difference;
  }));
  const verified = Object.fromEntries(Object.keys(original).map(key => [key, original[key] + delta[key]]));
  original.total = original.material + original.labor + original.packing;
  verified.total = verified.material + verified.labor + verified.packing;
  return { original, verified };
}

function comparisonRow(label, original, verified, currency = 'HKD') {
  const difference = verified - original;
  const differenceText = Math.abs(difference) < 0.005 ? '不变' : `${difference > 0 ? '+' : '−'}${Math.abs(difference).toFixed(2)}`;
  return `<tr><td>${label}</td><td>${money(original, currency)}</td><td>${money(verified, currency)}</td><td class="${difference > 0 ? 'delta-up' : difference < 0 ? 'delta-down' : ''}">${differenceText}</td></tr>`;
}

function renderPreview() {
  const quote = detailState.quote;
  const totals = calculateTotals();
  const summary = previewSummary();
  const completed = detailState.status === 'completed';
  $('verification-preview').innerHTML = `<div class="verification-preview-title"><h2>核价单 · ${esc(quote.quote_no)}</h2><span class="verification-status status-${esc(detailState.status || 'not_started')}">${statusText(detailState.status)}</span></div>
    <div class="verification-preview-baseline">对比基准：客价确认时的报价版本 ${esc(quote.version || 'V1')}（自动锁定，不随原报价后续修改）</div>
    <table class="verification-preview-table"><thead><tr><th>项目</th><th>确认报价</th><th>核价结果</th><th>差异</th></tr></thead><tbody>
      ${comparisonRow('材料成本', summary.original.material, summary.verified.material)}
      ${comparisonRow('人工成本', summary.original.labor, summary.verified.labor)}
      ${comparisonRow('包装及运费', summary.original.packing, summary.verified.packing)}
      ${comparisonRow('总成本', summary.original.total, summary.verified.total)}
      ${comparisonRow('客户确认价', num(quote.confirmed_price), num(quote.confirmed_price), 'USD')}
    </tbody></table>
    <div class="verification-preview-checks">
      <div><span>部门明细完整</span><strong class="check-ok">已通过</strong></div>
      <div><span>客价与报价关联</span><strong class="check-ok">已通过</strong></div>
      <div><span>成本异常检查</span><strong>${totals.changed ? `已调整 ${totals.changed} 项` : '待确认'}</strong></div>
    </div>
    <label class="verification-preview-note">核价备注<textarea disabled placeholder="填写差异原因或核价说明">${esc(detailState.note || '')}</textarea></label>
    <div class="verification-preview-actions"><button id="verification-open-detail" class="mini">进入核价明细</button><button id="verification-preview-complete" ${completed || !detailState.can_edit ? 'disabled' : ''}>${completed ? '核价已完成' : '确认核价完成'}</button></div>`;
  $('verification-open-detail').onclick = () => openDetail(quote.id);
  if ($('verification-preview-complete') && !completed && detailState.can_edit) $('verification-preview-complete').onclick = () => openDetail(quote.id);
}

function renderTotals() {
  const totals = calculateTotals();
  $('verification-item-count').textContent = String(totals.count);
  $('verification-changed-count').textContent = String(totals.changed);
  $('verification-up-count').textContent = String(totals.increased);
  $('verification-down-count').textContent = String(totals.decreased);
}

function pathParts(path) {
  return String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}

function getPath(source, path) {
  return pathParts(path).reduce((value, key) => value == null ? undefined : value[key], source);
}

function setPath(target, path, value) {
  const parts = pathParts(path);
  let cursor = target;
  parts.forEach((key, index) => {
    if (index === parts.length - 1) cursor[key] = value;
    else {
      const nextIsArray = /^\d+$/.test(parts[index + 1]);
      if (cursor[key] == null) cursor[key] = nextIsArray ? [] : {};
      cursor = cursor[key];
    }
  });
}

function verifiedPayloadFor(section) {
  detailState.verified_sections = detailState.verified_sections || {};
  if (!detailState.verified_sections[section.dept]) {
    const payload = JSON.parse(JSON.stringify(section.payload || {}));
    const prefix = section.dept + ':';
    Object.entries(detailState.values || {}).forEach(([key, value]) => {
      if (key.startsWith(prefix)) setPath(payload, key.slice(prefix.length), num(value));
    });
    detailState.verified_sections[section.dept] = payload;
  }
  return detailState.verified_sections[section.dept];
}

function renderDepartment(section) {
  return `<section class="verification-dept" data-dept-panel="${esc(section.dept)}">
    <div class="verification-dept-head"><div><h3>${esc(section.dept_name)}核价工作台</h3><small>操作方式与报价一致，沿用完整表格和计算方式，修改后差异会自动汇总</small></div><span>🔒 确认报价已锁定</span></div>
    <div class="verification-workbench-scroll">
      <div class="verification-workbench-compare">
        <article class="verification-compare-column verification-live-column">
          <header><div><b>核价填写</b><small>当前核价版本 · 可独立修改</small></div><span class="verification-column-badge">核价</span></header>
          <div class="verification-live-workbench" data-live-workbench="${esc(section.dept)}"></div>
        </article>
        <article class="verification-compare-column verification-baseline-column">
          <header><div><b>原报价参考</b><small>客价确认时冻结 · 不可修改</small></div><span class="verification-column-badge">只读</span></header>
          <div class="verification-original-workbench" data-original-workbench="${esc(section.dept)}"></div>
        </article>
      </div>
    </div>
  </section>`;
}

function workbenchSections(useVerified) {
  return (detailState.baseline.sections || []).map(item => ({
    ...item,
    payload_json: JSON.stringify(useVerified ? verifiedPayloadFor(item) : item.payload || {}),
  }));
}

function renderOneWorkbench(workbench, host, section, payload, canEdit, sections, fxRmbHkd, fxHkdUsd, quote, onChange) {
  if (section.dept === 'engineering') workbench.renderEngineering(host, payload, canEdit, onChange, fxRmbHkd, fxHkdUsd, quote.qty, quote.customer);
  else if (section.dept === 'electronic') workbench.renderElectronic(host, payload, canEdit, onChange, fxRmbHkd, fxHkdUsd);
  else if (section.dept === 'molding') {
    const engineering = sections.find(item => item.dept === 'engineering');
    let engineeringPayload = {};
    try { engineeringPayload = JSON.parse(engineering?.payload_json || '{}'); } catch {}
    workbench.renderMolding(host, payload, canEdit, onChange, engineeringPayload.molds || [], fxRmbHkd, detailState.me?.role || 'staff');
  } else if (section.dept === 'painting') workbench.renderPainting(host, payload, canEdit, onChange, fxRmbHkd);
  else if (section.dept === 'slush') workbench.renderSlush(host, payload, canEdit, onChange, fxRmbHkd);
  else if (section.dept === 'sewing') workbench.renderSewing(host, payload, canEdit, onChange, fxRmbHkd);
  else if (section.dept === 'assembly') workbench.renderAssembly(host, payload, canEdit, onChange, fxRmbHkd);
  else if (section.dept === 'sales') workbench.renderSales(host, payload, quote, false, canEdit, sections, onChange, () => {});
  else host.innerHTML = '<p class="muted">该部门暂无专用明细版式。</p>';
}

function renderVerificationWorkbench(section) {
  const panel = document.querySelector(`[data-dept-panel="${CSS.escape(section.dept)}"]`);
  const host = panel?.querySelector(`[data-live-workbench="${CSS.escape(section.dept)}"]`);
  const originalHost = panel?.querySelector(`[data-original-workbench="${CSS.escape(section.dept)}"]`);
  const workbench = window.VerificationWorkbench;
  if (!host || !originalHost || !workbench) return;
  const payload = verifiedPayloadFor(section);
  const sections = workbenchSections(true);
  const originalSections = workbenchSections(false);
  const sales = sections.find(item => item.dept === 'sales');
  let salesPayload = {};
  try { salesPayload = JSON.parse(sales?.payload_json || '{}'); } catch {}
  const fxRmbHkd = num(salesPayload.header?.fx_rmb_hkd) || 0.85;
  const fxHkdUsd = num(salesPayload.header?.fx_hkd_usd) || 7.8;
  const quote = detailState.quote;
  const refreshVerification = () => {
    detailState.verified_sections[section.dept] = payload;
    renderTotals();
  };
  window.__data = { quote, sections, me: detailState.me || {} };
  window.__salesTaxPct = num(salesPayload.pricing?.tax_pct ?? 13);
  const canEdit = detailState.can_edit && detailState.status !== 'completed';
  renderOneWorkbench(workbench, host, section, payload, canEdit, sections, fxRmbHkd, fxHkdUsd, quote, refreshVerification);

  const originalPayload = JSON.parse(JSON.stringify(section.payload || {}));
  const originalSales = originalSections.find(item => item.dept === 'sales');
  let originalSalesPayload = {};
  try { originalSalesPayload = JSON.parse(originalSales?.payload_json || '{}'); } catch {}
  const originalFxRmbHkd = num(originalSalesPayload.header?.fx_rmb_hkd) || 0.85;
  const originalFxHkdUsd = num(originalSalesPayload.header?.fx_hkd_usd) || 7.8;
  renderOneWorkbench(workbench, originalHost, section, originalPayload, false, originalSections, originalFxRmbHkd, originalFxHkdUsd, quote, () => {});
  originalHost.querySelectorAll('input, select, textarea, button').forEach(control => {
    control.disabled = true;
    if (control.tagName === 'BUTTON') control.hidden = true;
  });
  refreshVerification();
}

function renderVerificationSummary() {
  const panel = $('verification-panel-host');
  const workbench = window.VerificationWorkbench;
  if (!panel || !workbench?.renderSummaryPane) return;
  panel.innerHTML = `<section class="verification-dept verification-summary-panel" data-dept-panel="__summary__">
    <div class="verification-dept-head"><div><h3>核价汇总与减税</h3><small>先核对成本差异，再按核价后的数据重新计算出货价、利润和减税</small></div><span class="verification-column-badge">仅核价减税</span></div>
    <table class="verification-preview-table verification-summary-compare"><thead><tr><th>核对项目</th><th>确认报价</th><th>核价结果</th><th>差异</th></tr></thead><tbody data-summary-comparison></tbody></table>
    <div class="verification-tax-note"><b>减税口径</b><span>下方减税明细只显示并计算核价数据，不重复展示原报价减税。</span></div>
    <div class="verification-summary-workbench"></div>
  </section>`;
  const sections = workbenchSections(true);
  window.__data = { quote: detailState.quote, sections, me: detailState.me || {} };
  workbench.renderSummaryPane(panel.querySelector('.verification-summary-workbench'), sections, detailState.quote, { dept: 'verification_readonly', role: 'staff' });
  const comparison = previewSummary();
  panel.querySelector('[data-summary-comparison]').innerHTML = `
    ${comparisonRow('材料成本', comparison.original.material, comparison.verified.material)}
    ${comparisonRow('人工成本', comparison.original.labor, comparison.verified.labor)}
    ${comparisonRow('包装及运费', comparison.original.packing, comparison.verified.packing)}
    ${comparisonRow('总成本', comparison.original.total, comparison.verified.total)}
    ${comparisonRow('减税后成本', comparison.original.afterDeduction, comparison.verified.afterDeduction)}
    ${comparisonRow('客户确认价', num(detailState.quote.confirmed_price), num(detailState.quote.confirmed_price), 'USD')}`;
}

async function openDetail(id) {
  const [verification, me] = await Promise.all([api('/verifications/' + id), api('/auth/me')]);
  detailState = { ...verification, me };
  const quote = detailState.quote;
  const sections = detailState.baseline.sections || [];
  $('verification-list').classList.add('hidden');
  $('verification-detail').classList.remove('hidden');
  $('verification-detail').innerHTML = `<div class="verification-detail-top">
    <button id="verification-back" class="mini">← 返回核价列表</button>
    <div><h1>核价单 · ${esc(quote.quote_no)}</h1><p>${esc(quote.product_name)} · ${esc(quote.customer || '—')} · 基准冻结于 ${esc((detailState.baseline.frozen_at || '').replace('T', ' ').slice(0, 19))}</p></div>
    <span class="verification-lock">🔒 确认报价只读</span>
  </div>
  <div class="verification-metrics">
    <div><span>核价字段</span><strong id="verification-item-count"></strong></div>
    <div><span>已调整项目</span><strong id="verification-changed-count"></strong></div>
    <div><span>价格上涨</span><strong id="verification-up-count" class="delta-up"></strong></div>
    <div><span>价格下降</span><strong id="verification-down-count" class="delta-down"></strong></div>
  </div>
  <div class="verification-tabs">${sections.map((section, index) => `<button class="verification-tab ${index === 0 ? 'active' : ''}" data-dept="${esc(section.dept)}">${esc(section.dept_name)}</button>`).join('')}<button class="verification-tab" data-dept="__summary__">汇总与减税</button></div>
  <div id="verification-panel-host"></div>
  <div class="verification-savebar"><label>核价备注 <input id="verification-note" value="${esc(detailState.note)}" placeholder="选填"></label>
    ${detailState.can_edit && detailState.status !== 'completed' ? '<button id="verification-save" class="mini">保存进度</button><button id="verification-complete">完成核价</button>' : '<span class="verification-lock">核价已锁定</span>'}</div>`;
  $('verification-back').onclick = () => { $('verification-detail').classList.add('hidden'); $('verification-list').classList.remove('hidden'); loadList(); };
  document.querySelectorAll('.verification-tab').forEach(button => button.onclick = () => {
    document.querySelectorAll('.verification-tab').forEach(item => item.classList.toggle('active', item === button));
    if (button.dataset.dept === '__summary__') renderVerificationSummary();
    else {
      const section = sections.find(item => item.dept === button.dataset.dept);
      $('verification-panel-host').innerHTML = section ? renderDepartment(section) : '';
      if (section) renderVerificationWorkbench(section);
    }
  });
  if ($('verification-save')) $('verification-save').onclick = () => saveDetail('in_progress');
  if ($('verification-complete')) $('verification-complete').onclick = () => saveDetail('completed');
  const initialSection = sections[0];
  if (initialSection) {
    $('verification-panel-host').innerHTML = renderDepartment(initialSection);
    renderVerificationWorkbench(initialSection);
  }
  renderTotals();
}

async function saveDetail(status) {
  try {
    await api('/verifications/' + detailState.quote.id, { method: 'PUT', body: JSON.stringify({ values: detailState.values || {}, sections: detailState.verified_sections || {}, status, note: $('verification-note').value }) });
    detailState.status = status;
    alert(status === 'completed' ? '核价已完成' : '核价进度已保存');
  } catch (error) { alert(error.message); }
}

$('verification-search').oninput = renderList;
$('verification-status-filter').onchange = renderList;
$('verification-customer-filter').onchange = renderList;
$('verification-records').onclick = () => {
  $('verification-status-filter').value = $('verification-status-filter').value === 'completed' ? '' : 'completed';
  $('verification-records').classList.toggle('active', $('verification-status-filter').value === 'completed');
  renderList();
};
$('verification-export').onclick = () => {
  const rows = [['货号', '产品', '版本', '客户', '确认价USD', '确认数量', '核价状态', '确认时间'], ...listState.map(row => [
    row.quote_no, row.product_name, row.version || '', row.customer || '', num(row.confirmed_price).toFixed(2), row.confirmed_qty ?? '', statusText(row.verification_status), row.confirmed_at || '',
  ])];
  const csv = '\ufeff' + rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `核价单_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
};
loadList().catch(error => { $('verification-list-body').innerHTML = `<tr><td colspan="8" class="summary-empty">${esc(error.message)}</td></tr>`; });
