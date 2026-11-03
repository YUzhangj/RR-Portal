const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const nearZero = value => Math.abs(num(value)) < 0.00001;
const parseJson = (value, fallback = {}) => {
  try { return typeof value === 'string' ? JSON.parse(value) : (value || fallback); } catch { return fallback; }
};

async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.json();
}

function requestText(title, initialValue = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'verification-dialog-overlay';
    overlay.innerHTML = `<div class="verification-dialog" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3><textarea></textarea>
      <div><button type="button" data-dialog-cancel class="mini">取消</button><button type="button" data-dialog-ok>确定</button></div>
    </div>`;
    const input = overlay.querySelector('textarea');
    input.value = initialValue;
    const finish = value => { overlay.remove(); resolve(value); };
    overlay.querySelector('[data-dialog-cancel]').onclick = () => finish(null);
    overlay.querySelector('[data-dialog-ok]').onclick = () => finish(input.value);
    overlay.onclick = event => { if (event.target === overlay) finish(null); };
    input.onkeydown = event => { if (event.key === 'Escape') finish(null); };
    document.body.appendChild(overlay);
    input.focus();
  });
}

const SECTION_STATUS = {
  empty: '草稿', filled: '待审核', approved: '已审核', rejected: '已驳回',
};
async function openCreateVerification() {
  const button = $('verification-create');
  button.disabled = true;
  try {
    const {customers} = await api('/quotes/customers');
    const overlay = document.createElement('div');
    overlay.className = 'verification-dialog-overlay';
    overlay.innerHTML = `<form class="verification-dialog verification-create-form" role="dialog" aria-modal="true" aria-labelledby="verification-create-title">
      <h3 id="verification-create-title">新建核价</h3><p>直接进入各部门核价，按当前核价基准初始化。</p>
      <label>货号 <input name="quote_no" required maxlength="200" autocomplete="off"></label>
      <label>产品名称 <input name="product_name" required maxlength="200"></label>
      <label>客户 <select name="customer" required><option value="">请选择授权客户</option>${(customers || []).map(customer=>`<option value="${esc(customer)}">${esc(customer)}</option>`).join('')}</select></label>
      <label>核价数量 <input name="qty" type="number" min="0" max="2147483647" step="1" placeholder="可留空"></label>
      <label>资料版本 <input name="version" maxlength="200" placeholder="V1"></label>
      <label>核价类型 <select name="quote_type"><option value="single">单品核价</option><option value="mixed">混装核价</option></select></label>
      <p data-create-error role="status"></p><div><button type="button" class="mini" data-create-cancel>取消</button><button type="submit">创建并进入核价</button></div>
    </form>`;
    const form = overlay.querySelector('form');
    let pending = false;
    const close = () => { if (!pending) { overlay.remove(); button.focus(); } };
    overlay.querySelector('[data-create-cancel]').onclick = close;
    overlay.onclick = event => { if(event.target===overlay)close(); };
    overlay.onkeydown = event => { if(event.key==='Escape')close(); };
    form.onsubmit = async event => {
      event.preventDefault();
      if(pending || !form.reportValidity())return;
      pending = true;
      const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      const status = form.querySelector('[data-create-error]');status.textContent='正在创建…';
      let created;
      try {
        created = await api('/verifications',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});
      } catch(error) {
        status.textContent=error.message;pending=false;submit.disabled=false;return;
      }
      // Creation already committed. Do not offer a second create if refreshing
      // the task list fails afterwards.
      overlay.remove();versionCache.clear();selectedQuoteId=created.id;
      try {
        await loadList({refreshSelection:false});await selectTask(created.id);openDetail('workflow');
      } catch(error) {
        window.location.href=`./verification.html?quote_id=${encodeURIComponent(created.id)}`;
      }
    };
    document.body.appendChild(overlay);form.querySelector('[name="quote_no"]').focus();
  } catch(error) { alert(error.message); }
  finally { button.disabled=false; }
}
const VERSION_STATUS = {
  not_started: '待创建', drafting: '填写中', in_review: '审核中',
  ready: '待锁定', completed: '已完成',
};
const versionTitle = version => [version?.label, String(version?.category || '').trim()].filter(Boolean).join(' · ');
const currencySymbol = currency => currency === 'USD' ? 'US$' : currency === 'RMB' ? '¥' : currency === 'NUMBER' ? '' : 'HK$';
const amount = (value, currency = 'HKD', decimals = 2) => {
  const symbol = currencySymbol(currency);
  const number = num(value).toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${symbol}${symbol ? ' ' : ''}${number}`;
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pathParts(path) {
  return String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}

function getPath(source, path) {
  return pathParts(path).reduce((value, key) => value == null ? undefined : value[key], source);
}

function addPrice(rows, path, label, value, currency = 'HKD', quantity = '—') {
  if (value === '' || value == null || !Number.isFinite(Number(value))) return;
  rows.push({ key: path, label, value: Number(value), currency, quantity });
}

function quantityOf(item) {
  const value = item?.qty ?? item?.usage_qty ?? item?.usage ?? item?.sets_per_toy ?? item?.count;
  return value === '' || value == null ? '—' : value;
}

function addItemPrices(rows, items, basePath, fields, nameOf) {
  (items || []).forEach((item, index) => {
    const name = nameOf(item, index);
    fields.forEach(field => {
      if (field.when && !field.when(item)) return;
      addPrice(
        rows,
        `${basePath}[${index}].${field.key}`,
        `${name} · ${field.label}`,
        item[field.key],
        field.currencyOf ? field.currencyOf(item) : field.currency,
        field.quantityOf ? field.quantityOf(item) : quantityOf(item),
      );
    });
  });
}

// 版本对比只读取部门录入的原始成本、单价和作业数量；最终成本由汇总公式统一计算。
function collectCostFields(section) {
  const payload = section.payload || {};
  const rows = [];
  if (section.dept === 'sales') {
    addPrice(rows, 'pricing_summary.surtax', '附加费用', payload.pricing_summary?.surtax);
  } else if (section.dept === 'engineering') {
    addItemPrices(rows, payload.molds, 'molds', [
      { key: 'price_rmb', label: '模具价格', currency: 'RMB', quantityOf: () => 1 },
    ], (item, index) => item.name || item.mold_no || `模具 ${index + 1}`);
    const supplierFields = [
      { key: 'unit_price_rmb', label: '单价', currency: 'RMB', when: item => (item.source_currency || 'RMB') === 'RMB' },
      { key: 'unit_price_usd', label: '单价', currency: 'USD', when: item => item.source_currency === 'USD' },
      { key: 'unit_price', label: '单价', currency: 'HKD', when: item => item.source_currency === 'HKD' },
    ];
    ['hardware', 'aux_materials', 'packaging_materials'].forEach(key => {
      addItemPrices(rows, payload[key], key, supplierFields, (item, index) => item.name || item.category || item.spec || `物料 ${index + 1}`);
    });
    addItemPrices(rows, payload.mold_costs?.items, 'mold_costs.items', [
      { key: 'price_rmb', label: '金额', currency: 'RMB', quantityOf: () => 1 },
    ], (item, index) => item.name || `模具费用 ${index + 1}`);
    addPrice(rows, 'mold_costs.prototype_fee_usd', '手板费', payload.mold_costs?.prototype_fee_usd, 'USD', 1);
    addPrice(rows, 'mold_costs.testing_fee_usd', '测试费', payload.mold_costs?.testing_fee_usd, 'USD', 1);
  } else if (section.dept === 'electronic') {
    addItemPrices(rows, payload.electronics, 'electronics', [
      { key: 'unit_price_rmb', label: '单价', currency: 'RMB' },
    ], (item, index) => item.name || item.spec || `电子件 ${index + 1}`);
    const labels = {
      test_repair: '测试维修费', packing_shipping: '包装运费', bonding_cost: '邦定费',
      smt_cost: '贴片费', labor_cost: '人工费',
    };
    Object.entries(labels).forEach(([key, label]) => {
      addPrice(rows, `electronics_extra.${key}`, label, payload.electronics_extra?.[key], 'HKD', 1);
    });
  } else if (section.dept === 'molding') {
    addItemPrices(rows, payload.injection, 'injection', [
      { key: 'material_unit_price', label: '材料单价', currency: 'HKD' },
      { key: 'shot_price', label: '啤工', currency: 'HKD' },
    ], (item, index) => item.name || item.mold_no || `注塑件 ${index + 1}`);
    addItemPrices(rows, payload.blow_items, 'blow_items', [
      { key: 'material_price_lb', label: '料价', currency: 'HKD' },
      { key: 'blow_labor', label: '吹工', currency: 'HKD' },
      { key: 'flash', label: '披锋', currency: 'HKD' },
    ], (item, index) => item.name || `吹气件 ${index + 1}`);
  } else if (section.dept === 'painting') {
    const processes = {
      clamp: '夹模', pad: '移印', roast: '烤漆', spray: '喷油', edge: '边油',
      color: '调色', dip: '浸油', oil: '油漆', pp_water: 'PP水', uv: 'UV',
    };
    (payload.painting_items || []).forEach((item, index) => {
      Object.entries(processes).forEach(([key, label]) => {
        if (!num(item[`${key}_qty`]) && !num(item[`${key}_unit`])) return;
        addPrice(
          rows,
          `painting_items[${index}].${key}_unit`,
          `${item.name || item.position || `喷油件 ${index + 1}`} · ${label}单价`,
          item[`${key}_unit`],
          'HKD',
          item[`${key}_qty`] ?? '—',
        );
      });
    });
  } else if (section.dept === 'slush') {
    const fields = [
      ['material_price_lb', '材料价'], ['slush_labor_24h', '搪胶人工'], ['batch_labor_12h', '批锋人工'],
      ['diesel_24h', '柴油费'], ['electricity_24h', '电费'], ['pigment_price', '色粉价'],
      ['shipping_bag', '包装袋'], ['mold_fee', '模具费'],
    ];
    addItemPrices(rows, payload.slush_items, 'slush_items', fields.map(([key, label]) => ({
      key,
      label,
      currencyOf: item => key === 'mold_fee' ? (item.mold_fee_currency || 'RMB') : 'HKD',
    })), (item, index) => item.name || `搪胶件 ${index + 1}`);
  } else if (section.dept === 'sewing') {
    (payload.sewing_groups || []).forEach((group, groupIndex) => {
      addPrice(rows, `sewing_groups[${groupIndex}].labor_amount`, `${group.name || `产品 ${groupIndex + 1}`} · 车缝人工`, group.labor_amount, 'HKD', group.product_qty ?? 1);
      addItemPrices(rows, group.items, `sewing_groups[${groupIndex}].items`, [
        { key: 'mat_price', label: '材料单价', currency: 'HKD' },
      ], (item, index) => item.part || item.fabric || `布料 ${index + 1}`);
    });
  } else if (section.dept === 'assembly') {
    addPrice(rows, 'assembly_base_rate', '组装人工基数', payload.assembly_base_rate, 'HKD', 1);
    addPrice(rows, 'assembly_std_time', '标准工时', payload.assembly_std_time, 'NUMBER', 1);
    addItemPrices(rows, payload.assembly_labor, 'assembly_labor', [
      { key: 'unit_price', label: '人工单价', currency: 'HKD' },
    ], (item, index) => item.name || item.product || `组装 ${index + 1}`);
    addItemPrices(rows, payload.packaging_labor, 'packaging_labor', [
      { key: 'unit_price', label: '人工单价', currency: 'HKD' },
    ], (item, index) => item.name || item.product || `包装 ${index + 1}`);
    const addSteps = (groups, basePath, kind) => (groups || []).forEach((group, groupIndex) => {
      (group.steps || []).forEach((step, stepIndex) => addPrice(
        rows,
        `${basePath}[${groupIndex}].steps[${stepIndex}].count`,
        `${group.product || `${kind}产品 ${groupIndex + 1}`} · ${step.name || `工序 ${stepIndex + 1}`}人数`,
        step.count,
        'NUMBER',
        group.qty ?? '—',
      ));
    });
    addSteps(payload.assembly_step_groups, 'assembly_step_groups', '组装');
    addSteps(payload.packaging_step_groups, 'packaging_step_groups', '包装');
  }
  (payload.legacy_items || []).forEach((item, index) => {
    let value = num(item.current_hkd);
    if (item.formula_kind === 'quantity_x_unit') {
      value = num(item.formula_quantity) * num(item.formula_unit_hkd);
    } else if (item.formula_kind === 'assembly_base_per_output') {
      value = num(payload.assembly_base_rate) * num(item.people) * (num(item.team) || 1)
        / Math.max(num(item.output), 1);
    }
    addPrice(rows, `legacy_items[${index}].current_hkd`, item.name || `历史明细 ${index + 1}`, value, 'HKD',
      item.formula_quantity ?? item.quantity ?? '—');
  });
  return rows;
}

let me = null;
let listState = [];
let selectedQuoteId = null;
let taskState = null;
let detailMode = 'workflow';
let activeDepartment = null;
let sectionDirty = false;
let comparisonState = { selected: [], dept: 'all', changedOnly: true, query: '' };
const versionCache = new Map();
let costingBasisState = null;
let costingBasisMeta = {};
let costingBasisExpanded = false;

const COSTING_BASIS_COLUMNS = {
  materials: [['name', '料名'], ['model', '型号'], ['price', 'HK$/Lb', 'number']],
  machines: [['model', '机型'], ['normal', '普通机'], ['price', 'HK$/台班', 'number']],
  cartons: [['label', '纸箱类别'], ['rate', '系数', 'number']],
};

function canManageCostingBasis() {
  return me?.role === 'admin' || Boolean(me?.perms?.['账号管理']?.can_admin);
}

function hasPermission(user, menu, action) {
  return Boolean(user?.perms?.[menu]?.[`can_${action}`]);
}

function renderUserHeader() {
  if (!me) return;
  const roleZh = { admin: '管理员', supervisor: '主管', staff: '员工' }[me.role] || me.role;
  $('who-chip').textContent = `${me.dept_name} · ${roleZh} · ${me.display_name || me.username}`;
  $('user-chip').classList.remove('hidden');
  const factoryChip = $('factory-chip');
  const factorySwitch = $('factory-switch');
  factoryChip.textContent = me.active_factory_name || me.active_factory_code || '';
  const availableFactories = me.factories || [];
  if (me.can_switch_factory && availableFactories.length > 1) {
    factorySwitch.innerHTML = availableFactories.map(factory => `<button type="button" class="top-factory-btn ${factory.code === me.active_factory_code ? 'active' : ''}" data-code="${esc(factory.code)}" aria-pressed="${factory.code === me.active_factory_code}"><span class="factory-dot dot-${esc(factory.code)}"></span>${esc(factory.name_cn)}</button>`).join('');
    factoryChip.classList.add('hidden');
    factorySwitch.classList.remove('hidden');
    factorySwitch.querySelectorAll('.top-factory-btn').forEach(button => {
      button.onclick = async () => {
        if (button.classList.contains('active')) return;
        factorySwitch.querySelectorAll('button').forEach(item => { item.disabled = true; });
        try {
          await api('/auth/factory', {
            method: 'POST',
            body: JSON.stringify({ factory_code: button.dataset.code }),
          });
          versionCache.clear();
          selectedQuoteId = null;
          taskState = null;
          await loadList();
        } catch (error) {
          alert(error.message);
          renderUserHeader();
        }
      };
    });
  } else {
    factorySwitch.classList.add('hidden');
    factoryChip.classList.remove('hidden');
  }
  $('btn-admin').classList.toggle('hidden', !hasPermission(me, '账号管理', 'admin'));
}

function openPasswordDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'verification-dialog-overlay';
  overlay.innerHTML = `<div class="verification-dialog" role="dialog" aria-modal="true">
    <h3>修改密码</h3>
    <label style="display:grid;gap:5px;margin-top:10px">当前密码<input type="password" data-current autocomplete="current-password"></label>
    <label style="display:grid;gap:5px;margin-top:10px">新密码（≥6 位）<input type="password" data-new autocomplete="new-password"></label>
    <label style="display:grid;gap:5px;margin-top:10px">确认新密码<input type="password" data-confirm autocomplete="new-password"></label>
    <p class="msg" data-message></p>
    <div><button type="button" data-cancel class="mini">取消</button><button type="button" data-submit>确认</button></div>
  </div>`;
  const message = overlay.querySelector('[data-message]');
  const close = () => overlay.remove();
  overlay.querySelector('[data-cancel]').onclick = close;
  overlay.onclick = event => { if (event.target === overlay) close(); };
  overlay.querySelector('[data-submit]').onclick = async () => {
    const current = overlay.querySelector('[data-current]').value;
    const next = overlay.querySelector('[data-new]').value;
    const confirmNext = overlay.querySelector('[data-confirm]').value;
    if (next !== confirmNext) { message.textContent = '两次输入的新密码不一致'; return; }
    if (next.length < 6) { message.textContent = '新密码至少 6 位'; return; }
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current, new: next }),
      });
      message.style.color = 'green';
      message.textContent = '✓ 修改成功';
      setTimeout(close, 900);
    } catch (error) {
      message.style.color = '';
      message.textContent = error.message;
    }
  };
  document.body.appendChild(overlay);
  overlay.querySelector('[data-current]').focus();
}

function costingBasisTable(key, editable) {
  const columns = COSTING_BASIS_COLUMNS[key];
  const rows = costingBasisState?.[key] || [];
  return `<div data-basis-table="${key}"><table class="wb-table verification-basis-table"><thead><tr>${columns.map(([, label]) => `<th>${label}</th>`).join('')}${editable ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows.map((row, index) => `<tr data-basis-row="${index}">${columns.map(([field,, type]) => `<td><input data-basis-field="${field}" type="${type || 'text'}" step="any" value="${esc(row[field])}" ${editable ? '' : 'disabled'}></td>`).join('')}${editable ? '<td><button type="button" class="mini danger" data-basis-delete>×</button></td>' : ''}</tr>`).join('')}</tbody></table>
    ${editable ? `<button type="button" class="mini" data-basis-add="${key}">＋ 增加</button>` : ''}</div>`;
}

function basisInput(id, label, value, editable, type = 'number') {
  return `<label>${label}<input id="${id}" type="${type}" step="any" value="${esc(value)}" ${editable ? '' : 'disabled'}></label>`;
}

function renderCostingBasis() {
  const host = $('verification-costing-basis');
  if (!costingBasisState) {
    host.innerHTML = '<section class="card verification-basis-card"><span class="muted">统一核价基准暂时无法读取</span></section>';
    return;
  }
  const editable = canManageCostingBasis();
  const basis = costingBasisState;
  const updated = costingBasisMeta.updated_at ? formatDate(costingBasisMeta.updated_at) : '系统预设';
  host.innerHTML = `<details class="card verification-basis-card" ${costingBasisExpanded ? 'open' : ''}>
    <summary>
      <div><span class="eyebrow">所有客户统一使用</span><h2>核价基准 · ${esc(basis.version)}</h2>
        <p>${esc(basis.title)} · 更新 ${esc(updated)}</p></div>
      <div class="verification-basis-kpis"><span>RMB→HKD <b>${basis.exchange.rmb_hkd}</b></span><span>HKD→USD <b>${basis.exchange.hkd_usd}</b></span><span>ABS 750SW <b>${basis.materials.find(row => row.model === '750SW')?.price ?? '—'}</b></span></div>
    </summary>
    <div class="verification-basis-body">
      <div class="verification-basis-note">${editable ? '管理员可在此调整；保存后同步未完成核价，已完成历史版本不变。' : '当前为只读；统一核价基准仅管理员可以调整。'}</div>
      <div class="wb-grid2 verification-basis-fields">
        ${basisInput('vb-version', '基准日期', basis.version, editable, 'date')}
        ${basisInput('vb-title', '基准名称', basis.title, editable, 'text')}
        ${basisInput('vb-rmb-hkd', '人民币折港币', basis.exchange.rmb_hkd, editable)}
        ${basisInput('vb-hkd-usd', '美元兑换港币', basis.exchange.hkd_usd, editable)}
        ${basisInput('vb-assembly-base', '装工基数 HKD/人', basis.assembly.base_rate_hkd, editable)}
        ${basisInput('vb-hunan-freight', '湖南产品运费 %', basis.assembly.hunan_freight_pct, editable)}
        ${basisInput('vb-wage-factor', '装工系数 1', basis.assembly.wage_factor, editable)}
        ${basisInput('vb-social-factor', '装工系数 2', basis.assembly.social_factor, editable)}
        ${basisInput('vb-overhead-factor', '装工系数 3', basis.assembly.overhead_factor, editable)}
        ${basisInput('vb-sewing-tax', '车缝不含税起点 %', basis.tax.sewing_exclusion_pct, editable)}
        ${basisInput('vb-electronic-tax', '电子不含税起点 %', basis.tax.electronic_exclusion_pct, editable)}
        <label>默认纸箱类别<select id="vb-default-carton" ${editable ? '' : 'disabled'}>${basis.cartons.map(row => `<option value="${esc(row.label)}" ${row.label === basis.default_carton_label ? 'selected' : ''}>${esc(row.label)}</option>`).join('')}</select></label>
      </div>
      <h3>喷油标准（HK$/次）</h3>
      <div class="wb-grid2 verification-basis-fields">
        ${basisInput('vb-paint-pad', '移印', basis.painting.pad, editable)}
        ${basisInput('vb-paint-edge', '边模', basis.painting.edge, editable)}
        ${basisInput('vb-paint-clamp', '夹模', basis.painting.clamp, editable)}
      </div>
      <div class="verification-basis-tables">
        <div><h3>原料价</h3>${costingBasisTable('materials', editable)}</div>
        <div><h3>机型价</h3>${costingBasisTable('machines', editable)}</div>
        <div><h3>纸箱报价</h3>${costingBasisTable('cartons', editable)}</div>
      </div>
      ${editable ? '<div class="verification-basis-actions"><button id="verification-basis-save" type="button">保存并同步</button><span id="verification-basis-msg" class="msg"></span></div>' : ''}
    </div>
  </details>`;
  const details = host.querySelector('details');
  details.ontoggle = () => { costingBasisExpanded = details.open; };
  if (!editable) return;
  host.querySelectorAll('[data-basis-delete]').forEach(button => button.onclick = () => {
    collectCostingBasis();
    const tableHost = button.closest('[data-basis-table]');
    const key = tableHost?.dataset.basisTable;
    if (!key) return;
    costingBasisState[key].splice(Number(button.closest('tr').dataset.basisRow), 1);
    costingBasisExpanded = true;
    renderCostingBasis();
  });
  host.querySelectorAll('[data-basis-add]').forEach(button => button.onclick = () => {
    collectCostingBasis();
    const key = button.dataset.basisAdd;
    const columns = COSTING_BASIS_COLUMNS[key];
    costingBasisState[key].push(Object.fromEntries(columns.map(([field,, type]) => [field, type === 'number' ? 0 : ''])));
    costingBasisExpanded = true;
    renderCostingBasis();
  });
  $('verification-basis-save').onclick = saveCostingBasis;
}

function collectBasisRows(key) {
  const table = document.querySelector(`[data-basis-table="${key}"]`);
  return [...(table?.querySelectorAll('tbody tr') || [])].map(row => {
    const value = {};
    row.querySelectorAll('[data-basis-field]').forEach(input => {
      value[input.dataset.basisField] = input.type === 'number' ? Number(input.value) : input.value.trim();
    });
    return value;
  });
}

function collectCostingBasis() {
  if (!costingBasisState || !canManageCostingBasis()) return costingBasisState;
  const n = id => num($(id)?.value);
  costingBasisState = {
    version: $('vb-version').value,
    title: $('vb-title').value.trim(),
    materials: collectBasisRows('materials'),
    machines: collectBasisRows('machines'),
    cartons: collectBasisRows('cartons'),
    default_carton_label: $('vb-default-carton').value,
    exchange: { rmb_hkd: n('vb-rmb-hkd'), hkd_usd: n('vb-hkd-usd') },
    assembly: { base_rate_hkd: n('vb-assembly-base'), hunan_freight_pct: n('vb-hunan-freight'), wage_factor: n('vb-wage-factor'), social_factor: n('vb-social-factor'), overhead_factor: n('vb-overhead-factor') },
    painting: { pad: n('vb-paint-pad'), edge: n('vb-paint-edge'), clamp: n('vb-paint-clamp') },
    tax: { sewing_exclusion_pct: n('vb-sewing-tax'), electronic_exclusion_pct: n('vb-electronic-tax') },
  };
  return costingBasisState;
}

async function saveCostingBasis() {
  if (!confirm('确认保存统一核价基准？未完成核价会同步更新，已完成历史版本保持不变。')) return;
  const button = $('verification-basis-save');
  const message = $('verification-basis-msg');
  button.disabled = true;
  try {
    const result = await api('/admin/costing-basis', { method: 'PUT', body: JSON.stringify({ data: collectCostingBasis() }) });
    versionCache.clear();
    await loadList();
    costingBasisExpanded = true;
    renderCostingBasis();
    $('verification-basis-msg').style.color = 'green';
    $('verification-basis-msg').textContent = `✓ 已保存；报价同步 ${result.synced} 个部门，核价同步 ${result.verification_synced || 0} 个部门，退回重审 ${(result.reopened || 0) + (result.verification_reopened || 0)} 个`;
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
}

let canAssignWorkshop = false;
const workshopSelected = new Set();
const listFilterIds=['verification-search','verification-status-filter','verification-customer-filter',
  'verification-no-filter','verification-product-filter','verification-table-customer-filter',
  'verification-version-filter','verification-progress-filter','verification-table-status-filter',
  'workshop-filter','verification-table-workshop-filter'];
$('workshop-select-visible').onchange = event => {
  for(const row of filteredList())if(row.current_version_id){if(event.target.checked)workshopSelected.add(row.current_version_id);else workshopSelected.delete(row.current_version_id);}
  renderList();$('workshop-message').textContent=`已选 ${workshopSelected.size} 款`;
};
$('workshop-apply').onclick = async () => {
  const workshop=$('workshop-target').value;
  if(!workshop || !workshopSelected.size){$('workshop-message').textContent='请勾选任务并选择车间';return;}
  if(!confirm(`将选中的 ${workshopSelected.size} 款核价分配至「${workshop}」？核价和完成状态不变。`))return;
  $('workshop-apply').disabled=true;
  try {
    const result=await api('/verifications/workshops',{method:'PUT',body:JSON.stringify({version_ids:[...workshopSelected],workshop})});
    workshopSelected.clear();await loadList();$('workshop-message').textContent=`已将 ${result.count} 款分配至 ${result.workshop}，刷新汇总页即可查看`;
  }catch(error){$('workshop-message').textContent=error.message;}
  finally{$('workshop-apply').disabled=false;}
};
function filteredList() {
  const query = ($('verification-search').value || '').trim().toLowerCase();
  const status = $('verification-status-filter').value;
  const customer = $('verification-customer-filter').value;
  const quoteNo = ($('verification-no-filter').value || '').trim().toLowerCase();
  const product = ($('verification-product-filter').value || '').trim().toLowerCase();
  const tableCustomer = $('verification-table-customer-filter').value;
  const version = $('verification-version-filter').value;
  const progress = $('verification-progress-filter').value;
  const tableStatus = $('verification-table-status-filter').value;
  const matchesStatus = (rowStatus, filterStatus) => !filterStatus
    || (filterStatus === 'unfinished' ? rowStatus !== 'completed' : rowStatus === filterStatus);
  return listState.filter(row => matchesStatus(row.verification_status || 'not_started', status)
    && (!$('workshop-filter').value || (row.workshop || '待分配车间') === $('workshop-filter').value)
    && (!customer || row.customer === customer)
    && (!quoteNo || String(row.quote_no || '').toLowerCase().includes(quoteNo))
    && (!product || String(row.product_name || '').toLowerCase().includes(product))
    && (!tableCustomer || row.customer === tableCustomer)
    && (!version || (row.current_version_label || 'not_started') === version)
    && matchesStatus(row.verification_status || 'not_started', tableStatus)
    && (!progress || (() => {
      const approved = num(row.approved_count);
      const total = num(row.total_depts);
      if(progress.startsWith('ratio:'))return `${approved}/${total}`===progress.slice(6);
      const rowProgress = total > 0 && approved >= total ? 'completed' : approved > 0 ? 'in_progress' : 'not_started';
      return rowProgress === progress;
    })())
    && [row.quote_no, row.product_name, row.customer, row.version, row.current_version_label, row.current_version_category].join(' ').toLowerCase().includes(query));
}

function renderList() {
  const rows = filteredList();
  if (selectedQuoteId != null && !rows.some(row => Number(row.id) === Number(selectedQuoteId))) {
    selectedQuoteId = null;
    taskState = null;
    $('verification-preview').innerHTML = `<div class="verification-preview-empty">${rows.length ? '选择一张核价任务查看摘要' : '当前筛选条件下没有核价任务'}</div>`;
  }
  $('verification-filter-count').textContent=`显示 ${rows.length} / ${listState.length} 款`;
  $('verification-clear-filters').disabled=!listFilterIds.some(id=>Boolean($(id).value));
  for(const id of listFilterIds)$(id).classList.toggle('filter-active',Boolean($(id).value));
  $('verification-list-body').innerHTML = rows.length ? rows.map(row => `<tr class="verification-list-row ${Number(selectedQuoteId) === Number(row.id) ? 'selected' : ''}" data-id="${row.id}">
    <td>${canAssignWorkshop && row.current_version_id ? `<input type="checkbox" data-workshop-select="${row.current_version_id}" aria-label="选择 ${esc(row.quote_no)}" ${workshopSelected.has(row.current_version_id)?'checked':''}> ` : ''}<strong>${esc(row.quote_no)}</strong><small>${esc(row.version || 'V1')}</small></td>
    <td>${esc(row.product_name)}</td><td>${esc(row.customer || '—')}</td>
    <td><strong>${esc(versionTitle({ label: row.current_version_label || '待创建', category: row.current_version_category }))}</strong><small>共 ${num(row.version_count)} 个版本</small></td>
    <td>${num(row.approved_count)} / ${num(row.total_depts)}</td>
    <td><span class="verification-status status-${esc(row.verification_status || 'not_started')}">${VERSION_STATUS[row.verification_status] || '待创建'}</span></td>
    <td title="${esc(row.workshop_source)}">${esc(row.workshop || '待分配车间')}</td>
  </tr>`).join('') : '<tr><td colspan="7" class="summary-empty">暂无符合条件的核价任务</td></tr>';
  document.querySelectorAll('[data-workshop-select]').forEach(input => {
    input.onclick = event => event.stopPropagation();
    input.onchange = () => {const id=Number(input.dataset.workshopSelect);if(input.checked)workshopSelected.add(id);else workshopSelected.delete(id);$('workshop-message').textContent=`已选 ${workshopSelected.size} 款`};
  });
  const selectable=rows.filter(r=>r.current_version_id),selectedCount=selectable.filter(r=>workshopSelected.has(r.current_version_id)).length;
  $('workshop-select-visible').checked=selectable.length>0&&selectedCount===selectable.length;
  $('workshop-select-visible').indeterminate=selectedCount>0&&selectedCount<selectable.length;
  document.querySelectorAll('.verification-list-row').forEach(row => {
    row.onclick = () => selectTask(row.dataset.id);
  });
}

function listOptions(id,html){
  const selected=$(id).value;
  $(id).innerHTML=html;
  $(id).value=[...$(id).options].some(option=>option.value===selected)?selected:'';
}

async function loadList() {
  const [user, verificationResult, basisResult] = await Promise.all([
    api('/auth/me'),
    api('/verifications'),
    api('/refs/costing_basis').catch(() => ({ data: null })),
  ]);
  me = user;
  if ($('verification-create')) $('verification-create').hidden = !verificationResult.can_create;
  listState = verificationResult.rows.map(row => ({ ...row, customer: VerificationCustomers.display(row.customer) }));
  canAssignWorkshop = Boolean(verificationResult.can_assign_workshop);
  $('workshop-assignment').hidden = !canAssignWorkshop;
  costingBasisState = basisResult.data;
  costingBasisMeta = basisResult;
  window.__costingBasis = costingBasisState || {};
  renderUserHeader();
  renderCostingBasis();
  const customers = VerificationCustomers.options(listState.map(row => row.customer));
  const customerOptions = customers.map(customer => `<option value="${esc(customer)}">${esc(customer)}</option>`).join('');
  listOptions('verification-customer-filter','<option value="">全部客户</option>'+customerOptions);
  listOptions('verification-table-customer-filter','<option value="">全部</option>'+customerOptions);
  const versions = [...new Set(listState.map(row => row.current_version_label).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }));
  listOptions('verification-version-filter','<option value="">全部</option>'
    + versions.map(version => `<option value="${esc(version)}">${esc(version)}</option>`).join('')
    + (listState.some(row=>!row.current_version_label)?'<option value="not_started">待创建</option>':''));
  const progress=[...new Set(listState.map(row=>`${num(row.approved_count)}/${num(row.total_depts)}`))].sort((a,b)=>num(a.split('/')[0])-num(b.split('/')[0])||num(a.split('/')[1])-num(b.split('/')[1]));
  listOptions('verification-progress-filter','<option value="">全部</option><option value="not_started">未开始</option><option value="in_progress">部分通过</option><option value="completed">全部通过</option>'
    + progress.map(value=>`<option value="ratio:${value}">${value}</option>`).join(''));
  const workshops=[...new Set(['兴信A','兴信B','华登',...listState.map(row=>row.workshop||'待分配车间'),'待分配车间'])];
  listOptions('workshop-filter','<option value="">全部车间</option>'+workshops.map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join(''));
  renderList();
  if (listState.length) await selectTask(selectedQuoteId || listState[0].id);
  if (!$('verification-list').classList.contains('hidden')) window.scrollTo(0, 0);
}

function cacheVersion(data) {
  if (!data || typeof data !== 'object' || !data.selected_version
    || !Array.isArray(data.versions) || !Array.isArray(data.sections)) {
    throw new Error('核价服务版本未同步，请刷新页面；如仍出现此提示，请重启内部报价服务');
  }
  versionCache.set(String(data.selected_version.id), data);
  return data;
}

async function fetchTask(quoteId, versionId) {
  const suffix = versionId ? `?version_id=${encodeURIComponent(versionId)}` : '';
  return cacheVersion(await api(`/verifications/${quoteId}${suffix}`));
}

async function selectTask(quoteId) {
  selectedQuoteId = Number(quoteId);
  renderList();
  $('verification-preview').innerHTML = '<div class="verification-preview-empty">正在读取核价任务…</div>';
  try {
    taskState = await fetchTask(selectedQuoteId);
  } catch (error) {
    taskState = null;
    $('verification-preview').innerHTML = `<div class="verification-preview-empty"><strong>核价任务暂时无法打开</strong><br>${esc(error.message)}</div>`;
    return;
  }
  const latest = taskState.versions[taskState.versions.length - 1];
  const row = listState.find(item => Number(item.id) === selectedQuoteId);
  if (row && latest) {
    Object.assign(row, {
      current_version_id: latest.id,
      current_version_label: latest.label,
      current_version_category: latest.category,
      version_count: taskState.versions.length,
      verification_status: latest.status,
      approved_count: latest.approved_count,
      total_depts: latest.total_count,
    });
    renderList();
  }
  renderPreview();
}

function baselineTitle(data = taskState) { return data.quote.verification_origin === 'direct' ? '新建核价资料' : '原报价'; }

function createVersionSelector(data, idPrefix) {
  if (!data.can_create_version) return '';
  const completed = data.versions.filter(version => version.status === 'completed');
  const latestCompleted = completed[completed.length - 1];
  const importedHistory = data.sections?.some(section => section.dept === 'sales'
    && parseJson(section.payload_json, {}).legacy_import);
  return `<div class="verification-create-version">
    <label>新版本复制来源
      <select id="${idPrefix}-source">
        <option value="quote">${baselineTitle(data)}</option>
        ${completed.map(version => `<option value="${version.id}" ${version.id === latestCompleted?.id ? 'selected' : ''}>${esc(version.label)}（已完成）</option>`).join('')}
      </select>
    </label>
    <button id="${idPrefix}-create">${importedHistory ? '复制为可调整版本' : '＋ 创建下一核价版本'}</button>
  </div>`;
}

function versionCategoryEditor(data, idPrefix) {
  const version = data.selected_version;
  if (!data.can_manage_versions) return version.category
    ? `<div class="verification-version-category-readonly"><span>版本类别</span><strong>${esc(version.category)}</strong></div>`
    : '';
  return `<div class="verification-version-category-editor">
    <label>版本类别
      <input id="${idPrefix}-category" maxlength="40" placeholder="例如：首次核价、试产复核" value="${esc(version.category || '')}">
    </label>
    <button id="${idPrefix}-category-save" class="mini" type="button">保存类别</button>
  </div>`;
}

function bindVersionCategory(data, idPrefix) {
  const button = $(`${idPrefix}-category-save`);
  if (!button) return;
  button.onclick = async () => {
    const category = $(`${idPrefix}-category`).value.trim();
    button.disabled = true;
    try {
      const result = await api(`/verifications/versions/${data.selected_version.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ category }),
      });
      const saved = result.category || null;
      data.selected_version.category = saved;
      const version = data.versions.find(item => Number(item.id) === Number(data.selected_version.id));
      if (version) version.category = saved;
      const row = listState.find(item => Number(item.id) === Number(data.quote.id));
      if (row && Number(row.current_version_id) === Number(data.selected_version.id)) row.current_version_category = saved;
      versionCache.set(String(data.selected_version.id), data);
      if ($('verification-list').classList.contains('hidden')) renderDetail();
      else {
        renderList();
        renderPreview();
      }
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  };
}

