'use strict';

const ExcelFormulas = require('../../frontend/excel-formulas');

function cellKey(sheet, address) {
  return ExcelFormulas.key(sheet, address);
}

function plainValue(cell) {
  const value = cell.value;
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'result')) return value.result ?? null;
  if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
  if (value.text != null) return value.text;
  return cell.text || null;
}

function workbookModel(workbook) {
  const cells = {};
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, cell => {
      const value = plainValue(cell);
      cells[cellKey(worksheet.name, cell.address)] = {
        v: value,
        f: cell.formula || null,
        t: typeof value === 'number' ? 'n' : 's',
      };
    }));
  }
  return { cells };
}

function editableCellKeys(workbook) {
  const model = workbookModel(workbook);
  const referenced = new Set();
  const explicit = new Set();
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, cell => {
      const value = plainValue(cell);
      if (cell.outputEditable && !cell.formula && typeof value === 'number') {
        explicit.add(cellKey(worksheet.name, cell.address));
      }
    }));
  }
  for (const [id, cell] of Object.entries(model.cells)) {
    if (!cell.f) continue;
    const [sheet] = ExcelFormulas.split(id);
    try {
      ExcelFormulas.references(cell.f, sheet).forEach(reference => referenced.add(reference));
    } catch (_) {
      // Unsupported legacy formulas stay readable but do not make their source
      // cells editable until the formula can be evaluated safely.
    }
  }
  return new Set([...explicit, ...[...referenced].filter(id => {
    const cell = model.cells[id];
    return cell && !cell.f && typeof cell.v === 'number';
  })]);
}

function normalizeOverrides(rows) {
  const result = new Map();
  for (const row of rows || []) {
    let value;
    try { value = JSON.parse(row.value_json); }
    catch (_) { continue; }
    result.set(cellKey(row.sheet_name, row.cell_address), value);
  }
  return result;
}

function overrideNumericValue(value) {
  const candidate = value && typeof value === 'object' ? value.value : value;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function applyWorkbookOverrides(workbook, rows) {
  const allowed = editableCellKeys(workbook);
  const overrides = normalizeOverrides(rows);
  const applied = new Set();
  for (const [id, value] of overrides) {
    const numericValue = overrideNumericValue(value);
    if (!allowed.has(id) || numericValue === null) continue;
    const [sheetName, address] = ExcelFormulas.split(id);
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) continue;
    const cell = worksheet.getCell(address);
    cell.value = numericValue;
    if (cell.outputCalculation && value && typeof value === 'object' && value.calculation) {
      cell.outputCalculation = { ...cell.outputCalculation, ...value.calculation, value: numericValue };
    }
    applied.add(id);
  }

  if (!applied.size) return { editable: allowed, overridden: applied };

  const model = workbookModel(workbook);
  // Legacy department sheets contain a few Excel functions that the local
  // evaluator intentionally does not implement yet.  Their saved numeric
  // result is still a valid input for downstream, supported formulas.  Mark
  // only those unparseable formulas as cached inputs so one legacy function
  // does not prevent totals and profit from following an edited source cell.
  for (const [id, cell] of Object.entries(model.cells)) {
    if (!cell.f) continue;
    try { ExcelFormulas.parse(cell.f, ExcelFormulas.split(id)[0]); }
    catch (_) { cell.external_input = true; }
  }
  // A supported expression can still be impossible to evaluate locally (for
  // example a legacy department row whose denominator is blank).  Excel keeps
  // the saved result for such a cell.  Use that saved result as the boundary
  // input, while continuing to recalculate every valid upstream formula and
  // all formulas on the visible quote-detail sheet.
  const probe = ExcelFormulas.createEvaluator(model);
  for (const [id, cell] of Object.entries(model.cells)) {
    const [sheetName] = ExcelFormulas.split(id);
    if (!cell.f || cell.external_input || sheetName === '报价明细' || typeof cell.v !== 'number') continue;
    try { probe.value(id); }
    catch (_) { cell.external_input = true; }
  }
  const evaluator = ExcelFormulas.createEvaluator(model);
  for (const [id, cell] of Object.entries(model.cells)) {
    if (!cell.f) continue;
    try {
      const result = evaluator.value(id);
      if (typeof result === 'number' && Number.isFinite(result)) {
        const [sheetName, address] = ExcelFormulas.split(id);
        workbook.getWorksheet(sheetName).getCell(address).value = { formula: cell.f, result };
      }
    } catch (_) {
      // Keep the generated cached result for unsupported legacy formulas.
      // Excel will still perform a full recalculation when the file is opened.
    }
  }
  workbook.calcProperties = { fullCalcOnLoad: true };
  return { editable: allowed, overridden: applied };
}

module.exports = {
  applyWorkbookOverrides,
  editableCellKeys,
  normalizeOverrides,
  overrideNumericValue,
  workbookModel,
};
