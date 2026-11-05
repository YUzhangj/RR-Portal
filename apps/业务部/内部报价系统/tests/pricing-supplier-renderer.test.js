'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Pricing = require('../frontend/injection-pricing');
const Supplier = require('../frontend/supplier-material-sync');
const source = fs.readFileSync(require.resolve('../frontend/workbench.js'), 'utf8');

// Exercise the production column renderers and renderTable input handlers with
// synthetic rows. This DOM only implements the operations those renderers use.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.style = {}; this.dataset = {};
    this.classList = { add() {} }; this.value = ''; this.textContent = '';
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  set value(value) { this.inputValue = String(value); }
  get value() { return this.inputValue; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(key, value) { this[key] = value; }
  setCustomValidity(value) { this.validationMessage = value; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
}
function contextFor(payload) {
  const changes = [], alerts = [];
  const context = vm.createContext({
    payload, window: { InjectionPricing: Pricing, SupplierMaterialSync: Supplier },
    document: { createElement: tag => new Element(tag) },
    num: value => Number(value) || 0, setTimeout() {},
    onChange: () => changes.push(JSON.stringify(payload)), alert: message => alerts.push(message),
    refMolds: [], engineeringImagesForInjection: () => [],
  });
  vm.runInContext(source.slice(source.indexOf('function renderTable('), source.indexOf('// 辅助/包装材料 类别')), context);
  vm.runInContext(source.slice(source.indexOf('function formatNum('), source.indexOf('function legacyFormulaAmount(')), context);
  vm.runInContext(source.slice(source.indexOf('function changeInjectionStructure('), source.indexOf('function engineeringMoldSyncKey(')), context);
  return { context, changes, alerts };
}
function molding(payload, readonly = false) {
  const fixture = contextFor(payload);
  const { context } = fixture;
  const moldingStart = source.indexOf('function renderMolding(');
  const pricingStart = source.indexOf('  const shotRefreshers =', moldingStart);
  const columnsStart = source.indexOf('  const cols = [', moldingStart);
  vm.runInContext(source.slice(pricingStart, source.indexOf("  renderTable(host.querySelector('#wb-material-prices')", pricingStart)) +
    source.slice(columnsStart, source.indexOf('  const wrappedOnChange =', columnsStart)) +
    '\nglobalThis.injectionColumns = cols; globalThis.machineChanged = onMachChange;', context);
  const container = new Element('div');
  context.renderTable(container, context.injectionColumns, payload.injection, { readonly, onChange: context.onChange,
    onStructureChange: context.changeInjectionStructure, showRowNumber: false });
  const cells = container.querySelectorAll('tbody')[0].children.map(row => row.children);
  const cell = (key, index = 0) => cells[index][context.injectionColumns.findIndex(col => col.key === key)];
  const input = (key, index = 0) => cell(key, index).children[0];
  const edit = (key, value, index = 0) => { const node = input(key, index); node.value = value; node.oninput(); };
  const machineStart = source.indexOf('  const machCols = [', pricingStart);
  vm.runInContext(source.slice(machineStart, source.indexOf("  renderTable(host.querySelector('#wb-machine-prices')", machineStart)) +
    '\nglobalThis.machineColumns = machCols;', context);
  const machines = new Element('div');
  context.renderTable(machines, context.machineColumns, payload.machine_prices, { onChange: context.machineChanged, showRowNumber: false });
  const editFee = (index, value) => {
    const node = machines.querySelectorAll('tbody')[0].children[index].children[2].children[0];
    node.value = value; node.oninput();
  };
  const action = (title, index = 0) => {
    const tr = container.querySelectorAll('tbody')[0].children[index];
    const button = tr.children.at(-1).children.find(item => item.title === title);
    assert.ok(button, title); button.onclick();
  };
  return { ...fixture, cell, input, edit, editFee, action };
}
function payloadWith(row) {
  return { injection: [row], injection_loss_pct: 3, indo_pct: 10, material_prices: [],
    machine_prices: [{ model: '20A', normal: '200T', price: 2020 }, { model: '10A', normal: '120T', price: 1210 }] };
}

test('真实注塑表输入联动啤价、机台及同行金额，JSON重载保留手填价和工程字段', () => {
  const row = { mold_no: '01M', machine_model: '20A', machine: '旧机台', target: 2600, sets: 2,
    cavity: '8+8', side_action: '2', shot_price: .9, weight_g: 10, material_unit_price: .1,
    source_sheet_name: '工程源', mold_size: '200×300', note: '保留手填备注' };
  const payload = payloadWith(row), before = structuredClone(row);
  const ui = molding(payload);
  assert.equal(row.shot_price, .9); // Merely rendering never reprices historical/manual values.
  ui.edit('target', '1760');
  assert.equal(row.shot_price, .5739);
  assert.equal(ui.input('shot_price').value, '0.5739');
  assert.equal(ui.input('machine').value, '200T');
  assert.equal(ui.cell('finished_amt').textContent, '1.6039');
  assert.equal(ui.cell('indo_amt').textContent, '0.1604');
  ui.edit('sets', '1'); assert.equal(row.shot_price, 1.1477);
  ui.edit('cavity', '64'); assert.equal(row.shot_price, 1.1477);
  ui.edit('machine_model', '10A'); assert.equal(row.shot_price, .6875);
  assert.equal(ui.input('machine').value, '120T');
  ui.edit('shot_price', '0.42'); assert.equal(row.shot_price, .42);
  ui.editFee(0, '3000'); assert.equal(row.shot_price, .42); // Unrelated reference row cannot destroy a manual price.
  ui.editFee(1, '1408'); assert.equal(row.shot_price, .42);
  assert.equal(row.shot_price_mode, 'manual');
  ui.edit('sets', '1'); assert.equal(row.shot_price, .8);
  assert.equal(row.shot_price_mode, 'auto');
  assert.equal(ui.input('shot_price').value, '0.8');
  assert.equal(ui.cell('finished_amt').textContent, '1.8300');
  ui.edit('target', '0'); assert.equal(row.shot_price, null); assert.equal(ui.input('shot_price').value, '');
  ui.edit('target', '1760'); ui.edit('shot_price', '.3142');
  const saved = JSON.parse(JSON.stringify(payload));
  const reopened = molding(saved);
  assert.equal(saved.injection[0].shot_price, .3142);
  assert.equal(saved.injection[0].shot_price_mode, 'manual');
  assert.equal(reopened.input('shot_price').value, '0.3142');
  for (const key of ['mold_no', 'side_action', 'source_sheet_name', 'mold_size', 'note']) assert.equal(row[key], before[key]);
  assert.ok(ui.changes.length >= 10);
});

test('只读注塑表随可编辑参考表刷新；共模分摊不被普通公式覆盖', () => {
  const payload = payloadWith({ machine_model: '20A', target: 2000, sets: 1, shot_price: 1.01, shot_price_mode: 'auto' });
  const ui = molding(payload, true);
  assert.equal(ui.cell('shot_price').children.length, 0);
  ui.editFee(0, '3000');
  assert.equal(payload.injection[0].shot_price, 1.5);
  assert.equal(ui.cell('shot_price').textContent, '1.5000');
  assert.equal(ui.cell('finished_amt').textContent, '1.5000');
  const catalog = payloadWith({ catalog_raw_weight: 0, machine_model: '20A', target: 2000, sets: 1, shot_price: .12 });
  const catalogUi = molding(catalog);
  catalogUi.edit('target', '1000'); catalogUi.editFee(0, '4000');
  assert.equal(catalog.injection[0].shot_price, .12);
  assert.equal(catalogUi.input('shot_price').value, '0.12');
});

test('输入事件生成的啤价导出后公式和缓存与页面一致', async () => {
  const payload = payloadWith({ mold_no: '01M', machine_model: '20A', target: 2600, sets: 1, shot_price: .7769 });
  const ui = molding(payload);
  ui.edit('target', '1760'); ui.editFee(0, '1408');
  const saved = JSON.parse(JSON.stringify(payload));
  const reopened = molding(saved);
  assert.equal(saved.injection[0].shot_price_mode, 'auto');
  assert.equal(reopened.input('shot_price').value, '0.8');
  const { buildWorkbook } = require('../backend/services/exportInternal');
  for (const manual of [false, true]) {
    if (manual) reopened.edit('shot_price', '0.8'); // Same numeric value still explicitly means fixed/manual.
    const workbook = await buildWorkbook({ quote: { qty: 1000 }, sections: [{ dept: 'molding', payload_json: JSON.stringify(saved) }] });
    const loaded = new (require('exceljs').Workbook)();
    await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
    for (const name of ['报价明细', '啤机明细']) {
      const sheet = loaded.getWorksheet(name); let first;
      sheet.eachRow(row => { if (row.getCell(1).value === '模号' && row.getCell(2).value === '模具名称') first = row.number + 1; });
      assert.ok(first);
      if (manual) {
        assert.equal(sheet.getCell(first, 9).value, .8);
        assert.match(sheet.getCell(first, 9).note, /固定值/);
      } else {
        assert.equal(sheet.getCell(first, 9).formula, `ROUND(1408/J${first}/L${first},4)`);
        assert.equal(sheet.getCell(first, 9).result, Number(reopened.input('shot_price').value));
      }
    }
  }
});

test('未标记历史价即使等于计算值，也不随参考费用变化；明确改本行参数才进入自动计算', () => {
  const row = { machine_model: '20A', target: 2000, sets: 1, shot_price: 1.01 };
  const payload = payloadWith(row), before = JSON.stringify(row);
  const ui = molding(payload);
  assert.equal(JSON.stringify(row), before);
  ui.editFee(0, '4000');
  assert.equal(row.shot_price, 1.01); assert.equal(row.shot_price_mode, undefined);
  ui.edit('target', '1000');
  assert.equal(row.shot_price, 4); assert.equal(row.shot_price_mode, 'auto');
  ui.editFee(0, '3000'); assert.equal(row.shot_price, 3);
});


test('同模后续零件显示只读零啤工，原料照算，重开及改目标不恢复重复价', () => {
  const first = { mold_no: 'INDEX-2', mold_part_index: 0, machine_model: '20A', target: 2800,
    source_sheet_name: '合成工程表', source_sheet_index: 0, injection_run_id: 'row:2', injection_run_part_index: 0,
    sets: 1, shot_price: .7214, shot_price_mode: 'auto', weight_g: 10, material_unit_price: .1 };
  const later = { ...first, mold_part_index: 1, name: '右大身', shot_price: .7214,
    injection_run_part_index: 1,
    shot_price_mode: 'manual', weight_g: 20 };
  const payload = payloadWith(first); payload.injection.push(later);
  const before = JSON.stringify(payload), ui = molding(payload);
  assert.equal(JSON.stringify(payload), before, '显示规则不改历史保存值');
  assert.equal(ui.cell('shot_price', 1).children.length, 0);
  assert.equal(ui.cell('shot_price', 1).textContent, '0.0000');
  assert.match(ui.cell('shot_price', 1).title, /同模/);
  assert.equal(ui.cell('finished_amt', 1).textContent, '2.0600');
  assert.equal(ui.cell('indo_amt', 1).textContent, '0.2060');
  ui.edit('target', '3000', 1);
  assert.equal(later.shot_price, 0);
  assert.equal(later.target, 3000);
  ui.edit('target', '2000'); assert.equal(first.shot_price, 1.01);
  ui.editFee(0, '4000'); assert.equal(first.shot_price, 2); assert.equal(later.shot_price, 0);
  const reopened = molding(JSON.parse(JSON.stringify(payload)));
  assert.equal(reopened.cell('shot_price', 1).textContent, '0.0000');
});

test('同模第二次啤首件可单独计价并联动，后续零件仍为只读零价', () => {
  const secondRun = { mold_no: 'INDEX-260309-05', mold_part_index: 7, injection_run_id: 'row:28',
    source_sheet_name: '合成工程表', source_sheet_index: 0,
    injection_run_name: '袖圈', injection_run_part_index: 0, target: 3200, sets: 1,
    machine_model: '20A', shot_price: .6313, weight_g: 8.1, material_unit_price: .1 };
  const payload = payloadWith(secondRun);
  payload.injection.push({ ...secondRun, mold_part_index: 8, injection_run_part_index: 1, shot_price: 0 });
  const ui = molding(payload);
  assert.equal(ui.cell('injection_run_name').textContent, '袖圈');
  assert.equal(ui.input('shot_price').value, '0.6313');
  ui.edit('target', '4000');
  assert.equal(secondRun.shot_price, .505);
  assert.equal(ui.input('shot_price').value, '0.505');
  assert.equal(ui.cell('shot_price', 1).textContent, '0.0000');
  const reopened = molding(JSON.parse(JSON.stringify(payload)));
  assert.equal(reopened.input('shot_price').value, '0.505');
});

test('实际注塑表复制和删除准确啤次计费行，不重复收费且精确保留手填价', () => {
  const first = { mold_no: 'M', source_sheet_name: '工程表', source_sheet_index: 0,
    product_group_id: 'A', injection_run_id: 'row:2', injection_run_part_index: 0,
    mold_part_index: 0, name: '首件', machine_model: '20A', machine: '200T',
    target: 2000, sets: 1, cycle_sec: 31, shot_price: .3142, shot_price_mode: 'manual' };
  const later = { ...first, name: '后续件', mold_part_index: 1, injection_run_part_index: 1,
    target: 9999, sets: 9, shot_price: 0, shot_price_mode: 'auto', weight_g: 8 };
  const other = { ...first, product_group_id: 'B', name: '其他产品', shot_price: .9 };
  const payload = payloadWith(first); payload.injection.push(later, other);
  const otherBefore = JSON.stringify(other), ui = molding(payload);
  ui.action('在下方插入副本（用于拆分）');
  assert.deepEqual(payload.injection.map(row => row.injection_run_part_index), [0, 2, 1, 0]);
  assert.equal(payload.injection.reduce((sum, row) => sum + Number(Pricing.laborPrice(row) || 0), 0), 1.2142);
  ui.action('删除');
  assert.equal(payload.injection.length, 3);
  assert.equal(later.injection_run_part_index, 0);
  for (const field of ['shot_price', 'shot_price_mode', 'target', 'sets', 'cycle_sec', 'machine_model', 'machine']) {
    assert.equal(later[field], first[field], field + ' transferred exactly from this run');
  }
  assert.equal(later.name, '后续件'); assert.equal(later.weight_g, 8);
  assert.equal(JSON.stringify(other), otherBefore);
  const reopened = molding(JSON.parse(JSON.stringify(payload)));
  assert.equal(reopened.input('shot_price', 1).value, '0.3142');
  assert.equal(reopened.cell('shot_price', 0).textContent, '0.0000');
  reopened.action('上移', 1);
  assert.equal(payload.injection[1].shot_price, .3142, 'moving the reopened copy does not change saved payload');
});

test('缺准确来源或啤次计费行歧义时，结构按钮保持原数组；旧手填行不猜归组', () => {
  const base = { mold_no: 'M', source_sheet_name: '工程表', source_sheet_index: 0,
    injection_run_id: 'row:2', injection_run_part_index: 0, shot_price: .3, shot_price_mode: 'manual' };
  for (const rows of [
    [{ ...base, source_sheet_index: null }, { ...base, injection_run_part_index: 1 }],
    [{ ...base }, { ...base }],
    [{ ...base, injection_run_part_index: 1 }],
  ]) {
    const payload = payloadWith(rows[0]); payload.injection = rows;
    const before = JSON.stringify(payload), ui = molding(payload);
    ui.action('在下方插入副本（用于拆分）'); ui.action('删除');
    assert.equal(JSON.stringify(payload), before);
    assert.equal(ui.changes.length, 0); assert.equal(ui.alerts.length, 2);
  }
  const legacy = payloadWith({ mold_no: 'M', mold_part_index: 3, shot_price: .7, shot_price_mode: 'manual' });
  const ui = molding(legacy); assert.equal(ui.input('shot_price').value, '0.7');
  ui.action('在下方插入副本（用于拆分）');
  assert.deepEqual(legacy.injection.map(row => row.shot_price), [.7, .7], 'legacy rows retain their existing independent/manual behavior');
});

test('真实供应商输入保留同名原标识，改名歧义恢复原归属，JSON重载可继续同步', () => {
  const row = { supplier_id: 'A', supplier_name: '同名厂', name: '吸塑', qty: 1, unit_price_rmb: .1 };
  const payload = { hardware: [row, { supplier_id: 'B', supplier_name: '同名厂' }],
    aux_materials: [{ supplier_id: 'C', supplier_name: '另一同名厂' }, { supplier_id: 'D', supplier_name: '另一同名厂' }], packaging_materials: [] };
  const { context, changes, alerts } = contextFor(payload);
  const start = source.indexOf('  const supplierColumn = {');
  vm.runInContext(source.slice(start, source.indexOf('  const freeCols = [', start)) + '\nglobalThis.supplierColumn = supplierColumn;', context);
  const td = new Element('td');
  context.supplierColumn.renderCell(td, row, { readonly: false, onChange: context.onChange });
  const input = td.children[0]; input.onfocus();
  input.value = '同名厂'; input.oninput(); assert.equal(row.supplier_id, 'A');
  input.value = '另一'; input.oninput();
  input.value = '另一同名厂'; input.oninput();
  assert.equal(row.supplier_id, 'A'); assert.equal(row.supplier_name, '同名厂');
  assert.match(input.validationMessage, /多个标识/);
  input.onchange(); assert.equal(input.value, '同名厂'); assert.equal(alerts.length, 1);
  const saved = JSON.parse(JSON.stringify(row));
  const plan = Supplier.plan({ supplier: { id: 'A', name: '同名厂' }, batches: [{ id: 'hardware', existing: [saved, payload.hardware[1]], items: [{ name: '吸塑', qty: 2, unit_price_rmb: .2 }] }] });
  assert.equal(plan.counts.updated, 1); assert.equal(plan.counts.added, 0);
  assert.equal(plan.batches[0].rows[0].qty, 2); assert.equal(plan.batches[0].rows[1].supplier_id, 'B');
  assert.equal(changes.length, 3);
  const readonly = new Element('td');
  context.supplierColumn.renderCell(readonly, row, { readonly: true });
  assert.equal(readonly.children.length, 0); assert.equal(readonly.textContent, '同名厂');
});