function bindCreateVersion(data, idPrefix) {
  const button = $(`${idPrefix}-create`);
  if (!button) return;
  button.onclick = async () => {
    const source = $(`${idPrefix}-source`).value;
    if (!confirm('新版本会复制所选来源的部门明细，套用当前统一核价基准，并重新进入填写和审核流程。确认创建？')) return;
    try {
      const body = source === 'quote'
        ? { source_type: 'quote' }
        : { source_type: 'version', source_version_id: Number(source) };
      const created = await api(`/verifications/${data.quote.id}/versions`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      versionCache.clear();
      taskState = await fetchTask(data.quote.id, created.id);
      detailMode = 'workflow';
      if ($('verification-list').classList.contains('hidden')) renderDetail();
      else openDetail('workflow');
    } catch (error) {
      alert(error.message);
    }
  };
}

function reopenVersionButton(data, idPrefix) {
  if (!data.can_reopen_version || data.selected_version.status !== 'completed') return '';
  return `<button id="${idPrefix}" class="mini verification-reopen-version">🔓 解锁修改 ${esc(data.selected_version.label)}</button>`;
}

function bindReopenVersion(data, idPrefix, afterOpen) {
  const button = $(idPrefix);
  if (!button) return;
  button.onclick = async () => {
    const reason = await requestText(`请输入重新开启 ${data.selected_version.label} 的原因`);
    if (!reason?.trim()) return;
    try {
      await api(`/verifications/versions/${data.selected_version.id}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      versionCache.clear();
      taskState = await fetchTask(data.quote.id, data.selected_version.id);
      sectionDirty = false;
      await afterOpen();
    } catch (error) {
      alert(error.message);
    }
  };
}

function deleteVersionButton(data, idPrefix) {
  if (!data.can_delete_version) return '';
  return `<button id="${idPrefix}" class="danger">删除 ${esc(data.selected_version.label)}</button>`;
}

function bindDeleteVersion(data, idPrefix) {
  const button = $(idPrefix);
  if (!button) return;
  button.onclick = async () => {
    if (sectionDirty && !confirm('当前部门有未保存修改，删除版本会一并放弃这些修改。确认继续？')) return;
    if (!confirm(`确认删除 ${data.selected_version.label}？该版本的全部部门核价明细将一起删除，且无法恢复。`)) return;
    button.disabled = true;
    try {
      const result = await api(`/verifications/versions/${data.selected_version.id}`, { method: 'DELETE' });
      versionCache.clear();
      taskState = await fetchTask(data.quote.id, result.selected_version_id);
      sectionDirty = false;
      activeDepartment = null;
      renderDetail();
    } catch (error) {
      button.disabled = false;
      alert(error.message);
    }
  };
}

function calculateFinancial(source) {
  const workbench = window.VerificationWorkbench;
  if (!workbench?.renderSummaryPane) return null;
  const host = document.createElement('div');
  host.className = 'verification-calc-host';
  document.body.appendChild(host);
  try {
    window.__data = { quote: taskState.quote, sections: source.sections, me: me || {} };
    const result = workbench.renderSummaryPane(host, source.sections, taskState.quote, { dept: 'verification_readonly', role: 'staff' }) || {};
    if (result.financial) return result.financial;
    const readNumber = selector => {
      const text = host.querySelector(selector)?.textContent || '';
      const value = Number(text.replace(/[^0-9.-]/g, ''));
      return Number.isFinite(value) ? value : 0;
    };
    const readout = (table, key) => readNumber(`[data-tbl="${table}"][data-key="${key}"]`);
    const fields = {
      base_price: readout('t1', 'base_price'),
      imp_mat: readout('t1', 'imp_mat'), dom_mat: readout('t1', 'dom_mat'),
      blow: readout('t1', 'blow'), slush: readout('t1', 'slush'),
      sewing_hair: readout('t1', 'sewing_hair'), sewing_cloth: readout('t1', 'sewing_cloth'),
      hardware: readout('t1', 'hardware'), electronic: readout('t1', 'electronic'),
      color_box: readout('t2', 'color_box'), libao: readout('t2', 'libao'),
      other_buy: readout('t2', 'other_buy'), carton: readout('t2', 'carton'),
      freight: readout('t2', 'freight'), cabinet: readout('t2', 'cabinet'), misc: readout('t2', 'misc'),
      injection_labor: readout('t3', 'injection_labor'),
      painting_labor: readout('t3', 'painting_labor'),
      paint_material: readout('t3', 'paint_material'),
      assembly_labor: readout('t3', 'assembly_labor'),
    };
    const taxLabels = {
      tax13: '含税13%类成本', carton: '纸箱类', tax1: '含税1%', slush3: '搪胶类3%',
      sewhair13: '车发类13%', sewcloth13: '车衣类13%', suction6: '吸塑类6%',
      freight9: '运费类9%', tax13b: '含税13%类',
    };
    const taxRows = Object.entries(taxLabels).map(([key, label]) => ({
      key,
      label,
      base: readout('t4a', key),
      rate: readout('t4r', key),
      deduction: readNumber(`#tk-ded-${key}`),
    }));
    return {
      fields,
      totalCost: num(result.totalCost ?? result.total),
      totalDeduction: num(result.totalDeduction),
      afterDeduction: num(result.afterDeduction),
      noLabor: readNumber('#tk-no-labor'),
      taxRows,
    };
  } finally {
    host.remove();
  }
}

