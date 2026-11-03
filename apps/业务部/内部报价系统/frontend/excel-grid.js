(function () {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const letters = index => { let s = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
  const position = address => { const m = address.match(/^([A-Z]+)(\d+)$/); return { r: Number(m[2]) - 1, c: [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1 }; };
  // A missing external workbook does not remove the source formula. Display it
  // while the evaluator continues using the original cached value.
  const editorText = cell => cell?.f ? `=${cell.f}` : cell?.v ?? '';
  const snapshotNote = cell => cell?.external_input && cell?.f
    ? `使用原表保存值：${cell.v ?? '空白'}（外部来源未提供，公式保留，不套用当前基数）` : '';
  const clampZoom = value => Math.min(200, Math.max(50, Number(value) || 100));

  function referenceGroups(formula, sheet) {
    const groups = [], seen = new Set();
    function visit(node) {
      if (node.type === 'ref' || node.type === 'range') {
        const ids = node.type === 'ref' ? [node.key] : node.keys.flat();
        if (!ids.length) return;
        const label = ids[0] + (ids.length > 1 ? `:${ExcelFormulas.split(ids[ids.length - 1])[1]}` : '');
        if (!seen.has(label)) { seen.add(label); groups.push({ label, ids }); }
      } else {
        if (node.a) visit(node.a);
        if (node.b) visit(node.b);
        (node.args || []).forEach(visit);
      }
    }
    visit(ExcelFormulas.parse(formula, sheet));
    return groups;
  }

  function borderStyle(layout, r, c, merge) {
    const borders = layout?.borders || {}, end = merge?.e || {r,c};
    const widths = {hair:1,thin:1,medium:2,thick:3,double:3,dotted:1,dashed:1,mediumDashed:2,dashDot:1,mediumDashDot:2,dashDotDot:1,mediumDashDotDot:2,slantDashDot:2};
    const at = (row, col, side) => row < 0 || col < 0 ? null : borders[`${letters(col)}${row + 1}`]?.[side];
    const edge = candidates => candidates.filter(b => b && widths[b.style]).sort((a,b) => widths[b.style] - widths[a.style])[0];
    const result = [];
    const add = (side, candidates) => {
      const b = edge(candidates); if (!b) return;
      const style = b.style === 'double' ? 'double' : b.style === 'dotted' ? 'dotted' : /dash/i.test(b.style) ? 'dashed' : 'solid';
      result.push(`border-${side}:${widths[b.style]}px ${style} ${/^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#000000'}`);
    };
    const right = [], bottom = [], left = [], top = [];
    // Each shared edge is drawn once. The adjacent cell may own the original line.
    for (let row = r; row <= end.r; row++) {
      right.push(at(row,end.c,'right'),at(row,end.c+1,'left'));
      if (c === 0) left.push(at(row,c,'left'));
    }
    for (let col = c; col <= end.c; col++) {
      bottom.push(at(end.r,col,'bottom'),at(end.r+1,col,'top'));
      if (r === 0 || layout?.rowIndices && !layout.rowIndices.includes(r - 1)) top.push(at(r,col,'top'));
    }
    add('right',right);add('bottom',bottom);add('left',left);add('top',top);
    return result.join(';');
  }

  function render(host, sections, options = {}) {
    const base = Object.fromEntries(sections.map(s => [s.dept, JSON.parse(s.payload_json || '{}')]));
    const drafts = structuredClone(base), model = drafts.sales.legacy_import.excel_model;
    const byDept = Object.fromEntries(sections.map(s => [s.dept, s]));
    let activeSheet = model.sheet, selected = null, editorDirty = false, changed = new Set(), formulaView = false;
    let visibleCells = new Map(), mergedAnchors = new Map();
    let zoom = 100;
    try { zoom = clampZoom(localStorage.getItem('verification-sheet-zoom')); } catch (_) {}
    const expandedRows = new Map();
    const traceColors = [['#b45309','#fff3cd'],['#7c3aed','#f3e8ff'],['#0f766e','#ccfbf1'],['#be185d','#fce7f3'],['#0369a1','#e0f2fe'],['#4d7c0f','#ecfccb']];
    const inputs = () => Object.assign({}, ...Object.values(drafts).map(p => p.excel_native?.inputs || {}));
    let evaluator = ExcelFormulas.createEvaluator(model, inputs());
    const editable = id => Boolean(byDept[model.cells[id]?.owner || 'sales']?.can_edit) && Boolean(model.cells[id]) && !model.cells[id].missing_sheet;
    const sheetNames = [model.sheet, ...new Set(Object.entries(model.cells).filter(([, c]) => !c.missing_sheet)
      .map(([id]) => ExcelFormulas.split(id)[0]).filter(s => s !== model.sheet))];
    host.innerHTML = `<article class="excel-sheet-card">
      <div class="excel-sheet-tools"><strong>原核价表</strong><select data-sheet-select aria-label="工作表">${sheetNames.map(name => `<option value="${esc(name)}">${esc(name === model.sheet ? name : `引用参数：${name}`)}</option>`).join('')}</select>
        <label><input type="checkbox" data-show-formulas>显示全部公式</label>
        <div class="excel-zoom-tools" role="group" aria-label="工作表缩放">
          <button type="button" class="mini" data-zoom-out aria-label="缩小工作表">−</button>
          <input type="range" data-zoom-range min="50" max="200" step="10" aria-label="工作表缩放比例">
          <output data-zoom-label aria-live="polite"></output>
          <button type="button" class="mini" data-zoom-in aria-label="放大工作表">＋</button>
          <button type="button" class="mini" data-zoom-reset>恢复100%</button>
        </div><span class="excel-sheet-spacer"></span>
        <span data-save-status role="status">${sections.some(s => s.can_edit) ? '点选单元格，在公式栏修改' : '当前版本只读'}</span>
        ${sections.some(s => s.can_edit) ? '<button data-grid-save>保存表格</button><button class="mini" data-grid-submit>提交审核</button>' : ''}
      </div>
      <div class="excel-formula-bar"><input data-cell-address aria-label="单元格位置" placeholder="例如 C44" style="width:105px"><span>fx</span>
        <input data-cell-editor aria-label="单元格数值或公式" placeholder="选中单元格后显示数值或公式" disabled><button data-cell-apply class="mini" disabled>应用</button></div>
      <div class="excel-cell-info" data-cell-info>按原工作表行列显示。${model.source_range ? `本货号范围：${esc(model.source_range)}，上方保留公共基数。` : ''}修改保留在当前版本，保存后生效。</div>
      <div class="excel-reference-legend" data-reference-legend hidden aria-label="公式引用单元格"></div>
      <div data-grid-scroll class="excel-grid-scroll" tabindex="0" aria-label="完整核价表，可上下左右滚动"></div>
      <details class="excel-grid-audit"><summary data-audit-title></summary><div data-audit-body></div></details>
      <div data-grid-error role="alert" class="excel-grid-error"></div>
    </article>`;
    const find = selector => host.querySelector(selector);
    function applyZoom(value) {
      const scroller = find('[data-grid-scroll]'), previous = zoom;
      zoom = clampZoom(value);
      const table = find('.excel-original-grid');
      if (table) table.style.zoom = String(zoom / 100);
      scroller.scrollLeft *= zoom / previous;
      scroller.scrollTop *= zoom / previous;
      find('[data-zoom-range]').value = zoom;
      find('[data-zoom-label]').textContent = `${zoom}%`;
      find('[data-zoom-out]').disabled = zoom <= 50;
      find('[data-zoom-in]').disabled = zoom >= 200;
      try { localStorage.setItem('verification-sheet-zoom', String(zoom)); } catch (_) {}
    }
    find('[data-zoom-out]').onclick = () => applyZoom(zoom - 10);
    find('[data-zoom-in]').onclick = () => applyZoom(zoom + 10);
    find('[data-zoom-reset]').onclick = () => applyZoom(100);
    find('[data-zoom-range]').oninput = event => applyZoom(event.target.value);
    const editor = find('[data-cell-editor]'), addressInput = find('[data-cell-address]');
    const getResult = id => { try { return { value: evaluator.value(id) }; } catch (e) { return { error: e.message }; } };
    const visibleNode = id => visibleCells.get(mergedAnchors.get(id) || id);
    function trace() {
      for (const node of visibleCells.values()) {
        node.classList.remove('is-reference'); node.removeAttribute('data-reference-label');
        node.style.removeProperty('--reference-color'); node.style.removeProperty('--reference-fill');
        node.classList.toggle('selected', node === visibleNode(selected));
      }
      const legend = find('[data-reference-legend]');
      legend.innerHTML = ''; legend.hidden = true;
      if (!selected) return;
      const current = evaluator.cell(selected);
      const formula = editorDirty ? (editor.value.startsWith('=') ? editor.value : '') : current?.f;
      if (!formula) return;
      let groups;
      try { groups = referenceGroups(formula, ExcelFormulas.split(selected)[0]); }
      catch { legend.hidden = false; legend.textContent = '当前公式无法解析，暂不能标注引用格子。'; return; }
      if (!groups.length) return;
      legend.hidden = false;
      legend.innerHTML = `<span>引用格子（点击定位）：</span><button type="button" data-reference-jump="${esc(selected)}" class="excel-reference-origin">返回 ${esc(selected)}</button>`;
      groups.forEach((group, i) => {
        const [color, fill] = traceColors[i % traceColors.length];
        const target = group.ids.find(id => model.cells[id] && !model.cells[id].missing_sheet && sheetNames.includes(ExcelFormulas.split(id)[0]));
        for (const id of group.ids) {
          const node = visibleNode(id);
          if (!node || node.classList.contains('is-reference')) continue;
          node.classList.add('is-reference'); node.dataset.referenceLabel = group.label;
          node.style.setProperty('--reference-color',color); node.style.setProperty('--reference-fill',fill);
        }
        legend.insertAdjacentHTML('beforeend', `<button type="button" class="excel-reference-chip" style="--reference-color:${color};--reference-fill:${fill}" data-reference-jump="${esc(target || '')}" ${target ? '' : 'disabled'}>${i + 1}. ${esc(group.label)}${target ? '' : '（来源未导入）'}</button>`);
      });
    }
    find('[data-reference-legend]').onclick = event => {
      const id = event.target.closest('[data-reference-jump]')?.dataset.referenceJump;
      if (!id) return;
      const sheet = ExcelFormulas.split(id)[0];
      const r = position(ExcelFormulas.split(id)[1]).r;
      if (!expandedRows.has(sheet)) expandedRows.set(sheet, new Set());
      expandedRows.get(sheet).add(r);
      if (sheet !== activeSheet || !visibleNode(id)) { activeSheet = sheet; find('[data-sheet-select]').value = sheet; draw(); }
      // Looking at a dependency does not change or commit the formula being inspected.
      visibleNode(id)?.scrollIntoView({ block: 'center', inline: 'center' });
    };
    function audit() {
      const mismatches = [], errors = [], external = [];
      for (const [id, original] of Object.entries(model.cells)) {
        if (original.missing_sheet) continue;
        const current = evaluator.cell(id), result = getResult(id);
        if (current.external_input || evaluator.fallback(id)) external.push(id);
        if (result.error) errors.push([id, result.error]);
        else if (typeof original.v === 'number' && typeof result.value === 'number' && Math.abs(result.value - original.v) > 1e-7)
          mismatches.push([id, original.v, result.value]);
      }
      find('[data-audit-title]').textContent = `核对原表：${mismatches.length} 项数值差异，${errors.length} 项公式错误${external.length ? `，${external.length} 项外部来源沿用原表金额` : ''}`;
      find('[data-audit-body]').innerHTML = `${mismatches.length ? `<table><thead><tr><th>单元格</th><th>原值</th><th>当前值</th></tr></thead><tbody>${mismatches.map(([id, a, b]) => `<tr><td>${esc(id)}</td><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${errors.map(([id, error]) => `<p>${esc(id)}：${esc(error)}</p>`).join('')}
        ${external.map(id => `<p>${esc(id)}：原引用 =${esc(evaluator.cell(id).f)}；${esc(evaluator.fallback(id)||snapshotNote(evaluator.cell(id)))}</p>`).join('')}`;
    }
    function fillCell(node) {
      const id = node.dataset.gridCell, original = model.cells[id], current = evaluator.cell(id), out = getResult(id);
      node.textContent = formulaView && current?.f ? `=${current.f}` : out.error ? '#错误' : ExcelValuation.display(out.value, original);
      node.classList.toggle('has-error', Boolean(out.error));
      node.classList.toggle('is-number', typeof out.value === 'number');
      node.classList.toggle('is-formula', Boolean(current?.f));
      node.classList.toggle('is-edited', Object.hasOwn(inputs(), id));
      node.title = `${id}${current?.f ? ` =${current.f}` : ''}${snapshotNote(current) ? `\n${snapshotNote(current)}` : ''}${out.error ? `\n${out.error}` : ''}`;
      if(evaluator.fallback(id))node.title+='\n'+evaluator.fallback(id);
    }
    function draw() {
      const ids = Object.keys(model.cells).filter(id => ExcelFormulas.split(id)[0] === activeSheet && !model.cells[id].missing_sheet);
      const positions = ids.map(id => position(ExcelFormulas.split(id)[1]));
      const layout = activeSheet === model.sheet ? model.layout : null;
      const rows = layout?.rows || Math.max(1, ...positions.map(p => p.r + 1));
      const cols = layout?.columns || Math.max(1, ...positions.map(p => p.c + 1));
      // Shared-sheet imports retain original row numbers without rendering the
      // thousands of rows belonging to other products. Dependencies stay intact.
      const rowIndices = [...new Set([...(layout?.rowIndices || (layout ? Array.from({length:rows},(_,r)=>r)
        : positions.map(p=>p.r))), ...(expandedRows.get(activeSheet) || [])])].sort((a,b)=>a-b);
      const covered = new Set(), starts = new Map(); mergedAnchors = new Map();
      for (const merge of layout?.merges || []) {
        // Keep any unexpected populated merged child visible rather than lose data.
        let populatedChild = false;
        for (let r = merge.s.r; r <= merge.e.r; r++) for (let c = merge.s.c; c <= merge.e.c; c++) {
          if ((r !== merge.s.r || c !== merge.s.c) && model.cells[ExcelFormulas.key(activeSheet, `${letters(c)}${r + 1}`)]?.v != null) populatedChild = true;
        }
        if (populatedChild) continue;
        starts.set(`${merge.s.r}:${merge.s.c}`, merge);
        for (let r = merge.s.r; r <= merge.e.r; r++) for (let c = merge.s.c; c <= merge.e.c; c++)
          if (r !== merge.s.r || c !== merge.s.c) {
            covered.add(`${r}:${c}`);
            mergedAnchors.set(ExcelFormulas.key(activeSheet, `${letters(c)}${r + 1}`), ExcelFormulas.key(activeSheet, `${letters(merge.s.c)}${merge.s.r + 1}`));
          }
      }
      let html = `<table class="excel-original-grid"><colgroup><col style="width:46px">${Array.from({ length: cols }, (_, c) => `<col style="width:${layout?.widths?.[c] || (c < 2 ? 230 : 112)}px">`).join('')}</colgroup><thead><tr><th></th>${Array.from({ length: cols }, (_, c) => `<th>${letters(c)}</th>`).join('')}</tr></thead><tbody>`;
      for (const r of rowIndices) {
        html += `<tr><th>${r + 1}</th>`;
        for (let c = 0; c < cols; c++) {
          if (covered.has(`${r}:${c}`)) continue;
          const merge = starts.get(`${r}:${c}`), id = ExcelFormulas.key(activeSheet, `${letters(c)}${r + 1}`);
          html += `<td data-grid-cell="${esc(id)}" tabindex="-1" style="${borderStyle(layout,r,c,merge)}"${merge ? ` rowspan="${merge.e.r - r + 1}" colspan="${merge.e.c - c + 1}"` : ''}></td>`;
        }
        html += '</tr>';
      }
      find('[data-grid-scroll]').innerHTML = `${html}</tbody></table>`;
      applyZoom(zoom);
      host.querySelectorAll('[data-grid-cell]').forEach(fillCell);
      visibleCells = new Map([...host.querySelectorAll('[data-grid-cell]')].map(n => [n.dataset.gridCell,n]));
      trace();
    }
    function select(id) {
      selected = id;
      host.querySelectorAll('[data-grid-cell].selected').forEach(n => n.classList.remove('selected'));
      const cellNode = [...host.querySelectorAll('[data-grid-cell]')].find(n => n.dataset.gridCell === id);
      cellNode?.classList.add('selected');
      const c = evaluator.cell(id), old = model.cells[id];
      addressInput.value = ExcelFormulas.split(id)[1];
      editor.value = editorText(c);
      editor.disabled = !editable(id); find('[data-cell-apply]').disabled = editor.disabled;
      editorDirty = false;
      find('[data-grid-error]').textContent = '';
      find('[data-cell-info]').textContent = `${id}　原表公式：${old?.f ? `=${old.f}` : '无'}　原表保存值：${old?.v ?? '空白'}${editable(id) ? '' : '　只读'}${snapshotNote(c) ? `　${snapshotNote(c)}` : ''}`;
      trace();
    }
    function apply() {
      if (!editorDirty) return true;
      if (!selected || !editable(selected)) return false;
      try {
        const text = editor.value, old = model.cells[selected], dept = old.owner || 'sales';
        // Focusing/retyping the displayed source formula must not unfreeze its
        // cached value or create a spurious override when saving the sheet.
        if (text === String(editorText(evaluator.cell(selected)))) { editorDirty = false; trace(); return true; }
        let override;
        if (text.startsWith('=')) {
          const f = text.slice(1), refs = ExcelFormulas.references(f, ExcelFormulas.split(selected)[0]);
          if (refs.some(id => !Object.hasOwn(model.cells, id) || model.cells[id].missing_sheet)) throw new Error('引用的单元格未导入，请保留原公式和保存值，或选择原表已有参数');
          override = { f, t: 'n', external_input: false };
        } else {
          const numeric = text.trim() !== '' && Number.isFinite(Number(text));
          override = { v: text === '' ? null : numeric ? Number(text) : text.replace(/^'/, ''), f: null, t: numeric ? 'n' : 's', external_input: false };
        }
        const next = ExcelFormulas.createEvaluator(model, { ...inputs(), [selected]: override });
        next.value(selected); // Reject an introduced cycle or invalid expression, not the workbook's existing errors.
        drafts[dept].excel_native.inputs[selected] = override;
        evaluator = next; changed.add(dept); editorDirty = false;
        host.querySelectorAll('[data-grid-cell]').forEach(fillCell); audit(); select(selected);
        find('[data-grid-error]').textContent = ''; find('[data-save-status]').textContent = '有未保存修改';
        options.onDirty?.(); return true;
      } catch (error) { find('[data-grid-error]').textContent = error.message; return false; }
    }
    find('[data-cell-apply]').onclick = apply;
    editor.oninput = () => { editorDirty = true; trace(); options.onDirty?.(); };
    editor.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } if (event.key === 'Escape') select(selected); };
    find('[data-grid-scroll]').onclick = event => {
      const cell = event.target.closest('[data-grid-cell]');
      if (cell && apply()) select(cell.dataset.gridCell);
    };
    find('[data-grid-scroll]').ondblclick = () => { if (!editor.disabled) { editor.focus(); editor.select(); } };
    addressInput.onkeydown = event => {
      if (event.key !== 'Enter' || !apply()) return;
      const address = addressInput.value.trim().toUpperCase();
      if (!/^[A-Z]+\d+$/.test(address)) return;
      const id = ExcelFormulas.key(activeSheet, address);
      const node = [...host.querySelectorAll('[data-grid-cell]')].find(n => n.dataset.gridCell === id);
      if (node) { select(id); node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    };
    find('[data-sheet-select]').onchange = event => {
      if (!apply()) { event.target.value = activeSheet; return; }
      activeSheet = event.target.value; selected = null; draw(); editor.value = ''; editor.disabled = true;
      addressInput.value = ''; find('[data-cell-info]').textContent = '点选单元格查看数值、公式及彩色引用标注。';
      find('[data-cell-apply]').disabled = true;
    };
    find('[data-show-formulas]').onchange = event => { formulaView = event.target.checked; host.querySelectorAll('[data-grid-cell]').forEach(fillCell); };
    async function save(submit) {
      if (!apply()) return;
      if (submit && !confirm('确认将可编辑部分提交审核？')) return;
      const depts = submit ? sections.filter(s => s.can_edit).map(s => s.dept) : [...changed];
      if (!depts.length) { find('[data-save-status]').textContent = '没有未保存修改'; return; }
      const changes = depts.map(dept => ({ section_id: byDept[dept].id, inputs: drafts[dept].excel_native.inputs,
        base_inputs: base[dept].excel_native?.inputs || {} }));
      host.querySelectorAll('[data-grid-save],[data-grid-submit]').forEach(b => b.disabled = true);
      try {
        await options.onSave(changes, submit);
        for (const dept of depts) base[dept] = structuredClone(drafts[dept]);
        changed.clear(); if (find('[data-save-status]')) find('[data-save-status]').textContent = '已保存';
      } catch (error) { if (find('[data-grid-error]')) find('[data-grid-error]').textContent = error.message; }
      finally { host.querySelectorAll('[data-grid-save],[data-grid-submit]').forEach(b => b.disabled = false); }
    }
    if (find('[data-grid-save]')) find('[data-grid-save]').onclick = () => save(false);
    if (find('[data-grid-submit]')) find('[data-grid-submit]').onclick = () => save(true);
    draw(); audit();
  }
  window.ExcelGrid = { render, borderStyle, referenceGroups, editorText, snapshotNote };
})();
