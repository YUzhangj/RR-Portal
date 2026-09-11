const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = value => `HK$ ${num(value).toFixed(2)}`;

async function api(path, options = {}) {
  const response = await fetch('/api' + path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.json();
}

const FIELD_LABELS = {
  price: '单价', unit_price: '单价', amount: '金额', total: '合计', cost: '成本', material_price: '材料价',
  shot_price: '啤价', labor: '人工', labor_cost: '人工成本', freight: '运费', indo_freight: '印尼运费',
  mold_price: '模具价格', hkd: '港币金额', rmb: '人民币金额', usd: '美元金额', subtotal: '小计',
};
const MONEY_KEY = /(price|cost|amount|total|subtotal|labor|freight|fee|hkd|rmb|usd|shot)/i;
const SKIP_KEY = /(pct|percent|rate|ratio|qty|quantity|count|number|length|width|height|weight|cycle|sets?|cavity|markup|divisor|fx_)/i;

function labelFor(key) {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ');
}

function itemName(value, fallback) {
  if (!value || typeof value !== 'object') return fallback;
  return value.name || value.product_name || value.part_name || value.item_name || value.process || value.description || value.model || fallback;
}

function collectMoneyFields(value, path = '', trail = [], rows = [], depth = 0) {
  if (depth > 7 || value == null) return rows;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMoneyFields(item, `${path}[${index}]`, [...trail, itemName(item, `第 ${index + 1} 项`)], rows, depth + 1));
    return rows;
  }
  if (typeof value !== 'object') return rows;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (typeof child === 'number' && MONEY_KEY.test(key) && !SKIP_KEY.test(key)) {
      rows.push({ key: childPath, label: [...trail, labelFor(key)].filter(Boolean).join(' · '), original: child });
    } else if (child && typeof child === 'object') {
      collectMoneyFields(child, childPath, trail, rows, depth + 1);
    }
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
  const rows = collectMoneyFields(section.payload).map(row => ({ ...row, storageKey: prefix + row.key }));
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
    <div class="verification-dept-head"><div><h3>${esc(section.dept_name)}</h3><small>原报价已锁定，只填写“核价单价”列</small></div><span>${rows.length} 个价格项</span></div>
    <table class="wb-table verification-detail-table"><thead><tr><th>明细项目</th><th>确认报价</th><th>核价价格</th><th>差额</th><th>差异率</th></tr></thead><tbody>
    ${rows.length ? rows.map(row => {
      const has = Object.prototype.hasOwnProperty.call(detailState.values, row.storageKey);
      const verified = has ? num(detailState.values[row.storageKey]) : num(row.original);
      const delta = verified - num(row.original);
      const pct = row.original ? delta / num(row.original) * 100 : 0;
      return `<tr data-price-row="${esc(row.storageKey)}"><td>${esc(row.label)}</td><td>${money(row.original)}</td>
        <td>${detailState.can_edit ? `<input class="verification-price" data-key="${esc(row.storageKey)}" type="number" min="0" step="0.0001" value="${verified}">` : money(verified)}</td>
        <td class="verification-delta ${delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : ''}">${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}</td>
        <td class="verification-pct">${row.original ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}</td></tr>`;
    }).join('') : '<tr><td colspan="5" class="summary-empty">本部门没有可核价的价格项</td></tr>'}
    </tbody></table></section>`;
}

async function openDetail(id) {
  detailState = await api('/verifications/' + id);
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