function normalizedBaseline() {
  return {
    key: 'quote',
    type: 'quote',
    label: `${baselineTitle()} ${taskState.quote.version || ''}`.trim(),
    status: 'frozen',
    sections: (taskState.baseline.sections || []).map(section => ({
      dept: section.dept,
      dept_name: section.dept_name,
      status: section.status,
      payload_json: JSON.stringify(section.payload || {}),
    })),
  };
}

function normalizedVersion(data) {
  return {
    key: String(data.selected_version.id),
    type: 'version',
    label: data.selected_version.label,
    status: data.selected_version.status,
    sections: data.sections.map(section => ({ ...section, payload_json: section.payload_json || '{}' })),
  };
}

async function loadComparisonSource(key) {
  if (key === 'quote') return normalizedBaseline();
  const cached = versionCache.get(String(key));
  const data = cached || await fetchTask(taskState.quote.id, key);
  return normalizedVersion(data);
}

function renderPreview() {
  const quote = taskState.quote;
  const version = taskState.selected_version;
  const current = normalizedVersion(taskState);
  const financial = calculateFinancial(current);
  const salesPayload = parseJson(taskState.sections.find(section => section.dept === 'sales')?.payload_json, {});
  const confirmedCurrency = salesPayload.legacy_import?.confirmed_currency || 'USD';
  $('verification-preview').innerHTML = `<div class="verification-preview-compact-head verification-preview-task-head">
      <div><span class="eyebrow">核价任务</span><h2>${esc(quote.quote_no)}</h2></div>
      <span class="verification-status status-${esc(version.status)}">${VERSION_STATUS[version.status]}</span>
    </div>
    <div class="verification-preview-compact-data verification-preview-task-data">
      <div><span>产品</span><strong>${esc(quote.product_name || '—')}</strong></div>
      <div><span>客户 / 报价版本</span><strong>${esc(VerificationCustomers.display(quote.customer) || '—')} · ${esc(quote.version || '历史V1')}</strong></div>
      ${quote.verification_origin==='direct'?'<div><span>核价来源</span><strong>直接新建</strong></div>':`<div><span>客户确认价</span><strong>${amount(quote.confirmed_price, confirmedCurrency, confirmedCurrency === 'HKD' ? 4 : 2)}</strong></div>`}
    </div>
    <div class="verification-preview-version-badge">${esc(versionTitle(version))} · ${VERSION_STATUS[version.status]}</div>
    ${versionCategoryEditor(taskState, 'preview-version')}
    <div class="verification-baseline-note"><strong>报价基准已冻结</strong><span>核价版本按部门填写和审核，不允许直接填写最终价格</span></div>
    <div class="verification-preview-kpis">
      <div><span>当前版本</span><strong>${esc(versionTitle(version))}</strong></div>
      <div><span>部门进度</span><strong>${num(version.approved_count)} / ${num(version.total_count)}</strong></div>
      <div><span>核价总成本</span><strong>${amount(financial?.totalCost)}</strong></div>
    </div>
    <div class="verification-preview-actions">
      <button id="verification-open-detail" class="verification-primary-action">进入部门核价</button>
      <button id="verification-open-compare" class="mini">选择版本对比</button>
    </div>
    ${reopenVersionButton(taskState, 'preview-version-reopen')}
    <div class="verification-preview-version-action">${createVersionSelector(taskState, 'preview-version')}</div>`;
  $('verification-open-detail').onclick = () => openDetail('workflow');
  $('verification-open-compare').onclick = () => openDetail('compare');
  bindReopenVersion(taskState, 'preview-version-reopen', async () => {
    const latest = taskState.selected_version;
    const row = listState.find(item => Number(item.id) === Number(taskState.quote.id));
    if (row) Object.assign(row, { verification_status: latest.status, approved_count: latest.approved_count });
    renderList();
    renderPreview();
  });
  bindCreateVersion(taskState, 'preview-version');
  bindVersionCategory(taskState, 'preview-version');
}

