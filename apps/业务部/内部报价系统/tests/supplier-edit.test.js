'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Supplier = require('../frontend/supplier-material-sync');

test('补填供应商后完整清单同步更新同一物料，不重复新增', () => {
  const row = { name: '吸塑', spec: '100*73*5mm', qty: 1, unit_price_rmb: 0.14 };
  Supplier.setSupplier(row, '新供应商');
  const restored = JSON.parse(JSON.stringify(row));
  const plan = Supplier.plan({ supplier: { id: '新供应商', name: '新供应商' }, batches: [{ id: 'a', existing: [restored], items: [
    { name: '吸塑', spec: '100*73*5mm', qty: 2, unit_price_rmb: 0.16 },
  ] }] });
  assert.equal(plan.counts.updated, 1);
  assert.equal(plan.counts.added, 0);
  assert.equal(plan.batches[0].rows.length, 1);
  assert.equal(plan.batches[0].rows[0].qty, 2);
});

test('改名同时更改供应商标识，复用已知供应商标识，清空恢复未归属', () => {
  const row = { supplier_id: 'old-id', supplier_name: '旧供应商' };
  const known = { supplier_id: 'existing-id', supplier_name: '新供应商' };
  Supplier.setSupplier(row, ' 新供应商 ', [row, known]);
  assert.equal(row.supplier_id, 'EXISTING-ID');
  assert.equal(row.supplier_name, '新供应商');
  Supplier.setSupplier(row, '另一家', [row, known]);
  assert.equal(row.supplier_id, '另一家');
  Supplier.setSupplier(row, '   ');
  assert.equal(Supplier.supplierId(row), '');
  assert.equal(row.supplier_name, '');
});
