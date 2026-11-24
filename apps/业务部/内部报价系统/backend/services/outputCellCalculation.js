'use strict';

const validInput = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));

function calculatedValue(calculation) {
  const quantity = Number(calculation.quantity);
  const unitPrice = Number(calculation.unitPrice);
  const exchangeRate = Number(calculation.exchangeRate);
  if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return null;
  if (calculation.operator === 'divide') {
    if (!(exchangeRate > 0)) return null;
    return quantity * unitPrice / exchangeRate;
  }
  if (calculation.operator === 'multiply') {
    if (!(exchangeRate > 0)) return null;
    return quantity * unitPrice * exchangeRate;
  }
  return quantity * unitPrice;
}

function outputCellUpdate(body, cell) {
  const original = cell?.outputCalculation;
  if (body?.calculation && original?.kind === 'unit-quantity') {
    if (!validInput(body.calculation.quantity) || !validInput(body.calculation.unit_price ?? body.calculation.unitPrice)) return null;
    const calculation = {
      ...original,
      quantity: Number(body.calculation.quantity),
      unitPrice: Number(body.calculation.unit_price ?? body.calculation.unitPrice),
    };
    const value = calculatedValue(calculation);
    if (value === null || !Number.isFinite(value)) return null;
    return {
      value,
      storedValue: {
        value,
        calculation: { quantity: calculation.quantity, unitPrice: calculation.unitPrice },
      },
      calculation,
    };
  }
  if (!validInput(body?.value)) return null;
  const value = Number(body.value);
  return Number.isFinite(value) && value >= 0 ? { value, storedValue: value, calculation: null } : null;
}

module.exports = { calculatedValue, outputCellUpdate };