function openDetail(mode) {
  detailMode = mode;
  activeDepartment = activeDepartment || me.dept;
  sectionDirty = false;
  $('verification-list').classList.add('hidden');
  $('verification-detail').classList.remove('hidden');
  renderDetail();
}

async function switchVersion(versionId) {
  if (sectionDirty && !confirm('当前部门有未保存修改，切换版本会放弃这些修改。确认继续？')) return;
  taskState = await fetchTask(taskState.quote.id, versionId);
  sectionDirty = false;
  renderDetail();
}

function hasOriginalWorkbook() {
  return taskState.sections.some(s => s.dept === 'sales'
    && parseJson(s.payload_json, {}).legacy_import?.excel_model);
}

function renderDetail() {
  const quote = taskState.quote;
  const version = taskState.selected_version;
  $('verification-detail').innerHTML = `<header class="verification-detail-head">
      <button id="verification-back" class="mini">← 返回核价任务</button>
      <div><span class="eyebrow">核价明细</span><h1>${esc(quote.quote_no)} · ${esc(quote.product_name)}</h1>
        <p>${esc(VerificationCustomers.display(quote.customer) || '—')} · ${baselineTitle()}建立于 ${esc(formatDate(taskState.baseline.frozen_at))}</p></div>
      <span class="verification-status status-${esc(version.status)}">${esc(version.label)} · ${VERSION_STATUS[version.status]}</span>
    </header>
    <div class="verification-version-toolbar">
      <div class="verification-version-tabs">
        ${taskState.versions.map(item => `<button data-version-id="${item.id}" class="${item.id === version.id ? 'active' : ''}">
          ${esc(item.label)}<small>${VERSION_STATUS[item.status]} · ${num(item.approved_count)}/${num(item.total_count)}</small>
        </button>`).join('')}
      </div>
      <div class="verification-version-actions">
        ${versionCategoryEditor(taskState, 'detail-version')}
        ${reopenVersionButton(taskState, 'detail-version-reopen')}
        ${createVersionSelector(taskState, 'detail-version')}
        ${deleteVersionButton(taskState, 'detail-version-delete')}
      </div>
    </div>
    <nav class="verification-mode-tabs" aria-label="核价工作模式">
      <button data-detail-mode="compare" class="${detailMode === 'compare' ? 'active' : ''}">${quote.verification_origin==='direct'?'核价版本对比':'报价 / 核价版本对比'}</button>
    </nav>
    <section id="verification-detail-content"></section>`;

  $('verification-back').onclick = async () => {
    if (sectionDirty && !confirm('当前部门有未保存修改，确认返回？')) return;
    $('verification-detail').classList.add('hidden');
    $('verification-list').classList.remove('hidden');
    await loadList();
  };
  document.querySelectorAll('[data-version-id]').forEach(button => {
    button.onclick = () => switchVersion(button.dataset.versionId);
  });
  bindVersionCategory(taskState, 'detail-version');
  document.querySelectorAll('[data-detail-mode]').forEach(button => {
    button.onclick = () => {
      if (sectionDirty && !confirm('当前部门有未保存修改，切换页面会放弃这些修改。确认继续？')) return;
      sectionDirty = false;
      detailMode = button.dataset.detailMode;
      renderDetail();
    };
  });
  bindCreateVersion(taskState, 'detail-version');
  bindReopenVersion(taskState, 'detail-version-reopen', async () => renderDetail());
  bindDeleteVersion(taskState, 'detail-version-delete');
  if (detailMode === 'workflow') renderWorkflow();
  else renderComparison();
}

