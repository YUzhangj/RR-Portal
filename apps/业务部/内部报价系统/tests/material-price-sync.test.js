const test = require('node:test');
const assert = require('node:assert/strict');
const { applyMaterialPrices, completedBeforeEffective } = require('../backend/services/materialPriceSync');

test('global material prices replace the quote copy and recalculate matching injection rows', () => {
  const payload = {
    material_prices: [{ name: 'ABS', model: '750SW', price: 7 }],
    injection: [
      { material: 'ABS', material_grade: '750SW', material_unit_price: 7 / 454 },
      { material: 'POM', material_grade: 'UNKNOWN', material_unit_price: 0.2 },
    ],
  };
  const prices = [{ name: 'ABS', model: '750SW', price: 8.5 }];
  const result = applyMaterialPrices(payload, prices);
  assert.equal(result.referenceChanged, true);
  assert.equal(result.injectionRowsChanged, 1);
  assert.equal(result.payload.injection[0].material_unit_price, +(8.5 / 454).toFixed(5));
  assert.equal(result.payload.injection[1].material_unit_price, 0.2);
});

test('approved history before the effective time and all exported snapshots are preserved', () => {
  const effectiveAt = '2026-08-19T08:00:00.000Z';
  assert.equal(completedBeforeEffective({
    quote_status: 'fully_approved', fully_approved_at: '2026-08-19 07:59:59',
  }, effectiveAt), true);
  assert.equal(completedBeforeEffective({
    quote_status: 'fully_approved', fully_approved_at: '2026-08-19 08:00:01',
  }, effectiveAt), false);
  assert.equal(completedBeforeEffective({
    quote_status: 'drafting', fully_approved_at: '2026-08-18 00:00:00',
  }, effectiveAt), false);
  assert.equal(completedBeforeEffective({
    quote_status: 'exported', fully_approved_at: '2026-08-20 00:00:00',
  }, effectiveAt), true);
});
