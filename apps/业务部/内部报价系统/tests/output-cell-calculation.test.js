'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { outputCellUpdate } = require('../backend/services/outputCellCalculation');
const { applyWorkbookOverrides, sourceSignatures } = require('../backend/services/outputWorkbookOverrides');
const ExcelJS = require('exceljs');

test('物料明细按用量和原币单价计算最终 HKD 金额', () => {
  const cell = { outputCalculation: {
    kind: 'unit-quantity', quantity: 1, unitPrice: 0.0096,
    currency: 'RMB', exchangeRate: 0.85, operator: 'divide',
  } };
  const update = outputCellUpdate({ calculation: { quantity: 3, unit_price: 0.02 } }, cell);
  assert.equal(update.value, 3 * 0.02 / 0.85);
  assert.deepEqual(update.storedValue, {
    value: 3 * 0.02 / 0.85,
    calculation: { quantity: 3, unitPrice: 0.02 },
  });
  assert.equal(outputCellUpdate({ calculation: { quantity: -1, unit_price: 0.02 } }, cell), null);
});

test('结构化覆盖值恢复金额与用量单价元数据', () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('报价明细');
  sheet.getCell('A1').value = 1;
  sheet.getCell('A1').outputCalculation = { kind: 'unit-quantity', quantity: 1, unitPrice: 1 };
  sheet.getCell('A2').value = { formula: 'A1*2', result: 2 };
  const state = applyWorkbookOverrides(workbook, [{
    sheet_name: '报价明细', cell_address: 'A1',
    value_json: JSON.stringify({ source_signature: sourceSignatures(workbook).get('报价明细!A1'), value: 6, calculation: { quantity: 2, unitPrice: 3 } }),
  }]);
  assert.equal(sheet.getCell('A1').value, 6);
  assert.equal(sheet.getCell('A1').outputCalculation.quantity, 2);
  assert.equal(sheet.getCell('A1').outputCalculation.unitPrice, 3);
  assert.equal(sheet.getCell('A2').result, 12);
  assert.ok(state.overridden.has('报价明细!A1'));
});