function renderWorkflow() {
  const host = $('verification-detail-content');
  if (hasOriginalWorkbook()) { renderImportedWorkbook(host); return; }
  const version = taskState.selected_version;
  const departments = taskState.sections;
  const importedValuation = departments.some(section => section.dept === 'sales'
    && parseJson(section.payload_json, {}).legacy_import);
  const approvedCount = departments.filter(section => section.status === 'approved').length;
  const totalCount = departments.length;
  // “汇总与减税”是系统页签，不属于部门列表；切到汇总时不能被重置回第一个部门。
  if (activeDepartment !== '__summary__'
    && !departments.some(section => section.dept === activeDepartment)) activeDepartment = departments[0]?.dept;
  host.innerHTML = `<div class="verification-workflow-intro">
      <div><strong>${esc(version.label)} 部门核价</strong><span>流程与报价一致：填写明细 → 提交审核 → 主管审核 → 全部通过后锁定版本</span></div>
      <div class="verification-progress" aria-label="部门审核进度">
        <strong>${approvedCount} / ${totalCount}</strong><span>部门已审核</span>
      </div>
    </div>
    <div class="verification-dept-tabs">
      ${departments.map(section => `<button data-verification-dept="${esc(section.dept)}" class="${section.dept === activeDepartment ? 'active' : ''}">
        ${esc(section.dept_name)}<small class="status-${esc(section.status)}">${SECTION_STATUS[section.status]}</small>
      </button>`).join('')}
      <button data-verification-dept="__summary__" class="${activeDepartment === '__summary__' ? 'active' : ''}">${importedValuation ? '核价汇总' : '汇总与减税'}<small>系统计算</small></button>
    </div>
    <div id="verification-department-workbench"></div>`;
  document.querySelectorAll('[data-verification-dept]').forEach(button => {
    button.onclick = () => {
      if (sectionDirty && !confirm('当前部门有未保存修改，确认切换？')) return;
      sectionDirty = false;
      activeDepartment = button.dataset.verificationDept;
      renderWorkflow();
    };
  });
  renderDepartmentWorkbench();
}

