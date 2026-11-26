'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../frontend/indonesia-freight');
const { buildOutputWorkbook } = require('../backend/services/nexusOutputTemplate');
const { calculateQuoteCosts } = require('../backend/services/quoteCostSummary');
const { boundOverride } = require('../backend/services/outputWorkbookOverrides');
const { serializeWorkbook } = require('../backend/services/workbookPreview');
const sections = data => Object.entries(data).map(([dept, payload]) => ({ dept, payload_json: JSON.stringify(payload) }));

test('历史各部门比例保持原值，主动设置零值不会被默认值覆盖', () => {
  const original = sections({ sales: {}, engineering: { indo_pct: 8 }, molding: { indo_pct: 0,
    mixed_products: { a: { indo_pct: 3 } }, mixed_shared: { indo_pct: 4 } } });
  const normalized = policy.normalizeSections(original);
  assert.equal(policy.rate(normalized), null);
  assert.deepEqual(normalized, original);
  assert.equal(JSON.parse(normalized[2].payload_json).mixed_products.a.indo_pct, 3);
  assert.equal(JSON.parse(normalized[2].payload_json).mixed_shared.indo_pct, 4);
  assert.equal(JSON.parse(original[2].payload_json).indo_pct, 0);
  assert.equal(JSON.parse(policy.normalizeSections(original, 0)[0].payload_json).indo_pct, 0);
  const hidden = { dept: 'engineering', payload_json: null };
  assert.equal(policy.normalizeSections([hidden], 8)[0].payload_json, null);
});

test('统一比例显示百分号，公式可编辑且联动运费、成本及报价', async () => {
  const args = { quote: { quote_no: 'UNIFIED-INDO', qty: 1000 }, sections: sections({
    sales: { output_unified_indonesia: true, indo_pct:8, header: { fx_rmb_hkd: 1 }, shipping: { scenarios: [{ name: '出厂价', is_factory: true }] } },
    engineering: { indo_pct: 8, hardware: [{ name: '五金', qty: 2, unit_price: 10 }],
      aux_materials: [{ name: '辅助', qty: 1, unit_price: 10 }],
      packaging_materials: [{ name: '彩盒', qty: 1, unit_price: 5 }] },
    electronic: { indo_pct: 0, electronics: [{ name: 'IC', qty: 1, unit_price: 100 }, { name: 'PCB', qty: 1, unit_price: 20 }] },
    molding: { indo_pct: 0, injection: [{ name: '注塑', shot_price: 10, weight_g: 0, sets: 1 }] },
    painting: { indo_pct: 0, painting_items: [{ name: '喷油', spray_qty: 1, spray_unit: 10 }] },
    slush: { indo_pct: 0, slush_items: [{ name: '搪胶', qty: 1, unit_price_hkd: 20 }] },
  }) };
  const costs = calculateQuoteCosts(args.quote, args.sections);
  assert.ok(Math.abs(costs.indoFreightBase - 88) < 1e-9);
  assert.ok(Math.abs(costs.indoFreight - 7.04) < 1e-9);
  const base = await buildOutputWorkbook(args);
  const ws = base.getWorksheet('报价明细');
  assert.equal(ws.getCell('O7').value, 8);
  assert.equal(base.outputEditState.editable.has('报价明细!O7'), true);
  const preview = serializeWorkbook(base).find(sheet => sheet.name === '报价明细');
  assert.equal(preview.cells.find(cell => cell.address === 'O7').value, '8.00%');
  let freight, total, quote;
  ws.eachRow(row => {
    if (row.getCell(2).value === '印尼运费') freight = row.getCell(4);
    if (row.getCell(1).value === '直接成本合计') total = row.getCell(4);
    if (row.getCell(2).value === '报价（MOQ3K）') quote = row.getCell(4);
  });
  assert.ok(freight && total && quote);
  assert.match(freight.formula, /\$O\$7/);
  const override = (address, value) => ({ sheet_name: '报价明细', cell_address: address,
    value_json: JSON.stringify(boundOverride(base, '报价明细', address, value, address === 'O7' ? 'sales' : 'engineering')) });
  const changed = await buildOutputWorkbook({ ...args, overrides: [override('O7', 10)] });
  const next = changed.getWorksheet('报价明细');
  assert.deepEqual(changed.outputEditState.conflicts, []);
  assert.ok(Math.abs(next.getCell(freight.address).result - 8.8) < 1e-9);
  // The independent surtax source is unchanged by a temporary rate correction.
  // Persisting O7 synchronizes the source payloads and rebuilds all costs.
  const expectedDelta = 8.8 - 7.04;
  assert.ok(Math.abs(next.getCell(total.address).result - total.result - expectedDelta) < 1e-8);
  assert.ok(next.getCell(quote.address).result > quote.result);
  const hardwareRow = preview.cells.find(cell => cell.column === 3 && cell.value.startsWith('五金 ('));
  assert.ok(hardwareRow);
  const quantityChanged = await buildOutputWorkbook({ ...args, overrides: [
    override('O7', 10), override(`D${hardwareRow.row}`, 40),
  ] });
  assert.ok(Math.abs(quantityChanged.getWorksheet('报价明细').getCell(freight.address).result - 10.8) < 1e-9);
  const zero = await buildOutputWorkbook({ ...args, overrides: [override('O7', 0)] });
  assert.equal(zero.getWorksheet('报价明细').getCell(freight.address).result, 0);
});

test('历史手填料价保留，首次预览与重算的运费和直接成本一致', async () => {
  const args = { quote: { quote_no: 'REFERENCE-INDO', qty: 1000 }, sections: sections({
    sales: { output_unified_indonesia: true, indo_pct: 8, shipping: { scenarios: [{ name: '出厂价', is_factory: true }] } },
    molding: { material_prices: [{ name: 'ABS', model: '750SW', price: 6.5 }],
      injection: [{ name: '件', material: 'ABS', material_grade: '750SW', weight_g: 10,
        material_unit_price: 0.02, shot_price: 0.4, sets: 1 }] },
  }) };
  const base = await buildOutputWorkbook(args), ws = base.getWorksheet('报价明细');
  const recalculated = await buildOutputWorkbook({ ...args, overrides: [{ sheet_name: '报价明细',
    cell_address: 'O7', value_json: JSON.stringify(boundOverride(base, '报价明细', 'O7', 8, 'sales')) }] });
  let freight, total;
  ws.eachRow(row => {
    if (row.getCell(2).value === '印尼运费') freight = row.getCell(4);
    if (row.getCell(1).value === '直接成本合计') total = row.getCell(4);
  });
  assert.ok(Math.abs(freight.result - (10 * 1.03 * 0.02 + 0.4) * 0.08) < 1e-9);
  for (const cell of [freight, total]) {
    assert.ok(Math.abs(recalculated.getWorksheet('报价明细').getCell(cell.address).result - cell.result) < 1e-9);
  }
});
