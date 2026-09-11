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
    addItemPrices(rows, p.assembly_labor, 'assembly_labor', [{ key: 'unit_price', label: '人工单价', currency: 'HKD' }], (item, i) => item.name || item.product || `组装 ${i + 1}`);
    addItemPrices(rows, p.packaging_labor, 'packaging_labor', [{ key: 'unit_price', label: '人工单价', currency: 'HKD' }], (item, i) => item.name || item.product || `包装 ${i + 1}`);
  }
  return rows;
}

let listState = [];
let detailState = null;

async function loadList() {
  const me = await api('/auth/me');
  $('who-chip').textContent = `${me.dept_name} · ${me.display_name || me.username}`;
  const result = await api('/verifications');
  listState = result.rows || [];
  renderList();
}

function renderList() {
  const query = ($('verification-search').value || '').trim().toLowerCase();
  const rows = listState.filter(row => [row.quote_no, row.product_name, row.customer, row.version].join(' ').toLowerCase().includes(query));
  $('verification-list-body').innerHTML = rows.length ? rows.map(row => `<tr>
    <td><strong>${esc(row.quote_no)}</strong></td><td>${esc(row.product_name)}</td><td>${esc(row.version || '—')}</td><td>${esc(row.customer || '—')}</td>
    <td>$ ${num(row.confirmed_price).toFixed(2)}</td><td>${esc(row.confirmed_qty ?? '—')}</td>
    <td><span class="verification-status status-${esc(row.verification_status)}">${row.verification_status === 'completed' ? '已完成' : row.verification_status === 'in_progress' ? '核价中' : '待核价'}</span></td>
    <td><button class="mini open-verification" data-id="${row.id}">${row.verification_status === 'not_started' ? '开始核价' : '查看核价'}</button></td>
  </tr>`).join('') : '<tr><td colspan="8" class="summary-empty">暂无已确认报价</td></tr>';
  document.querySelectorAll('.open-verification').forEach(button => button.onclick = () => openDetail(button.dataset.id));
}

function sectionRows(section) {
  const prefix = section.dept + ':';
  const rows = collectVerificationFields(section).map(row => ({ ...row, storageKey: prefix + row.key }));
  return rows.filter((row, index) => rows.findIndex(other => other.storageKey === row.storageKey) === index);
}

function calculateTotals() {
  const allRows = detailState.baseline.sections.flatMap(sectionRows);
  let changed = 0;
  let increased = 0;
  let decreased = 0;
  allRows.forEach(row => {
    const next = Object.prototype.hasOwnProperty.call(detailState.values, row.storageKey) ? num(detailState.values[row.storageKey]) : num(row.original);
    const delta = next - num(row.original);
    if (Math.abs(delta) > 0.00001) changed++;
    if (delta > 0.00001) increased++;
    if (delta < -0.00001) decreased++;
  });
  return { changed, increased, decreased, count: allRows.length };
}

function renderTotals() {
  const totals = calculateTotals();
  $('verification-item-count').textContent = String(totals.count);
  $('verification-changed-count').textContent = String(totals.changed);
  $('verification-up-count').textContent = String(totals.increased);
  $('verification-down-count').textContent = String(totals.decreased);
}

function renderDepartment(section, active) {
  const rows = sectionRows(section);
  return `<section class="verification-dept ${active ? '' : 'hidden'}" data-dept-panel="${esc(section.dept)}">
    <div class="verification-dept-head"><div><h3>${esc(section.dept_name)}原报价明细</h3><small>版式与报价页面一致，确认后的内容只读</small></div><span>${rows.length} 个核价项</span></div>
    <div class="verification-original-workbench" data-original-workbench="${esc(section.dept)}"></div>
    <div class="verification-compare-head"><div><h3>核价填写与差异</h3><small>只核对实际录入的成本和单价；合计、换算和税费由系统自动计算</small></div></div>
    <div class="verification-compare-wrap"><table class="wb-table verification-detail-table"><thead><tr><th>明细项目</th><th>确认报价</th><th>核价价格</th><th>差额</th><th>差异率</th></tr></thead><tbody>
    ${rows.length ? rows.map(row => {
      const has = Object.prototype.hasOwnProperty.call(detailState.values, row.storageKey);
      const verified = has ? num(detailState.values[row.storageKey]) : num(row.original);
      const delta = verified - num(row.original);
      const pct = row.original ? delta / num(row.original) * 100 : 0;
      return `<tr data-price-row="${esc(row.storageKey)}"><td>${esc(row.label)}</td><td>${money(row.original, row.currency)}</td>
        <td>${detailState.can_edit ? `<div class="verification-price-cell"><span>${row.currency === 'USD' ? 'US$' : row.currency === 'RMB' ? '¥' : 'HK$'}</span><input class="verification-price" data-key="${esc(row.storageKey)}" type="number" min="0" step="0.0001" value="${verified}"></div>` : money(verified, row.currency)}</td>
        <td class="verification-delta ${delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : ''}">${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}</td>
        <td class="verification-pct">${row.original ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}</td></tr>`;
    }).join('') : '<tr><td colspan="5" class="summary-empty">本部门没有可核价的价格项</td></tr>'}
    </tbody></table></div></section>`;
}