function renderImportedWorkbook(host) {
  const version = taskState.selected_version;
  const fullyReviewed = taskState.sections.length > 0 && taskState.sections.every(s => s.status === 'approved');
  host.innerHTML = `<div id="verification-original-workbook"></div>
    <div class="card excel-review-panel"><div class="excel-review-row"><strong>核价审核</strong>
      <span>${fullyReviewed ? '整表已审核' : taskState.sections.every(s => ['filled','approved'].includes(s.status)) ? '待审核' : '请先提交整表审核'}</span>
      ${taskState.can_review_workbook && !fullyReviewed ? `<button id="workbook-review-all" ${taskState.workbook_review_ready ? '' : 'disabled'}>一键审核</button>` : ''}</div></div>
    <details class="card excel-review-panel"><summary>查看审核明细（${taskState.sections.filter(s => s.status === 'approved').length}/${taskState.sections.length}）</summary>
      ${taskState.sections.map(s => `<div class="excel-review-row"><strong>${esc(s.dept_name)}</strong><span>${SECTION_STATUS[s.status]}</span>
        ${s.can_review && s.status === 'filled' ? `<button class="mini" data-grid-review="${s.id}" data-action="approve">通过</button><button class="mini" data-grid-review="${s.id}" data-action="reject">驳回</button>` : ''}
        ${s.can_review && s.status === 'approved' ? `<button class="mini" data-grid-reopen="${s.id}">解除审核</button>` : ''}</div>`).join('')}
    </details>
    ${taskState.can_complete ? '<button id="workbook-complete-version">完成当前版本</button>' : ''}`;
  window.ExcelGrid.render($('verification-original-workbook'), taskState.sections, {
    onDirty: () => { sectionDirty = true; },
    onSave: async (changes, submit) => {
      const grid = $('verification-original-workbook');
      grid.inert = true;
      try {
        await api(`/verifications/versions/${version.id}/workbook`, { method: 'PUT', body: JSON.stringify({ changes, submit, base_revisions: Object.fromEntries(taskState.sections.map(s => [s.id, s.revision])) }) });
        versionCache.clear();
        taskState = await fetchTask(taskState.quote.id, version.id);
        sectionDirty = false;
        if (submit) renderDetail();
      } finally { grid.inert = false; }
    },
  });
  if ($('workbook-review-all')) $('workbook-review-all').onclick = async () => {
    if (sectionDirty) { alert('表格有未保存修改，请先保存并提交审核。'); return; }
    if (!confirm(`确认一键通过 ${version.label} 的整张导入核价表？已审核部分保持不变。`)) return;
    const button = $('workbook-review-all'); button.disabled = true;
    try {
      await api(`/verifications/versions/${version.id}/workbook/review`, {method:'POST',body:JSON.stringify({token:taskState.workbook_review_token})});
      versionCache.clear();
      taskState = await fetchTask(taskState.quote.id, version.id);
      renderDetail();
    } catch (error) { alert(error.message); button.disabled = false; }
  };
  const leaveEdits = () => !sectionDirty || confirm('有未保存的表格修改，继续将放弃修改。确认继续？');
  host.querySelectorAll('[data-grid-review]').forEach(button => {
    button.onclick = async () => {
      if (!leaveEdits()) return;
      const section = taskState.sections.find(s => Number(s.id) === Number(button.dataset.gridReview));
      const comment = button.dataset.action === 'reject' ? await requestText('请输入驳回理由') : '';
      if (button.dataset.action === 'reject' && !comment?.trim()) return;
      sectionDirty = false;
      await reviewSection(section, button.dataset.action, comment);
    };
  });
  host.querySelectorAll('[data-grid-reopen]').forEach(button => {
    button.onclick = async () => {
      if (!leaveEdits()) return;
      const reason = await requestText('请输入解除审核理由');
      if (!reason?.trim()) return;
      try {
        await api(`/verifications/versions/${version.id}/sections/${button.dataset.gridReopen}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) });
        sectionDirty = false;
        taskState = await fetchTask(taskState.quote.id, version.id);
        renderDetail();
      } catch (error) { alert(error.message); }
    };
  });
  if ($('workbook-complete-version')) $('workbook-complete-version').onclick = async () => {
    if (!confirm(`完成后 ${version.label} 将停止编辑；管理员可稍后重新开启。确认继续？`)) return;
    try {
      await api(`/verifications/versions/${version.id}/complete`, { method: 'POST', body: JSON.stringify({ note: version.note || '' }) });
      versionCache.clear();
      taskState = await fetchTask(taskState.quote.id, version.id);
      renderDetail();
    } catch (error) { alert(error.message); }
  };
}

function rendererForDepartment(department) {
  const workbench = window.VerificationWorkbench || {};
  return {
    engineering: workbench.renderEngineering,
    electronic: workbench.renderElectronic,
    molding: workbench.renderMolding,
    painting: workbench.renderPainting,
    slush: workbench.renderSlush,
    sewing: workbench.renderSewing,
    assembly: workbench.renderAssembly,
    sales: workbench.renderSales,
  }[department];
}

function currentSectionsForWorkbench() {
  return taskState.sections.map(section => ({
    ...section,
    payload_json: JSON.stringify(section._draft || parseJson(section.payload_json, {})),
  }));
}

function renderDepartmentWorkbench() {
  const host = $('verification-department-workbench');
  if (activeDepartment === '__summary__') {
    renderVersionSummary(host);
    return;
  }
  const section = taskState.sections.find(item => item.dept === activeDepartment);
  if (!section) {
    host.innerHTML = '<div class="card summary-empty">没有该部门核价明细</div>';
    return;
  }
  section._draft = section._draft || parseJson(section.payload_json, {});
  const version = taskState.selected_version;
  const editable = Boolean(section.can_edit) && !['completed', 'cancelled'].includes(version.status);
  const renderer = rendererForDepartment(section.dept);
  host.innerHTML = `<article class="card verification-department-card">
      <header class="verification-department-head">
        <div><span class="eyebrow">${esc(version.label)} · 部门核价</span><h2>${esc(section.dept_name)}</h2>
          <p>填写材料、用量、人工和加工费等明细；最终核价由系统汇总计算</p></div>
        <span class="badge status-${esc(section.status)}">${SECTION_STATUS[section.status]}</span>
      </header>
      <div class="verification-quote-reference">${taskState.quote.verification_origin==='direct'?'直接新建核价，按当前基准初始化；各部门填写完成后提交审核。':'报价数据已作为该版本初始参考，原报价保持只读；详细差异请到“报价 / 核价版本对比”查看。'}</div>
      <div id="verification-workbench-body"></div>
      <div class="verification-workbench-actions">
        ${editable ? '<button id="verification-save-draft" class="mini">保存草稿</button><button id="verification-submit">提交审核</button>' : ''}
        ${section.can_review && section.status === 'filled' ? '<button id="verification-approve">审核通过</button><button id="verification-reject" class="danger">驳回</button>' : ''}
        ${section.can_review && section.status === 'approved' ? '<button id="verification-reopen" class="mini">解除审核</button>' : ''}
        ${section.review_comment ? `<span class="verification-review-comment">${esc(section.review_comment)}</span>` : ''}
        ${version.status === 'completed' ? '<span class="verification-lock">该版本已完成；管理员可重新开启修改</span>' : ''}
        ${version.status === 'cancelled' ? '<span class="verification-lock">该版本已取消</span>' : ''}
      </div>
    </article>`;

  const body = $('verification-workbench-body');
  const sections = currentSectionsForWorkbench();
  window.__data = { quote: taskState.quote, sections, me };
  const salesPayload = parseJson(sections.find(item => item.dept === 'sales')?.payload_json, {});
  const fxRmbHkd = num(salesPayload.header?.fx_rmb_hkd) || 0.85;
  const fxHkdUsd = num(salesPayload.header?.fx_hkd_usd) || 7.8;
  const onChange = () => { sectionDirty = true; };
  if (salesPayload.legacy_import?.excel_model && section._draft.excel_native) {
    window.ExcelValuation.renderDepartment(body, section._draft, sections, editable, onChange);
  } else if (!renderer) {
    body.innerHTML = '<div class="summary-empty">该部门暂未配置核价表单</div>';
  } else if (section.dept === 'sales') {
    renderer(body, section._draft, taskState.quote, false, editable, sections, onChange, async () => {});
  } else if (section.dept === 'engineering') {
    renderer(body, section._draft, editable, onChange, fxRmbHkd, fxHkdUsd, taskState.quote.qty, taskState.quote.customer);
  } else if (section.dept === 'electronic') {
    renderer(body, section._draft, editable, onChange, fxRmbHkd, fxHkdUsd);
  } else if (section.dept === 'molding') {
    renderer(body, section._draft, editable, onChange, taskState.engineering_molds || [], fxRmbHkd, me.role);
  } else {
    renderer(body, section._draft, editable, onChange, fxRmbHkd);
  }

  let savePending = false;
  const save = async submit => {
    if (savePending) return;
    const invalid = body.querySelector('input:invalid');
    if (invalid) { invalid.reportValidity(); return; }
    if (submit && !confirm(`确认提交 ${section.dept_name} 的 ${version.label} 核价明细审核？`)) return;
    savePending = true;
    body.inert = true;
    const saveButtons = [$('verification-save-draft'), $('verification-submit')].filter(Boolean);
    saveButtons.forEach(button => { button.disabled = true; });
    try {
      await api(`/verifications/versions/${version.id}/sections/${section.id}`, {
        method: 'PUT',
        body: JSON.stringify({ payload: section._draft, submit, base_revision: section.revision }),
      });
      taskState = await fetchTask(taskState.quote.id, version.id);
      sectionDirty = false;
      renderDetail();
    } catch (error) {
      alert(error.message);
    } finally {
      savePending = false;
      body.inert = false;
      saveButtons.forEach(button => { button.disabled = false; });
    }
  };
  if ($('verification-save-draft')) $('verification-save-draft').onclick = () => save(false);
  if ($('verification-submit')) $('verification-submit').onclick = () => save(true);
  if ($('verification-approve')) $('verification-approve').onclick = () => reviewSection(section, 'approve');
  if ($('verification-reject')) $('verification-reject').onclick = async () => {
    const comment = await requestText('请输入驳回理由');
    if (!comment?.trim()) return;
    await reviewSection(section, 'reject', comment);
  };
  if ($('verification-reopen')) $('verification-reopen').onclick = async () => {
    const reason = await requestText('请输入解除审核理由');
    if (!reason?.trim()) return;
    try {
      await api(`/verifications/versions/${version.id}/sections/${section.id}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      taskState = await fetchTask(taskState.quote.id, version.id);
      renderDetail();
    } catch (error) {
      alert(error.message);
    }
  };
}

async function reviewSection(section, action, comment = '') {
  try {
    await api(`/verifications/versions/${taskState.selected_version.id}/sections/${section.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ action, comment }),
    });
    taskState = await fetchTask(taskState.quote.id, taskState.selected_version.id);
    renderDetail();
  } catch (error) {
    alert(error.message);
  }
}

function renderVersionSummary(host) {
  const version = taskState.selected_version;
  const importedHistory = taskState.sections.some(section => section.dept === 'sales'
    && parseJson(section.payload_json, {}).legacy_import?.summary_only);
  const importedValuation = taskState.sections.some(section => section.dept === 'sales'
    && parseJson(section.payload_json, {}).legacy_import);
  host.innerHTML = `<article class="card verification-version-summary">
      <header class="verification-department-head"><div><span class="eyebrow">${esc(version.label)}</span><h2>${importedValuation ? '核价汇总' : '核价汇总与减税'}</h2>
        <p>${importedValuation ? '按原核价表的汇总格式显示，金额随部门明细自动计算' : '汇总由各部门核价明细自动计算，不能直接填写最终价格'}</p></div>
        <span class="verification-status status-${esc(version.status)}">${VERSION_STATUS[version.status]}</span>
      </header>
      <div id="verification-summary-workbench"></div>
      <div class="verification-complete-panel">
        <label>版本说明 <textarea id="verification-version-note" placeholder="填写本版本主要调整原因">${esc(version.note || '')}</textarea></label>
        ${taskState.can_complete ? '<button id="verification-complete-version">完成当前版本</button>' : ''}
        ${version.status === 'ready' ? '<span>全部部门已审核，可以标记完成。</span>' : ''}
        ${version.status === 'completed' ? `<span class="verification-lock">${importedHistory ? '历史原版已完成；管理员可直接重新开启修改，系统会带入计算公式；也可复制为新版本。' : '该版本已完成；管理员可重新开启修改，也可创建下一版本。'}</span>` : ''}
      </div>
    </article>`;
  const summaryHost = $('verification-summary-workbench');
  const sections = currentSectionsForWorkbench();
  window.__data = { quote: taskState.quote, sections, me };
  window.VerificationWorkbench?.renderSummaryPane(summaryHost, sections, taskState.quote, { dept: 'verification_readonly', role: 'staff' });
  if ($('verification-complete-version')) $('verification-complete-version').onclick = async () => {
    if (!confirm(`完成后 ${version.label} 将停止编辑；管理员可稍后重新开启。确认继续？`)) return;
    try {
      await api(`/verifications/versions/${version.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ note: $('verification-version-note').value }),
      });
      versionCache.clear();
      taskState = await fetchTask(taskState.quote.id, version.id);
      renderDetail();
    } catch (error) {
      alert(error.message);
    }
  };
}

