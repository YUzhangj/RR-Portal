(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const payloads = sections => Object.fromEntries(sections.map(s => [s.dept, JSON.parse(s.payload_json || '{}')]));
  function context(sections, current) {
    const payload = payloads(sections);
    if (current) payload[current.excel_native.department] = current;
    const model = payload.sales.legacy_import.excel_model;
    const inputs = Object.assign({}, ...Object.values(payload).map(p => p.excel_native?.inputs || {}));
    return { model, evaluator: ExcelFormulas.createEvaluator(model, inputs), payload };
  }
  function display(value, cell = {}, detailed = false) {
    if (value == null) return '';
    if (typeof value !== 'number') return String(value);
    if (detailed) return value.toFixed(6);
    const format = (cell.z || '').split(';')[0];
    // Source dates are Excel serial numbers, not cost amounts.
    if (/^(?:m{1,2}\/d{1,2}\/y{2,4}|y{2,4}[-/]m{1,2}[-/]d{1,2})$/i.test(format)) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
      return `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
    }
    const numericFormat = format.replace(/"[^"]*"/g, '').match(/[0#][0#,]*(?:\.([0#?]+))?/);
    const decimals = numericFormat ? Math.min((numericFormat[1] || '').length, 8)
      : Number.isInteger(value) ? 0 : Math.abs(value) < 1 ? 4 : 2;
    const percent = format.includes('%');
    const rounded = Number((value * (percent ? 100 : 1)).toFixed(decimals));
    const prefix = format.match(/^"([^"]+)"/)?.[1] || '';
    return `${prefix}${rounded.toFixed(decimals)}${percent ? '%' : ''}`;
  }
  function result(ctx, id) {
    try { return { value: ctx.evaluator.value(id) }; }
    catch (error) { return { error: error.message }; }
  }
  function renderDepartment(host, payload, sections, canEdit, onChange) {
    let ctx = context(sections, payload);
    const dept = payload.excel_native.department;
    const model = ctx.model;
    let rows = (payload.legacy_items || []).map(row => ({ name: row.name, cell: row.excel_cell }));
    if (dept === 'molding') {
      const labels = { weight_g: '料重', material_unit_price: '料单价', cavity: '件数', sets: '套数', target: '目标数', shot_price: '啤工' };
      rows = (payload.injection || []).flatMap(row => Object.entries(row.source_excel_cells || {})
        .filter(([field]) => ['weight_g', 'material_unit_price', 'target', 'shot_price'].includes(field))
        .map(([field, address]) => ({ name: `${row.name} · ${labels[field]}`, cell: ExcelFormulas.key(model.sheet, address) }))).concat(rows);
    }
    if (dept === 'sales') {
      rows = Object.entries(model.cells).filter(([, c]) => c.input && c.owner === 'sales' && typeof c.v === 'number' && (!c.f || c.external_input))
        .map(([id, c]) => ({ name: c.label, cell: id }));
    }
    rows = rows.filter(row => row.cell && model.cells[row.cell] && model.cells[row.cell].v != null);
    const control = id => {
      const c = ctx.evaluator.cell(id), editable = canEdit && c.owner === dept;
      const formula = Boolean(c.f && !c.external_input);
      const value = formula ? `=${c.f}` : c.v;
      return `<input data-excel-input="${esc(id)}" data-kind="${formula ? 'formula' : 'value'}"
        value="${esc(value)}" ${editable ? '' : 'disabled'} style="min-width:150px;width:100%"
        aria-label="${esc(c.label || id)} ${formula ? '原表公式' : '参数'}">
        ${c.external_input ? `<small class="muted">外部来源金额；原引用 ${esc(c.f)}</small>` : ''}
        ${c.owner !== dept ? '<small class="muted">共享参数在业务页调整</small>' : ''}`;
    };
    const showResult = id => { const r = result(ctx, id); return r.error ? `<span style="color:#b91c1c">${esc(r.error)}</span>` : esc(display(r.value, model.cells[id])); };
    host.innerHTML = `<section class="card" style="overflow:auto">
      <h3>${dept === 'sales' ? '原表共享参数与减税基数' : '原表公式核价明细'}</h3>
      <p class="muted">调整公式或展开参数后修改数值，核价及汇总按原表引用关系重算。原表保存金额用于对照。</p>
      <p class="muted">本版本保留原表汇率、料价与税率，不自动替换为顶部统一基准；请在本版对应参数中调整。</p>
      ${rows.length ? `<table class="wb-table" style="min-width:800px;width:100%"><thead><tr>
        <th>项目</th><th>原表金额</th><th>公式 / 参数</th><th>当前核价</th></tr></thead><tbody>
        ${rows.map(row => {
          let dependencies = [];
          try { dependencies = ctx.evaluator.dependencies(row.cell, true).filter(id => model.cells[id]?.v != null && !model.cells[id].missing_sheet); } catch {}
          return `<tr><td>${esc(row.name)}<br><small class="muted">${esc(row.cell)}</small></td>
            <td>${esc(display(model.cells[row.cell].v, model.cells[row.cell]))}</td>
            <td>${control(row.cell)}${dependencies.length ? `<details><summary>展开 ${dependencies.length} 项引用参数</summary>
              <table class="wb-table"><thead><tr><th>参数</th><th>公式 / 数值</th><th>当前值</th></tr></thead><tbody>
                ${dependencies.map(id => `<tr><td>${esc(model.cells[id].label)}<br><small>${esc(id)}</small></td>
                  <td>${control(id)}</td><td data-excel-result="${esc(id)}">${showResult(id)}</td></tr>`).join('')}
              </tbody></table></details>` : ''}</td>
            <td data-excel-result="${esc(row.cell)}">${showResult(row.cell)}</td></tr>`;
        }).join('')}</tbody></table>` : '<p class="muted">原表中该部门没有单独核价项目。</p>'}
      <div data-excel-edit-error role="status" style="color:#b91c1c"></div>
    </section>`;
    if (!canEdit) return;
    host.querySelectorAll('[data-excel-input]:not([disabled])').forEach(input => {
      input.oninput = () => {
        const id = input.dataset.excelInput, cell = model.cells[id];
        try {
          let override;
          if (input.dataset.kind === 'formula') {
            const f = input.value.replace(/^=/, '');
            const refs = ExcelFormulas.references(f, ExcelFormulas.split(id)[0]);
            if (refs.some(ref => !Object.hasOwn(model.cells, ref))) throw new Error('引用的单元格未导入');
            override = { f };
          } else {
            const v = cell.t === 's' ? input.value : input.value === '' ? null : Number(input.value);
            if (cell.t !== 's' && v !== null && !Number.isFinite(v)) throw new Error('请输入有效数值');
            override = { v };
          }
          if (cell.owner !== dept) return;
          payload.excel_native.inputs[id] = override;
          ctx = context(sections, payload);
          host.querySelectorAll('[data-excel-input]').forEach(other => {
            if (other !== input && other.dataset.excelInput === id) other.value = input.value;
          });
          host.querySelectorAll('[data-excel-result]').forEach(node => { node.innerHTML = showResult(node.dataset.excelResult); });
          host.querySelector('[data-excel-edit-error]').textContent = '';
          input.setCustomValidity(''); onChange();
        } catch (error) {
          input.setCustomValidity(error.message);
          host.querySelector('[data-excel-edit-error]').textContent = error.message;
        }
      };
    });
  }
  function renderSummary(host, sections) {
    const ctx = context(sections), model = ctx.model;
    const differences = [], errors = [];
    const relevant = [...new Set([...model.tail.map(row => row.cell), ...model.groups.flatMap(g => g.rows.flat()),
      ...Object.entries(model.cells).filter(([, c]) => c.f && !c.external_input).map(([id]) => id)])];
    for (const id of relevant) {
      const c = model.cells[id];
      if (!c || typeof c.v !== 'number') continue;
      const r = result(ctx, id);
      if (r.error) errors.push({ id, error: r.error });
      else if (Math.abs(r.value - c.v) > Math.max(0.0001, Math.abs(c.v) * 1e-9)) differences.push({ id, original: c.v, actual: r.value });
    }
    const externals = Object.entries(model.cells).filter(([, c]) => c.external_input);
    const cellHtml = id => {
      const c = model.cells[id];
      if (!c) return '<td></td>';
      const r = result(ctx, id);
      return `<td title="${esc(id + (c.f ? ` =${c.f}` : ''))}" style="${c.t === 's' ? 'font-weight:600;background:#f1f5f9' : ''}">
        ${r.error ? `<span style="color:#b91c1c">${esc(r.error)}</span>` : esc(display(r.value, c))}</td>`;
    };
    const notices = `<div role="status" style="padding:12px;background:${differences.length || errors.length ? '#fff3db' : '#f0fdf4'};border-radius:6px">
      ${differences.length || errors.length ? `重算发现 ${differences.length} 项数值差异、${errors.length} 项公式错误。` : '已核对的原表公式及核价汇总与原表保存数值一致。'}
      ${differences.length ? `<details open><summary>查看金额差异</summary><table class="wb-table"><thead><tr><th>原表单元格</th><th>原表金额</th><th>当前金额</th><th>差额</th></tr></thead><tbody>${differences.map(d => `<tr><td>${esc(d.id)}</td><td>${display(d.original, {}, true)}</td><td>${display(d.actual, {}, true)}</td><td>${display(d.actual - d.original, {}, true)}</td></tr>`).join('')}</tbody></table></details>` : ''}
      ${errors.length ? `<details open><summary>查看公式错误</summary>${errors.map(e => `<div>${esc(e.id)}：${esc(e.error)}</div>`).join('')}</details>` : ''}
      ${externals.length ? `<details><summary>${externals.length} 项引用的来源表未包含在文件内，当前采用原表保存的来源金额</summary>${externals.map(([id, c]) => `<div>${esc(id)} = ${esc(c.f)}</div>`).join('')}</details>` : ''}
    </div>`;
    host.innerHTML = `<section class="card"><h3>核价汇总</h3>${notices}<table class="wb-table" style="max-width:660px;width:100%;margin-top:12px">
      <thead><tr><th>项目</th><th>核价</th></tr></thead><tbody>${model.tail.map(row => `<tr><td>${esc(row.label)}</td>${cellHtml(row.cell)}</tr>`).join('')}</tbody></table></section>
      <section class="card"><h3>成本与减税汇总</h3>${model.groups.map(group => `<h4>${esc(group.title)}</h4><div style="overflow-x:auto">
        <table class="wb-table" style="min-width:1000px;width:100%"><tbody>${group.rows.map(row => `<tr>${row.map(cellHtml).join('')}</tr>`).join('')}</tbody></table></div>`).join('')}</section>`;
    const get = name => { const r = model.metrics[name] ? result(ctx, model.metrics[name]) : {}; return r.error ? null : r.value ?? null; };
    const fields = {};
    const labels = { base_price: '货价', imp_mat: '进口料', dom_mat: '国内料', blow: '吹气', slush: '搪胶',
      sewing_hair: '车发', sewing_cloth: '车衣', hardware: '五金', electronic: '电子', color_box: '彩盒/内咭',
      libao: '利宝', other_buy: '其他外购', carton: '纸箱', freight: '运费', cabinet: '吊柜费', misc: '杂项',
      injection_labor: '啤工', painting_labor: '喷油工', paint_material: '油漆', assembly_labor: '装配工' };
    const clean = v => String(v ?? '').replace(/\s/g, '');
    for (const [field, label] of Object.entries(labels)) {
      fields[field] = null;
      for (const group of model.groups.slice(0, 3)) for (let r = 0; r < group.rows.length - 1; r++) {
        const column = group.rows[r].findIndex(id => clean(model.cells[id]?.v) === label);
        if (column >= 0) { const out = result(ctx, group.rows[r + 1][column]); fields[field] = out.error ? null : out.value; }
      }
    }
    const taxRows = [];
    const tax = model.groups.find(g => g.title === '减税与税后结果');
    if (tax?.rows.length >= 3) {
      const names = { '人工类13%': 'labor13', '纸箱类': 'carton', '含税1%': 'tax1', '搪胶类3%': 'slush3',
        '车发类13%': 'sewhair13', '车衣类13%': 'sewcloth13', '吸塑类6%': 'suction6', '运费含税9%': 'freight9', '含税13%类': 'tax13b' };
      tax.rows[0].forEach((id, column) => {
        const label = clean(model.cells[id]?.v), key = names[label];
        if (!key) return;
        const rate = result(ctx, tax.rows[1][column]), deduction = result(ctx, tax.rows[tax.rows.length - 1][column]);
        taxRows.push({ key, label, rate: rate.error ? null : rate.value * 100,
          deduction: deduction.error ? null : deduction.value,
          base: rate.error || deduction.error || !rate.value ? null : deduction.value / rate.value });
      });
    }
    return { total: get('total'), totalDeduction: get('deduction'), afterDeduction: get('after_cost'),
      financial: { fields, totalCost: get('total'), totalDeduction: get('deduction'), afterDeduction: get('after_cost'), noLabor: get('no_labor'), taxRows },
      material: get('no_labor'), labor: get('total') == null || get('no_labor') == null ? null : get('total') - get('no_labor'), packing: 0 };
  }
  function comparisonPayloads(sections) {
    const ctx = context(sections);
    for (const payload of Object.values(ctx.payload)) {
      for (const row of payload.legacy_items || []) {
        const out = result(ctx, row.excel_cell);
        row.current_hkd = out.error ? null : out.value;
        delete row.formula_kind;
      }
      for (const row of payload.injection || []) for (const [field, address] of Object.entries(row.source_excel_cells || {})) {
        const out = result(ctx, ExcelFormulas.key(ctx.model.sheet, address));
        row[field] = out.error ? null : out.value;
      }
    }
    return ctx.payload;
  }
  window.ExcelValuation = { renderDepartment, renderSummary, comparisonPayloads, context, display };
})();