function renderOriginalWorkbench(section) {
  const host = document.querySelector(`[data-original-workbench="${CSS.escape(section.dept)}"]`);
  const workbench = window.VerificationWorkbench;
  if (!host || !workbench) return;
  const payload = JSON.parse(JSON.stringify(section.payload || {}));
  const sections = (detailState.baseline.sections || []).map(item => ({
    ...item,
    payload_json: JSON.stringify(item.payload || {}),
  }));
  const sales = sections.find(item => item.dept === 'sales');
  let salesPayload = {};
  try { salesPayload = JSON.parse(sales?.payload_json || '{}'); } catch {}
  const fxRmbHkd = num(salesPayload.header?.fx_rmb_hkd) || 0.85;
  const fxHkdUsd = num(salesPayload.header?.fx_hkd_usd) || 7.8;
  const quote = detailState.quote;
  const noop = () => {};
  window.__data = { quote, sections, me: detailState.me || {} };
  window.__salesTaxPct = num(salesPayload.pricing?.tax_pct ?? 13);

  if (section.dept === 'engineering') workbench.renderEngineering(host, payload, false, noop, fxRmbHkd, fxHkdUsd, quote.qty, quote.customer);
  else if (section.dept === 'electronic') workbench.renderElectronic(host, payload, false, noop, fxRmbHkd, fxHkdUsd);
  else if (section.dept === 'molding') workbench.renderMolding(host, payload, false, noop, [], fxRmbHkd, detailState.me?.role || 'staff');
  else if (section.dept === 'painting') workbench.renderPainting(host, payload, false, noop, fxRmbHkd);
  else if (section.dept === 'slush') workbench.renderSlush(host, payload, false, noop, fxRmbHkd);
  else if (section.dept === 'sewing') workbench.renderSewing(host, payload, false, noop, fxRmbHkd);
  else if (section.dept === 'assembly') workbench.renderAssembly(host, payload, false, noop, fxRmbHkd);
  else if (section.dept === 'sales') workbench.renderSales(host, payload, quote, false, false, sections, noop, noop);
  else host.innerHTML = '<p class="muted">该部门暂无专用明细版式。</p>';

  // 个别报价渲染器中的参考参数原本可随时调整；核价基准区必须全部锁定。
  const lockControls = () => host.querySelectorAll('input, select, textarea, button').forEach(control => {
    control.disabled = true;
    control.setAttribute('aria-label', `${control.getAttribute('aria-label') || control.closest('label')?.textContent?.trim() || '原报价字段'}（已锁定）`);
  });
  lockControls();
  new MutationObserver(lockControls).observe(host, { childList: true, subtree: true });
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
    <div><span>原报价价格项</span><strong id="verification-item-count"></strong></div>
    <div><span>已调整项目</span><strong id="verification-changed-count"></strong></div>
    <div><span>价格上涨</span><strong id="verification-up-count" class="delta-up"></strong></div>
    <div><span>价格下降</span><strong id="verification-down-count" class="delta-down"></strong></div>
  </div>
  <div class="verification-tabs">${sections.map((section, index) => `<button class="verification-tab ${index === 0 ? 'active' : ''}" data-dept="${esc(section.dept)}">${esc(section.dept_name)}</button>`).join('')}</div>
  ${sections.map((section, index) => renderDepartment(section, index === 0)).join('')}
  <div class="verification-savebar"><label>核价备注 <input id="verification-note" value="${esc(detailState.note)}" placeholder="选填"></label>
    ${detailState.can_edit ? '<button id="verification-save" class="mini">保存进度</button><button id="verification-complete">完成核价</button>' : ''}</div>`;
  $('verification-back').onclick = () => { $('verification-detail').classList.add('hidden'); $('verification-list').classList.remove('hidden'); loadList(); };
  document.querySelectorAll('.verification-tab').forEach(button => button.onclick = () => {
    document.querySelectorAll('.verification-tab').forEach(item => item.classList.toggle('active', item === button));
    document.querySelectorAll('.verification-dept').forEach(panel => panel.classList.toggle('hidden', panel.dataset.deptPanel !== button.dataset.dept));
  });
  document.querySelectorAll('.verification-price').forEach(input => input.oninput = () => {
    detailState.values[input.dataset.key] = input.value;
    const row = input.closest('tr');
    const original = num(row.children[1].textContent.replace(/[^0-9.-]/g, ''));
    const delta = num(input.value) - original;
    row.querySelector('.verification-delta').textContent = `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`;
    row.querySelector('.verification-delta').className = `verification-delta ${delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : ''}`;
    row.querySelector('.verification-pct').textContent = original ? `${delta >= 0 ? '+' : ''}${(delta / original * 100).toFixed(2)}%` : '—';
    renderTotals();
  });
  if ($('verification-save')) $('verification-save').onclick = () => saveDetail('in_progress');
  if ($('verification-complete')) $('verification-complete').onclick = () => saveDetail('completed');
  sections.forEach(renderOriginalWorkbench);
  renderTotals();
}

async function saveDetail(status) {
  try {
    await api('/verifications/' + detailState.quote.id, { method: 'PUT', body: JSON.stringify({ values: detailState.values, status, note: $('verification-note').value }) });
    detailState.status = status;
    alert(status === 'completed' ? '核价已完成' : '核价进度已保存');
  } catch (error) { alert(error.message); }
}

$('verification-search').oninput = renderList;
loadList().catch(error => { $('verification-list-body').innerHTML = `<tr><td colspan="8" class="summary-empty">${esc(error.message)}</td></tr>`; });