function comparisonChoices() {
  return [{ key: 'quote', label: `${baselineTitle()} ${taskState.quote.version || ''}`.trim(), status: '已冻结' }]
    .concat(taskState.versions.map(version => ({ key: String(version.id), label: version.label, status: VERSION_STATUS[version.status] })));
}

function ensureComparisonSelection() {
  const choices = comparisonChoices();
  const valid = new Set(choices.map(choice => choice.key));
  comparisonState.selected = [...new Set(comparisonState.selected.map(String))].filter(key => valid.has(key));
  if (comparisonState.selected.length < 2) {
    const latest = choices[choices.length - 1]?.key;
    comparisonState.selected = ['quote', latest].filter((key, index, values) => key && values.indexOf(key) === index);
  }
  return choices;
}

function comparisonRows(source) {
  const sales = parseJson(source.sections.find(s => s.dept === 'sales')?.payload_json, {});
  const native = sales.legacy_import?.excel_model ? window.ExcelValuation.comparisonPayloads(source.sections) : null;
  return source.sections.flatMap(section => {
    const normalized = { ...section, payload: native?.[section.dept] || parseJson(section.payload_json, {}) };
    return collectCostFields(normalized).map(row => ({
      ...row,
      dept: section.dept,
      deptName: section.dept_name,
      storageKey: `${section.dept}:${row.key}`,
    }));
  });
}

function renderComparison() {
  const host = $('verification-detail-content');
  const choices = ensureComparisonSelection();
  host.innerHTML = `<article class="card verification-comparison-card">
      <header class="verification-section-head"><div><span class="eyebrow">多版本选择</span><h2>报价 / 多版本核价对比</h2>
        <p>可同时选择原报价和多个核价版本；最左侧所选项作为差异基准</p></div></header>
      <div class="verification-source-picker verification-source-picker-multi">
        <div class="verification-source-picker-head"><strong>选择对比版本（至少 2 项）</strong>
          <div><button id="verification-select-all-versions" class="mini">全选</button><button id="verification-select-latest" class="mini">原报价 + 最新版</button></div>
        </div>
        <div class="verification-source-options">
          ${choices.map(choice => `<label><input type="checkbox" data-comparison-source="${esc(choice.key)}" ${comparisonState.selected.includes(choice.key) ? 'checked' : ''}>
            <span>${esc(choice.label)}</span><small>${esc(choice.status)}</small></label>`).join('')}
        </div>
      </div>
      <div class="verification-compare-filters">
        <select id="verification-compare-dept"><option value="all">全部部门</option>
          ${taskState.sections.map(section => `<option value="${esc(section.dept)}" ${comparisonState.dept === section.dept ? 'selected' : ''}>${esc(section.dept_name)}</option>`).join('')}
        </select>
        <input id="verification-compare-search" type="search" placeholder="搜索核价项目" value="${esc(comparisonState.query)}">
        <label><input id="verification-compare-changed" type="checkbox" ${comparisonState.changedOnly ? 'checked' : ''}> 只看变化</label>
      </div>
      <div id="verification-comparison-result"><div class="verification-preview-empty">正在计算所选版本…</div></div>
    </article>`;
  const updateSelection = () => {
    comparisonState.selected = [...document.querySelectorAll('[data-comparison-source]:checked')]
      .map(input => input.dataset.comparisonSource);
    refreshComparison();
  };
  document.querySelectorAll('[data-comparison-source]').forEach(input => { input.onchange = updateSelection; });
  $('verification-select-all-versions').onclick = () => {
    document.querySelectorAll('[data-comparison-source]').forEach(input => { input.checked = true; });
    updateSelection();
  };
  $('verification-select-latest').onclick = () => {
    const latest = choices[choices.length - 1]?.key;
    document.querySelectorAll('[data-comparison-source]').forEach(input => {
      input.checked = input.dataset.comparisonSource === 'quote' || input.dataset.comparisonSource === latest;
    });
    updateSelection();
  };
  $('verification-compare-dept').onchange = event => {
    comparisonState.dept = event.target.value;
    refreshComparison();
  };
  $('verification-compare-search').oninput = event => {
    comparisonState.query = event.target.value.trim();
    refreshComparison();
  };
  $('verification-compare-changed').onchange = event => {
    comparisonState.changedOnly = event.target.checked;
    refreshComparison();
  };
  refreshComparison();
}

function multiComparisonCell(value, baseline, currency = 'HKD', decimals = 2, isBaseline = false, exists = true) {
  if (!exists) return '<td class="verification-missing-value">—<small>该版本无此项</small></td>';
  const difference = num(value) - num(baseline);
  const klass = difference > 0.00001 ? 'delta-up' : difference < -0.00001 ? 'delta-down' : 'delta-flat';
  return `<td class="verification-version-value ${klass}"><strong>${amount(value, currency, decimals)}</strong>
    <small>${isBaseline ? '对比基准' : nearZero(difference) ? '无变化' : `较基准 ${difference > 0 ? '+' : ''}${amount(difference, currency, decimals)}`}</small></td>`;
}

async function refreshComparison() {
  const resultHost = $('verification-comparison-result');
  if (!resultHost) return;
  const selected = comparisonState.selected || [];
  if (selected.length < 2) {
    resultHost.innerHTML = '<div class="summary-empty">请至少选择两个不同的对比对象</div>';
    return;
  }
  resultHost.innerHTML = '<div class="verification-preview-empty">正在计算所选版本…</div>';
  try {
    const sources = await Promise.all(selected.map(loadComparisonSource));
    const summaries = sources.map(calculateFinancial);
    const rowMaps = sources.map(source => new Map(comparisonRows(source).map(row => [row.storageKey, row])));
    const keys = [...new Set(rowMaps.flatMap(map => [...map.keys()]))];
    const query = comparisonState.query.toLowerCase();
    const rows = keys.map(key => {
      const versionRows = rowMaps.map(map => map.get(key));
      const row = versionRows.find(Boolean);
      const values = versionRows.map(item => item?.value ?? 0);
      const presentCount = versionRows.filter(Boolean).length;
      const changed = presentCount !== sources.length || values.some(value => !nearZero(value - values[0]));
      return {
        ...row,
        versionRows,
        values,
        changeType: presentCount !== sources.length ? '版本缺项' : changed ? '有差异' : '一致',
      };
    }).filter(row => (comparisonState.dept === 'all' || row.dept === comparisonState.dept)
      && (!comparisonState.changedOnly || row.changeType !== '一致')
      && (!query || `${row.label} ${row.deptName}`.toLowerCase().includes(query)));
    const summaryRows = [
      ['货价', 'base_price'], ['成本（含人工）', 'totalCost'], ['成本（不含人工）', 'noLabor'],
      ['啤工', 'injection_labor'], ['装工', 'assembly_labor'], ['喷印工', 'painting_labor'],
      ['油漆', 'paint_material'], ['进口料', 'imp_mat'], ['国内料', 'dom_mat'],
      ['五金', 'hardware'], ['电子', 'electronic'], ['彩盒/内咭', 'color_box'],
      ['纸箱', 'carton'], ['其他外购', 'other_buy'], ['运费', 'freight'], ['杂项', 'misc'],
    ];
    const summaryValue = (summary, key) => key in summary ? summary[key] : summary.fields[key];
    const draftWarning = sources.some(source => source.type === 'version' && source.status !== 'completed')
      ? '<div class="verification-draft-warning">当前对比包含未完成核价版本，结果会随部门填写和审核继续变化。</div>' : '';
    resultHost.innerHTML = `${draftWarning}
      <div class="verification-comparison-labels verification-comparison-labels-multi">${sources.map((source, index) => `<strong>${esc(source.label)}${index === 0 ? '<small>差异基准</small>' : ''}</strong>`).join('')}</div>
      <section class="verification-comparison-section"><h3>成本汇总对比</h3>
        <div class="verification-table-scroll"><table class="verification-financial-table">
          <thead><tr><th>项目</th>${sources.map(source => `<th>${esc(source.label)}</th>`).join('')}</tr></thead>
          <tbody>${summaryRows.map(([label, key]) => {
            const values = summaries.map(summary => summaryValue(summary, key));
            return `<tr><td>${label}</td>${values.map((value, index) => multiComparisonCell(value, values[0], 'HKD', 2, index === 0)).join('')}</tr>`;
          }).join('')}</tbody>
        </table></div>
      </section>
      <section class="verification-comparison-section"><h3>部门明细变化</h3>
        <div class="verification-table-scroll"><table class="verification-comparison-table">
          <thead><tr><th>部门 / 核价项目</th><th>用量</th><th>币种</th>${sources.map(source => `<th>${esc(source.label)}</th>`).join('')}<th>状态</th></tr></thead>
          <tbody>${rows.length ? rows.map(row => {
            return `<tr><td><small>${esc(row.deptName)}</small><strong>${esc(row.label)}</strong></td><td>${esc(row.quantity)}</td><td>${esc(row.currency === 'NUMBER' ? '数值' : row.currency)}</td>
              ${row.values.map((value, index) => multiComparisonCell(value, row.values[0], row.currency, 4, index === 0, Boolean(row.versionRows[index]))).join('')}
              <td><span class="verification-row-state ${row.changeType !== '一致' ? 'changed' : ''}">${row.changeType}</span></td></tr>`;
          }).join('') : `<tr><td colspan="${sources.length + 4}" class="summary-empty">没有符合条件的变化项目</td></tr>`}</tbody>
        </table></div>
      </section>
      ${renderTaxComparison(sources, summaries)}`;
  } catch (error) {
    resultHost.innerHTML = `<div class="summary-empty">${esc(error.message)}</div>`;
  }
}

function renderTaxComparison(sources, summaries) {
  const verificationSources = sources.map((source, index) => source.type === 'version'
    ? { source, summary: summaries[index] } : null).filter(Boolean);
  if (!verificationSources.length) return '';
  const taxMaps = verificationSources.map(item => new Map(item.summary.taxRows.map(row => [row.key, row])));
  const keys = [...new Set(taxMaps.flatMap(map => [...map.keys()]))]
    .filter(key => taxMaps.some(map => num(map.get(key)?.deduction)));
  return `<section class="verification-tax-card">
    <div class="verification-section-head"><div><span class="eyebrow">多版本核价</span><h3>减税结果对比</h3>
      <p>原报价不展示减税；所选核价版本的减税结果按版本并排列示</p></div></div>
    <table class="verification-tax-table"><thead><tr><th>减税项目</th>${verificationSources.map(item => `<th>${esc(item.source.label)}</th>`).join('')}</tr></thead>
      <tbody>${keys.map(key => {
        const label = taxMaps.map(map => map.get(key)?.label).find(Boolean) || key;
        return `<tr><td>${esc(label)}</td>${taxMaps.map(map => `<td>${amount(map.get(key)?.deduction)}</td>`).join('')}</tr>`;
      }).join('')}
      <tr><td><strong>合计减税</strong></td>${verificationSources.map(item => `<td>${amount(item.summary.totalDeduction)}</td>`).join('')}</tr>
      <tr><td><strong>减税后成本</strong></td>${verificationSources.map(item => `<td>${amount(item.summary.afterDeduction)}</td>`).join('')}</tr></tbody>
    </table>
  </section>`;
}

const pairedListFilters={'verification-status-filter':'verification-table-status-filter','verification-table-status-filter':'verification-status-filter',
  'verification-customer-filter':'verification-table-customer-filter','verification-table-customer-filter':'verification-customer-filter',
  'workshop-filter':'verification-table-workshop-filter','verification-table-workshop-filter':'workshop-filter'};
function applyListFilter(id){
  if(pairedListFilters[id])$(pairedListFilters[id]).value=$(id).value;
  workshopSelected.clear();renderList();
  $('workshop-message').textContent='仅调整车间，不改变核价和完成状态';
}
for(const id of listFilterIds)$(id)[['verification-search','verification-no-filter','verification-product-filter'].includes(id)?'oninput':'onchange']=()=>applyListFilter(id);
$('verification-clear-filters').onclick=()=>{
  for(const id of listFilterIds)$(id).value='';
  workshopSelected.clear();renderList();
  $('workshop-message').textContent='仅调整车间，不改变核价和完成状态';
};
$('verification-preview').addEventListener('click', event => {
  if (event.target.closest('#verification-open-detail')) openDetail('workflow');
  if (event.target.closest('#verification-open-compare')) openDetail('compare');
});
$('btn-change-pwd').onclick = event => {
  event.preventDefault();
  openPasswordDialog();
};
$('btn-logout').onclick = async event => {
  event.preventDefault();
  try {
    await api('/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = './index.html';
  }
};

loadList().then(async () => {
  const urlParams = new URLSearchParams(location.search);
  const requestedStatus = urlParams.get('status');
  if (requestedStatus && [...$('verification-status-filter').options].some(option => option.value === requestedStatus)) {
    $('verification-status-filter').value = requestedStatus;
    $('verification-table-status-filter').value = requestedStatus;
    renderList();
  }
  const quoteId=Number(urlParams.get('quote_id'));
  if(quoteId && listState.some(row=>Number(row.id)===quoteId)) {
    await selectTask(quoteId);
    openDetail('workflow');
  }
}).catch(error => {
  $('verification-list-body').innerHTML = `<tr><td colspan="6" class="summary-empty">${esc(error.message)}</td></tr>`;
});

$('verification-create').onclick = openCreateVerification;
