'use strict';

const state = {
  data: null, activeSheet: 0, matches: [], matchIndex: -1, zoom: 85,
  selectedCell: null, pendingAddress: '', saving: false, cartonEditor: null, formulaEditor: null,
  unitQuantityEditor: null,
};
const searchParams = new URLSearchParams(location.search);
const quoteId = searchParams.get('id');
const verificationVersionId = searchParams.get('verification_version_id');
const embedMode = searchParams.get('embed') === '1';
const appBase = location.pathname.replace(/\/[^/]*$/, '');
const HIDDEN_PREVIEW_SHEETS = new Set(['系统报价汇总']);
if (embedMode) document.body.classList.add('output-embedded');

const element = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

async function api(path, options = {}) {
  if (path.endsWith('/output-cell') && options.body) {
    options = {...options, body: JSON.stringify({...JSON.parse(options.body), base_revision: state.data?.revision})};
  }
  const response = await fetch(`/api${path}`, {
    credentials: 'include', cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || response.statusText);
  }
  const result = await response.json();
  if (result.revision && state.data && path.endsWith('/output-cell')) state.data.revision = result.revision;
  return result;
}

function outputCellApiPath() {
  return verificationVersionId
    ? `/verifications/versions/${encodeURIComponent(verificationVersionId)}/output-cell`
    : `/quotes/${encodeURIComponent(quoteId)}/output-cell`;
}

function columnLetter(column) {
  let value = column;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cssText(style) {
  return Object.entries(style || {})
    .map(([key, value]) => `${key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}:${String(value).replace(/[;{}]/g, '')}`)
    .join(';');
}

function renderTabs() {
  const tabs = element('sheet-tabs');
  tabs.innerHTML = '';
  state.data.sheets.forEach((sheet, index) => {
    if (HIDDEN_PREVIEW_SHEETS.has(sheet.name)) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sheet-tab${index === state.activeSheet ? ' active' : ''}`;
    button.textContent = sheet.name;
    button.onclick = () => { state.activeSheet = index; state.matchIndex = -1; renderWorkbook(); };
    tabs.appendChild(button);
  });
}

function resetCellInspector() {
  element('selected-address').textContent = '--';
  const editor = element('selected-formula');
  editor.value = '点击表格中的单元格查看公式或值';
  editor.readOnly = true;
  element('save-cell').hidden = true;
  element('reset-cell').hidden = true;
  element('source-edit-cell').hidden = true;
  element('cell-edit-status').hidden = true;
  state.selectedCell = null;
  state.cartonEditor = null;
  state.formulaEditor = null;
  state.unitQuantityEditor = null;
}

const SOURCE_DEPARTMENTS = {
  sales: '业务部', engineering: '工程/业务', electronic: '电子部', molding: '啤机部',
  painting: '喷油部', assembly: '装配部', slush: '搪胶', sewing: '车缝',
};

function sourceForCell(cell) {
  const sheet = state.data?.sheets?.[state.activeSheet];
  const position = parseCellAddress(cell?.address);
  if (!position || sheet?.name !== '报价明细') return null;
  if (cell.sourceDepartment) return {dept:cell.sourceDepartment,section:cell.sourceLabel || '报价来源参数'};
  const { row, column } = position;
  if (row >= 1 && row <= 4 && column >= 3) return { dept: 'molding', section: '料价参考表' };
  if ((row === 5 || row === 6) && column >= 3) return { dept: 'molding', section: '机型价表' };
  if (row === 7) {
    if (column === 3) return { dept: 'sales', section: '报价参数 · 汇率' };
    if ([5, 7, 9].includes(column)) return { dept: 'engineering', section: '纸箱计算 · 纸箱/平卡系数' };
    if (column === 11) return { dept: 'molding', section: '统一零件报价 · 料重损耗' };
    if (column === 13) return { dept: 'assembly', section: '人工参数' };
    if (column === 15) return { dept: 'molding', section: '印尼运费参数' };
  }
  if (row >= 11 && row <= 23) return { dept: 'molding', section: '统一零件报价' };
  const rowContent = sheet.cells
    .filter(item => item.row === row)
    .map(item => String(item.value ?? ''))
    .join(' ');
  const rowLabel = String(sheet.cells.find(item => item.row === row && item.column === 2)?.value ?? '').trim();
  const freightParameterLabels = new Map([
    ['10吨车：', ['10吨车容量', 'CUFT']], ['5吨车：', ['5吨车容量', 'CUFT']],
    ["40'：", ['40柜容量', 'CUFT']], ["20'：", ['20柜容量', 'CUFT']],
    ['HK 40柜运费+吊柜费', ['HK 40柜运费+吊柜费', 'HK$']],
    ['HK 20柜运费+吊柜费', ['HK 20柜运费+吊柜费', 'HK$']],
    ['YT 40柜运费+吊柜费', ['YT 40柜运费+吊柜费', 'HK$']],
    ['YT 20柜运费+吊柜费', ['YT 20柜运费+吊柜费', 'HK$']],
    ['HK10吨运费', ['HK10吨运费', 'HK$']], ['YT10吨运费', ['YT10吨运费', 'HK$']],
    ['HK5吨运费', ['HK5吨运费', 'HK$']], ['YT5吨运费', ['YT5吨运费', 'HK$']],
  ]);
  if (column === 3 && freightParameterLabels.has(rowLabel)) {
    const [label, unit] = freightParameterLabels.get(rowLabel);
    return { dept: 'sales', section: `运费计算 · ${label}`, valueLabel: `${label}（${unit}）` };
  }
  if (column >= 14 && /纸箱|平卡|箱价|CU\.FT|产品尺寸|装箱/.test(rowContent)) {
    return { dept: 'engineering', section: '纸箱计算' };
  }
  if (/喷油工|喷油人工|油漆/.test(rowContent)) return { dept: 'painting', section: '喷油 / 油漆成本' };
  if (/装配工|组装人工|包装\/混装人工|半成品|包装/.test(rowContent)) return { dept: 'assembly', section: '装配 / 包装人工' };
  if (/电子/.test(rowContent)) return { dept: 'electronic', section: '电子成本' };
  if (/搪胶/.test(rowContent)) return { dept: 'slush', section: '搪胶成本' };
  if (/车缝|车衣|车发/.test(rowContent)) return { dept: 'sewing', section: '车缝成本' };
  if (/五金|利宝|说明书|其他外购|辅助材料|纸箱|平卡/.test(rowContent)) {
    return { dept: 'engineering', section: '工程外购 / 包装成本' };
  }
  if (/啤工|注塑|进口料价|国内料价|料重|机型/.test(rowContent)) return { dept: 'molding', section: '注塑 / 啤工成本' };
  if (/运输方案|运费|吊柜费|报价|码点|找数|汇率|利润|税/.test(rowContent)) return { dept: 'sales', section: '出货运输方案' };
  return null;
}

function sourceDepartmentForCell(cell = state.selectedCell) {
  return sourceForCell(cell)?.dept || '';
}

function numericCellValue(cell) {
  const value = cell?.rawValue ?? cell?.value;
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCalculationNumber(value, decimals = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : '0';
}

function sourceRowName(position, cells) {
  const at = (row, column) => cells.get(`${columnLetter(column)}${row}`);
  const value = item => String(item?.value ?? '').trim();
  return [value(at(position.row, 3)), value(at(position.row, 2))]
    .find(candidate => candidate && Number.isNaN(Number(candidate))) || '';
}

function sourceHeaderName(position, cells) {
  const at = (row, column) => cells.get(`${columnLetter(column)}${row}`);
  const value = item => String(item?.value ?? '').trim();
  for (let row = position.row - 1; row >= Math.max(1, position.row - 8); row -= 1) {
    const candidate = value(at(row, position.column));
    if (candidate && Number.isNaN(Number(candidate)) && !/^[一二三四五六七八九十]+、/.test(candidate)) return candidate;
  }
  return '';
}

function formulaInputLabel(cell, cells, sheetName = '') {
  if (cell.sourceLabel) return cell.sourceLabel;
  const position = parseCellAddress(cell.address);
  if (!position) return cell.address;
  const at = (row, column) => cells.get(`${columnLetter(column)}${row}`);
  const value = item => String(item?.value ?? '').trim();
  if (sheetName === '报价明细' && position.row <= 7) {
    const columnName = value(at(position.row <= 4 ? 1 : 5, position.column));
    const rowName = value(at(position.row, 2));
    return [columnName, rowName].filter(Boolean).join(' · ') || cell.address;
  }
  const rowName = sourceRowName(position, cells);
  if (sheetName === '喷油明细') {
    const processName = value(at(2, position.column)) || value(at(2, position.column - 1));
    const valueType = value(at(3, position.column));
    const fieldName = [processName, valueType].filter((part, index, parts) => part && parts.indexOf(part) === index).join(' · ');
    return [rowName, fieldName].filter(Boolean).join(' · ') || cell.address;
  }
  const header = sourceHeaderName(position, cells);
  return [rowName, header].filter(Boolean).join(' · ') || cell.address;
}

function formulaInputGroup(cell, cells, sheetName) {
  if (cell.sourceDepartment) return `${SOURCE_DEPARTMENTS[cell.sourceDepartment] || sheetName} · 报价参数`;
  const position = parseCellAddress(cell.address);
  if (!position) return `${sheetName} · 原始参数`;
  const rowName = sourceRowName(position, cells);
  return `${sheetName} · ${rowName || '原始参数'}`;
}

function formulaFieldLabel(cell, cells, sheetName) {
  if (cell.sourceLabel) return cell.sourceLabel;
  const position = parseCellAddress(cell.address);
  if (!position) return cell.address;
  if (sheetName === '喷油明细') {
    const at = (row, column) => cells.get(`${columnLetter(column)}${row}`);
    const value = item => String(item?.value ?? '').trim();
    const processName = value(at(2, position.column)) || value(at(2, position.column - 1));
    const valueType = value(at(3, position.column));
    return [processName, valueType].filter((part, index, parts) => part && parts.indexOf(part) === index).join(' · ') || cell.address;
  }
  return sourceHeaderName(position, cells) || formulaInputLabel(cell, cells, sheetName);
}

function formulaStepDescription(step) {
  const formula = String(step.formula || '').replace(/\$/g, '');
  if (/^'[^']+'![A-Z]+\d+$/.test(formula)) return '引用上一张工作表的计算结果';
  if (/^\(?SUM\(/i.test(formula)) return '汇总以上明细结果';
  if (/\*0\.7(?:0+)?$/.test(formula)) return '喷油人工 = 喷油总额 × 70%';
  if (/\*0\.3(?:0+)?$/.test(formula)) return '油漆成本 = 喷油总额 × 30%';
  if ((formula.match(/\*/g) || []).length >= 2 && formula.includes('+')) return '各工序按“数量 × 单价”计算后相加';
  if (/^[A-Z]+\d+\*[A-Z]+\d+$/.test(formula)) return '用量 × 单价';
  return '按来源公式计算';
}

function formulaWithCurrentValues(formula, cells, inputValues = new Map()) {
  return String(formula || '').replace(/\$?([A-Z]{1,3})\$?(\d+)/g, (match, column, row) => {
    const address = `${column}${row}`;
    const cell = cells.get(address);
    const value = inputValues.has(address) ? inputValues.get(address) : numericCellValue(cell);
    return Number.isFinite(value) ? formatCalculationNumber(value) : match;
  });
}

function workbookFormulaReferences(formula, defaultSheetName) {
  const references = [];
  const pattern = /(?:(?:'((?:[^']|'')+)'|([\w\u3400-\u9FFF.-]+))!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/g;
  let match;
  while ((match = pattern.exec(String(formula || '')))) {
    const hasSheet = Boolean(match[1] || match[2]);
    const previous = match.index > 0 ? formula[match.index - 1] : '';
    const next = formula[match.index + match[0].length] || '';
    if (!hasSheet && (previous === '!' || /[A-Z0-9_]/i.test(previous) || /[A-Z0-9_]/i.test(next))) continue;
    const start = parseCellAddress(match[3]);
    const end = parseCellAddress(match[4] || match[3]);
    if (!start || !end) continue;
    references.push({
      sheetName: (match[1] || match[2] || defaultSheetName).replace(/''/g, "'"),
      top: Math.min(start.row, end.row), bottom: Math.max(start.row, end.row),
      left: Math.min(start.column, end.column), right: Math.max(start.column, end.column),
    });
  }
  return references;
}

function formulaWithWorkbookValues(formula, defaultSheetName, sheetMaps, inputValues = new Map()) {
  const pattern = /(?:(?:'((?:[^']|'')+)'|([\w\u3400-\u9FFF.-]+))!)?(\$?[A-Z]{1,3}\$?\d+)/g;
  return String(formula || '').replace(pattern, (match, quotedSheet, plainSheet, address) => {
    const sheetName = (quotedSheet || plainSheet || defaultSheetName).replace(/''/g, "'");
    const cleanAddress = address.replace(/\$/g, '');
    const key = `${sheetName}!${cleanAddress}`;
    const cell = sheetMaps.get(sheetName)?.get(cleanAddress);
    const value = inputValues.has(key) ? inputValues.get(key) : numericCellValue(cell);
    return Number.isFinite(value) ? formatCalculationNumber(value) : match;
  });
}

function genericFormulaCalculationModel(cell) {
  const sheet = state.data?.sheets?.[state.activeSheet];
  if (!cell?.formula || !sheet) return null;
  const sheetMaps = new Map(state.data.sheets.map(item => [item.name, new Map(item.cells.map(sourceCell => [sourceCell.address, sourceCell]))]));
  const fields = new Map();
  const steps = [];
  const visited = new Set();
  const visit = (current, sheetName) => {
    const visitKey = `${sheetName}!${current?.address || ''}`;
    if (!current || visited.has(visitKey)) return;
    visited.add(visitKey);
    const cells = sheetMaps.get(sheetName) || new Map();
    if (!current.formula) {
      if (current.editable && Number.isFinite(Number(current.rawValue))) fields.set(visitKey, {
        group: formulaInputGroup(current, cells, sheetName),
        label: formulaFieldLabel(current, cells, sheetName), cell: current, sheetName,
      });
      return;
    }
    const references = workbookFormulaReferences(current.formula, sheetName);
    references.forEach(range => {
      const referencedCells = sheetMaps.get(range.sheetName);
      if (!referencedCells) return;
      for (let row = range.top; row <= range.bottom; row += 1) {
        for (let column = range.left; column <= range.right; column += 1) {
          visit(referencedCells.get(`${columnLetter(column)}${row}`), range.sheetName);
        }
      }
    });
    steps.push({
      address: current.address,
      sheetName,
      title: formulaInputLabel(current, cells, sheetName),
      result: numericCellValue(current),
      formula: current.formula,
      substitution: formulaWithWorkbookValues(current.formula, sheetName, sheetMaps),
    });
  };
  visit(cell, sheet.name);
  return { targetAddress: cell.address, targetCell: cell, targetSheetName: sheet.name, sheetMaps, fields: [...fields.values()].slice(0, 40), steps };
}

function unitQuantityCalculationModel(cell) {
  const calculation = cell?.calculation;
  const sheet = state.data?.sheets?.[state.activeSheet];
  if (calculation?.kind !== 'unit-quantity' || !sheet) return null;
  return {
    targetAddress: cell.address,
    targetCell: cell,
    targetSheetName: sheet.name,
    quantity: Number(calculation.quantity),
    unitPrice: Number(calculation.unitPrice),
    currency: calculation.currency || 'HKD',
    exchangeRate: Number(calculation.exchangeRate) || 1,
    operator: calculation.operator || 'none',
    quantityLabel: calculation.quantityLabel || '用量',
    unitPriceLabel: calculation.unitPriceLabel || `单价（${calculation.currency || 'HKD'}）`,
  };
}

function calculateUnitQuantity(editor, quantity, unitPrice) {
  if (editor.operator === 'divide') return quantity * unitPrice / editor.exchangeRate;
  if (editor.operator === 'multiply') return quantity * unitPrice * editor.exchangeRate;
  return quantity * unitPrice;
}

function updateUnitQuantityCalculationPreview() {
  const editor = state.unitQuantityEditor;
  if (!editor) return;
  const quantity = Number(element('unit-quantity-value')?.value);
  const unitPrice = Number(element('unit-price-value')?.value);
  const result = calculateUnitQuantity(editor, quantity, unitPrice);
  const symbol = editor.operator === 'divide' ? '÷' : editor.operator === 'multiply' ? '×' : '';
  const ratePart = editor.operator === 'none' ? '' : ` ${symbol} ${formatCalculationNumber(editor.exchangeRate)}`;
  element('unit-quantity-substitution').textContent = `${formatCalculationNumber(quantity)} × ${formatCalculationNumber(unitPrice)}${ratePart} = ${formatCalculationNumber(result)} HKD/件`;
  element('unit-quantity-result').textContent = `${formatCalculationNumber(result)} HKD/件`;
  element('source-edit-value').value = Number.isFinite(result) ? String(result) : '';
  editor.calculatedValue = result;
  updateSourceFinalAmount(result);
}

function cartonCalculationModel(cell) {
  const position = parseCellAddress(cell?.address);
  const sheet = state.data?.sheets?.[state.activeSheet];
  if (!position || sheet?.name !== '报价明细' || position.column < 2) return null;
  const panelColumn = position.column - 1;
  const cells = new Map(sheet.cells.map(item => [item.address, item]));
  const at = (row, column) => cells.get(`${columnLetter(column)}${row}`);
  const label = (row, column) => String(at(row, column)?.value ?? '').trim();
  if (label(position.row, panelColumn) !== '箱价/件') return null;
  const headerRow = sheet.cells
    .filter(item => item.column === panelColumn && item.row < position.row && /(?:外箱|主纸箱|内箱|纸箱)/.test(String(item.value || '')) && !/尺寸/.test(String(item.value || '')))
    .map(item => item.row)
    .sort((a, b) => b - a)[0];
  if (!headerRow) return null;

  const dimensionRow = headerRow + 2;
  const summaryRow = headerRow + 3;
  const unitRow = sheet.cells.find(item => item.column === panelColumn && item.row > summaryRow && label(item.row, panelColumn) === '箱价/件')?.row;
  if (!unitRow) return null;

  const lengthCell = at(dimensionRow, panelColumn + 1);
  const widthCell = at(dimensionRow, panelColumn + 2);
  const heightCell = at(dimensionRow, panelColumn + 3);
  const length = numericCellValue(lengthCell);
  const width = numericCellValue(widthCell);
  const height = numericCellValue(heightCell);
  const boxPriceCell = at(summaryRow, panelColumn + 3);
  const boxPrice = numericCellValue(boxPriceCell);
  const quantityCell = at(summaryRow, panelColumn + 4);
  const quantity = numericCellValue(quantityCell) || 1;
  const flatRows = [];
  for (let row = summaryRow + 1; row < unitRow; row += 1) {
    if (!label(row, panelColumn)) continue;
    const lengthCellForFlat = at(row, panelColumn + 1);
    const widthCellForFlat = at(row, panelColumn + 2);
    const usageCell = at(row, panelColumn + 4);
    const priceCell = at(row, panelColumn + 3);
    flatRows.push({
      name: label(row, panelColumn),
      length: numericCellValue(lengthCellForFlat),
      width: numericCellValue(widthCellForFlat),
      usage: numericCellValue(usageCell),
      price: numericCellValue(priceCell),
      formula: priceCell?.formula || '',
      fields: [
        { label: '长 L', cell: lengthCellForFlat },
        { label: '宽 W', cell: widthCellForFlat },
        { label: '用量', cell: usageCell },
      ],
    });
  }
  const flatTotal = flatRows.reduce((sum, row) => sum + row.price, 0);
  const unitCell = at(unitRow, panelColumn + 1);
  const unitPrice = numericCellValue(unitCell) || numericCellValue(cell);
  const paperRateMatch = String(boxPriceCell?.formula || '').match(/\$([A-Z]+)\$(\d+)/);
  const paperRateCell = paperRateMatch ? cells.get(`${paperRateMatch[1]}${paperRateMatch[2]}`) : null;
  const paperRate = numericCellValue(paperRateCell);
  const steps = [{
    title: '主纸箱箱价', result: boxPrice,
    formula: '（纸箱长 + 纸箱宽 + 2）×（纸箱宽 + 纸箱高 + 1）× 2 × 纸箱系数 ÷ 1000',
    substitution: `(${formatCalculationNumber(length)} + ${formatCalculationNumber(width)} + 2) × (${formatCalculationNumber(width)} + ${formatCalculationNumber(height)} + 1) × 2 × ${formatCalculationNumber(paperRate)} ÷ 1000 = ${formatCalculationNumber(boxPrice)}`,
    cellFormula: boxPriceCell?.formula || '',
  }];
  flatRows.forEach(row => steps.push({
    title: row.name, result: row.price,
    formula: '（平卡长 + 1）×（平卡宽 + 1）× 2 ÷ 1000 × 用量',
    substitution: `(${formatCalculationNumber(row.length)} + 1) × (${formatCalculationNumber(row.width)} + 1) × 2 ÷ 1000 × ${formatCalculationNumber(row.usage)} = ${formatCalculationNumber(row.price)}`,
    cellFormula: row.formula,
  }));
  steps.push({
    title: '纸箱 / 平卡（每件）', result: unitPrice,
    formula: '（主纸箱箱价 + 全部平卡费用）÷ 装箱数量',
    substitution: `(${formatCalculationNumber(boxPrice)} + ${formatCalculationNumber(flatTotal)}) ÷ ${formatCalculationNumber(quantity)} = ${formatCalculationNumber(unitPrice)}`,
    cellFormula: unitCell?.formula || '',
  });
  return {
    targetAddress: cell.address, targetCell: cell,
    fields: [
      { group: '主纸箱', label: '纸箱长 L', cell: lengthCell },
      { group: '主纸箱', label: '纸箱宽 W', cell: widthCell },
      { group: '主纸箱', label: '纸箱高 H', cell: heightCell },
      { group: '主纸箱', label: '纸箱系数', cell: paperRateCell },
      { group: '主纸箱', label: '装箱数量', cell: quantityCell },
      ...flatRows.flatMap(row => row.fields.map(field => ({ group: row.name, ...field }))),
    ].filter(field => field.cell?.address),
    formulas: {
      box: boxPriceCell?.formula || '',
      unit: unitCell?.formula || '',
      flats: flatRows.map(row => row.formula),
    },
    initial: { length, width, height, paperRate, quantity, flatRows },
    steps,
  };
}

function readCartonEditorValues() {
  return new Map([...document.querySelectorAll('.carton-source-input[data-address]')].map(input => [
    input.dataset.address,
    Number(input.value),
  ]));
}

function readFormulaEditorValues() {
  return new Map([...document.querySelectorAll('.formula-source-input[data-address]')].map(input => [
    `${input.dataset.sheet}!${input.dataset.address}`,
    Number(input.value),
  ]));
}

function updateSourceFinalAmount(value = element('source-edit-value').value) {
  const numeric = Number(value);
  element('source-edit-final-value').textContent = Number.isFinite(numeric)
    ? numeric.toLocaleString('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
    : (String(value || '').trim() || '—');
}

function updateFormulaCalculationPreview() {
  const editor = state.formulaEditor;
  if (!editor) return;
  const values = readFormulaEditorValues();
  editor.steps.forEach((step, index) => {
    const substitution = element(`formula-step-substitution-${index}`);
    if (substitution) substitution.textContent = `代入当前输入：${formulaWithWorkbookValues(step.formula, step.sheetName, editor.sheetMaps, values)}`;
  });
}

function updateCartonCalculationPreview() {
  const editor = state.cartonEditor;
  if (!editor) return;
  const values = readCartonEditorValues();
  const valueOf = field => values.get(field.cell.address);
  const [lengthField, widthField, heightField, paperRateField, quantityField] = editor.fields;
  const length = valueOf(lengthField);
  const width = valueOf(widthField);
  const height = valueOf(heightField);
  const paperRate = valueOf(paperRateField);
  const quantity = valueOf(quantityField);
  const boxPrice = (length + width + 2) * (width + height + 1) * 2 * paperRate / 1000;
  const flatGroups = new Map();
  editor.fields.slice(5).forEach(field => {
    if (!flatGroups.has(field.group)) flatGroups.set(field.group, []);
    flatGroups.get(field.group).push(field);
  });
  let flatTotal = 0;
  [...flatGroups.entries()].forEach(([group, fields], index) => {
    const flatLength = valueOf(fields[0]);
    const flatWidth = valueOf(fields[1]);
    const usage = valueOf(fields[2]);
    const price = (flatLength + 1) * (flatWidth + 1) * 2 / 1000 * usage;
    flatTotal += price;
    element(`carton-flat-result-${index}`).textContent = formatCalculationNumber(price);
    element(`carton-flat-substitution-${index}`).textContent = `(${formatCalculationNumber(flatLength)} + 1) × (${formatCalculationNumber(flatWidth)} + 1) × 2 ÷ 1000 × ${formatCalculationNumber(usage)} = ${formatCalculationNumber(price)}`;
  });
  const unitPrice = quantity > 0 ? (boxPrice + flatTotal) / quantity : 0;
  element('carton-box-result').textContent = formatCalculationNumber(boxPrice);
  element('carton-box-substitution').textContent = `(${formatCalculationNumber(length)} + ${formatCalculationNumber(width)} + 2) × (${formatCalculationNumber(width)} + ${formatCalculationNumber(height)} + 1) × 2 × ${formatCalculationNumber(paperRate)} ÷ 1000 = ${formatCalculationNumber(boxPrice)}`;
  element('carton-unit-result').textContent = formatCalculationNumber(unitPrice);
  element('carton-unit-substitution').textContent = `(${formatCalculationNumber(boxPrice)} + ${formatCalculationNumber(flatTotal)}) ÷ ${formatCalculationNumber(quantity)} = ${formatCalculationNumber(unitPrice)}`;
  element('source-edit-value').value = Number.isFinite(unitPrice) ? unitPrice.toFixed(4) : '';
  updateSourceFinalAmount();
  editor.calculatedValue = unitPrice;
}

function renderSourceCalculation(cell) {
  const container = element('source-calculation');
  const stepsElement = element('source-calculation-steps');
  const model = cartonCalculationModel(cell);
  state.cartonEditor = model;
  state.unitQuantityEditor = model ? null : unitQuantityCalculationModel(cell);
  state.formulaEditor = (model || state.unitQuantityEditor) ? null : genericFormulaCalculationModel(cell);
  container.hidden = !model && !state.unitQuantityEditor && !state.formulaEditor;
  if (!model && !state.unitQuantityEditor && !state.formulaEditor) { stepsElement.innerHTML = ''; return; }
  if (state.unitQuantityEditor) {
    const editor = state.unitQuantityEditor;
    const conversion = editor.operator === 'divide'
      ? `人民币单价 ÷ 汇率 ${formatCalculationNumber(editor.exchangeRate)}`
      : editor.operator === 'multiply'
        ? `${editor.currency} 单价 × 汇率 ${formatCalculationNumber(editor.exchangeRate)}`
        : '单价直接以 HKD 计算';
    stepsElement.innerHTML = `
      <fieldset class="carton-input-group unit-quantity-group">
        <legend>计算参数</legend>
        <div class="formula-input-grid">
          <label class="formula-input-card">
            <span class="formula-input-name">${escapeHtml(editor.quantityLabel)}</span>
            <small class="formula-input-origin">该物料每件产品的使用数量</small>
            <input id="unit-quantity-value" type="number" step="any" min="0" value="${escapeHtml(editor.quantity)}" />
          </label>
          <label class="formula-input-card">
            <span class="formula-input-name">${escapeHtml(editor.unitPriceLabel)}</span>
            <small class="formula-input-origin">该物料原币单价</small>
            <input id="unit-price-value" type="number" step="any" min="0" value="${escapeHtml(editor.unitPrice)}" />
          </label>
        </div>
      </fieldset>
      <div class="calculation-divider">实时计算</div>
      <div class="calculation-step">
        <div class="calculation-step-heading"><span>用量 × 换算后单价</span><span id="unit-quantity-result" class="calculation-step-result"></span></div>
        <div class="calculation-step-description">${escapeHtml(conversion)}<small>结果单位：HKD/件</small></div>
        <div id="unit-quantity-substitution" class="calculation-step-substitution"></div>
      </div>`;
    element('unit-quantity-value').addEventListener('input', updateUnitQuantityCalculationPreview);
    element('unit-price-value').addEventListener('input', updateUnitQuantityCalculationPreview);
    updateUnitQuantityCalculationPreview();
    return;
  }
  if (!model) {
    const formulaModel = state.formulaEditor;
    const inputGroups = [...new Set(formulaModel.fields.map(field => field.group))];
    const inputs = formulaModel.fields.length ? inputGroups.map(group => `
      <fieldset class="carton-input-group formula-input-group">
        <legend><span>${escapeHtml(group)}</span><small>原始参数</small></legend>
        <div class="formula-input-grid">
          ${formulaModel.fields.filter(field => field.group === group).map(field => `
            <label class="formula-input-card">
              <span class="formula-input-name">${escapeHtml(field.label)}</span>
              <small class="formula-input-origin">来源：${escapeHtml(field.sheetName)}!${escapeHtml(field.cell.address)}</small>
              <input class="formula-source-input" type="number" step="any" data-sheet="${escapeHtml(field.sheetName)}" data-address="${escapeHtml(field.cell.address)}" value="${escapeHtml(numericCellValue(field.cell))}" />
            </label>
          `).join('')}
        </div>
      </fieldset>`).join('') : '<div class="calculation-note">该公式没有可直接修改的原始数值格。</div>';
    stepsElement.innerHTML = `${inputs}<div class="calculation-divider">计算过程</div>${formulaModel.steps.map((step, index) => `
      <div class="calculation-step">
        <div class="calculation-step-heading"><span><b>${index + 1}</b>${escapeHtml(step.title)}</span><span class="calculation-step-result">${escapeHtml(formatCalculationNumber(step.result))}</span></div>
        <div class="calculation-step-description">${escapeHtml(formulaStepDescription(step))}<small>${escapeHtml(step.sheetName)}!${escapeHtml(step.address)}</small></div>
        <details class="calculation-step-details">
          <summary>查看原公式与代入值</summary>
          <div class="calculation-step-formula">=${escapeHtml(step.formula)}</div>
          <div id="formula-step-substitution-${index}" class="calculation-step-substitution">代入当前输入：${escapeHtml(step.substitution)}</div>
        </details>
      </div>
    `).join('')}`;
    document.querySelectorAll('.formula-source-input').forEach(input => input.addEventListener('input', updateFormulaCalculationPreview));
    return;
  }
  const groups = [...new Set(model.fields.map(field => field.group))];
  const fieldsHtml = groups.map(group => `
    <fieldset class="carton-input-group">
      <legend>${escapeHtml(group)}</legend>
      <div class="carton-input-grid">
        ${model.fields.filter(field => field.group === group).map(field => `
          <label>${escapeHtml(field.label)}
            <input class="carton-source-input" type="number" step="any" min="0" data-address="${escapeHtml(field.cell.address)}" value="${escapeHtml(numericCellValue(field.cell))}" />
          </label>
        `).join('')}
      </div>
    </fieldset>
  `).join('');
  const steps = model.steps;
  stepsElement.innerHTML = `${fieldsHtml}<div class="calculation-divider">实时计算</div>${steps.map((step, index) => `
    <div class="calculation-step">
      <div class="calculation-step-heading"><span>${escapeHtml(step.title)}</span><span id="${index === 0 ? 'carton-box-result' : index === steps.length - 1 ? 'carton-unit-result' : `carton-flat-result-${index - 1}`}" class="calculation-step-result">${escapeHtml(formatCalculationNumber(step.result))}</span></div>
      <div class="calculation-step-formula">${escapeHtml(step.formula)}</div>
      <div id="${index === 0 ? 'carton-box-substitution' : index === steps.length - 1 ? 'carton-unit-substitution' : `carton-flat-substitution-${index - 1}`}" class="calculation-step-substitution">${escapeHtml(step.substitution)}</div>
      ${step.cellFormula ? `<div class="calculation-step-cell">表格公式：=${escapeHtml(step.cellFormula)}</div>` : ''}
    </div>
  `).join('')}`;
  document.querySelectorAll('.carton-source-input').forEach(input => input.addEventListener('input', updateCartonCalculationPreview));
  updateCartonCalculationPreview();
}

function openSourceEditor() {
  const cell = state.selectedCell;
  if (!cell || (!cell.editable && !cell.formula)) return;
  const source = sourceForCell(cell) || { dept: '', section: '报价明细表原始输入' };
  element('source-edit-title').textContent = `${cell.formula ? '查看计算' : '修改'} ${cell.address}`;
  element('source-edit-dept').textContent = source.dept ? `来源：${SOURCE_DEPARTMENTS[source.dept] || source.dept}` : '来源：报价明细';
  element('source-edit-section').textContent = source.section;
  element('source-value-title').textContent = source.valueLabel || '对应数值';
  element('source-edit-value').value = String(cell.rawValue ?? '');
  updateSourceFinalAmount();
  element('source-edit-help').classList.remove('error');
  renderSourceCalculation(cell);
  const readOnlyOutput = !state.data?.can_edit_output;
  const calculatedEditor = state.cartonEditor || state.unitQuantityEditor || state.formulaEditor;
  element('source-edit-value').readOnly = readOnlyOutput || Boolean(calculatedEditor);
  element('source-value-label').hidden = Boolean(state.unitQuantityEditor);
  element('source-edit-help').textContent = readOnlyOutput
    ? '当前核价明细为只读预览；这里展示该数值的来源、公式和代入结果。需要修改时请返回对应核价部门。'
    : state.unitQuantityEditor
      ? '修改用量或单价后，系统会按上方公式重算该项金额、小计、直接成本和利润。'
      : state.formulaEditor || state.cartonEditor
      ? '修改上方原始参数并保存后，系统会按计算链重新计算当前结果、小计、直接成本和利润。'
      : '“对应数值”是当前报价采用的结果。修改保存后，会重新计算小计、直接成本和利润。';
  const sourceFields = state.cartonEditor?.fields || state.formulaEditor?.fields || [];
  document.querySelectorAll('.formula-source-input,.carton-source-input,#unit-quantity-value,#unit-price-value').forEach(input => {
    const field = sourceFields.find(f => f.cell.address === input.dataset.address);
    input.disabled = readOnlyOutput || (field ? !field.cell.editable : !cell.editable);
  });
  element('source-reset-cell').hidden = readOnlyOutput || (!cell.overridden && !sourceFields.some(field => field.cell.overridden));
  element('source-save-cell').hidden = readOnlyOutput || (calculatedEditor && !state.unitQuantityEditor && !sourceFields.some(f=>f.cell.editable));
  const dialog = element('source-edit-dialog');
  dialog.classList.toggle('source-edit-dialog-expanded', Boolean(calculatedEditor));
  dialog.showModal();
  dialog.scrollTop = 0;
  dialog.querySelector('.source-edit-body').scrollTop = 0;
  const firstInput = state.unitQuantityEditor ? element('unit-quantity-value') : element('source-edit-value');
  firstInput.focus({ preventScroll: true });
  firstInput.select();
}

function parseCellAddress(address) {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(String(address || ''));
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}

function formulaReferences(formula) {
  const references = [];
  const pattern = /(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/g;
  let match;
  while ((match = pattern.exec(String(formula || '')))) {
    const previous = match.index > 0 ? formula[match.index - 1] : '';
    const next = formula[match.index + match[0].length] || '';
    if (previous === '!' || /[A-Z0-9_]/i.test(previous) || /[A-Z0-9_]/i.test(next)) continue;
    const start = parseCellAddress(match[1]);
    const end = parseCellAddress(match[2] || match[1]);
    if (start && end) references.push({
      top: Math.min(start.row, end.row),
      bottom: Math.max(start.row, end.row),
      left: Math.min(start.column, end.column),
      right: Math.max(start.column, end.column),
    });
  }
  return references;
}

function highlightFormulaReferences(formula) {
  document.querySelectorAll('#sheet-canvas td.cell-reference').forEach(cell => cell.classList.remove('cell-reference'));
  formulaReferences(formula).forEach(range => {
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let column = range.left; column <= range.right; column += 1) {
        const address = `${columnLetter(column)}${row}`;
        document.querySelector(`#sheet-canvas td[data-address="${address}"]`)?.classList.add('cell-reference');
      }
    }
  });
}

function showCellInspector(target, cell) {
  document.querySelectorAll('#sheet-canvas td.cell-selected').forEach(selected => selected.classList.remove('cell-selected'));
  target.classList.add('cell-selected');
  element('selected-address').textContent = cell.address;
  const hasStructuredCalculation = cell.calculation?.kind === 'unit-quantity';
  const canEdit = Boolean(state.data.can_edit_output && cell.editable && !cell.formula && !hasStructuredCalculation);
  const canOpenSource = Boolean((state.data.can_edit_output && cell.editable) || cell.formula);
  const editor = element('selected-formula');
  editor.readOnly = !canEdit;
  editor.value = canEdit ? String(cell.rawValue ?? '')
    : cell.formula ? `=${cell.formula}` : `值：${cell.value || '（空白）'}`;
  element('save-cell').hidden = !canEdit;
  element('reset-cell').hidden = !canEdit || !cell.overridden;
  const source = sourceForCell(cell);
  element('source-edit-cell').hidden = !canOpenSource;
  element('source-edit-cell').textContent = cell.formula
    ? (state.data.can_edit_output ? '计算与参数' : '查看计算')
    : hasStructuredCalculation
      ? '用量与单价'
    : canEdit
      ? '修改来源参数'
      : source ? `来源：${SOURCE_DEPARTMENTS[source.dept] || source.dept}` : '查看来源';
  const status = element('cell-edit-status');
  status.hidden = !canEdit && !hasStructuredCalculation;
  status.className = 'cell-edit-status';
  status.textContent = hasStructuredCalculation
    ? `打开“修改用量与单价”后，系统会自动计算 ${cell.address} 及相关小计和利润。`
    : canEdit
    ? `修改 ${cell.address} 后按 Enter 或点击“保存并联动”，相关公式、小计和利润会重新计算。`
    : '';
  state.selectedCell = cell;
  highlightFormulaReferences(cell.formula);
}

function renderSheet() {
  const sheet = state.data.sheets[state.activeSheet];
  const shell = element('sheet-canvas');
  const frozenRows = sheet.name === '报价明细' ? Math.min(7, sheet.rowCount) : 0;
  let frozenTop = 28;
  const cellMap = new Map(sheet.cells.map(cell => [`${cell.row}:${cell.column}`, cell]));
  const addressMap = new Map(sheet.cells.map(cell => [cell.address, cell]));
  const covered = new Set();
  sheet.cells.forEach(cell => {
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let column = cell.column; column < cell.column + cell.columnSpan; column += 1) {
        if (row !== cell.row || column !== cell.column) covered.add(`${row}:${column}`);
      }
    }
  });

  let html = '<table class="preview-table"><colgroup><col style="width:48px">';
  sheet.columns.forEach(width => { html += `<col style="width:${width}px">`; });
  html += '</colgroup><thead><tr><th class="row-number"></th>';
  for (let column = 1; column <= sheet.columnCount; column += 1) html += `<th>${columnLetter(column)}</th>`;
  html += '</tr></thead><tbody>';
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    const isFrozen = row <= frozenRows;
    const frozenClass = isFrozen ? ` frozen-row${row === frozenRows ? ' frozen-row-last' : ''}` : '';
    const frozenStyle = isFrozen ? `;--freeze-top:${frozenTop}px` : '';
    html += `<tr class="${frozenClass.trim()}" style="height:${sheet.rows[row - 1]}px${frozenStyle}"><th class="row-number">${row}</th>`;
    for (let column = 1; column <= sheet.columnCount; column += 1) {
      const key = `${row}:${column}`;
      if (covered.has(key)) continue;
      const cell = cellMap.get(key);
      if (!cell) { html += `<td data-address="${columnLetter(column)}${row}"></td>`; continue; }
      const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';
      const colSpan = cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : '';
      const editable = Boolean(state.data.can_edit_output && cell.editable && !cell.formula);
      const className = `${editable ? 'cell-editable' : ''}${cell.overridden ? ' cell-overridden' : ''}`.trim();
      const titleText = cell.formula ? `公式：${cell.formula}`
        : cell.calculation?.kind === 'unit-quantity' ? '双击修改用量与单价'
          : editable ? '双击或在上方公式栏修改数值' : '';
      const title = titleText ? ` title="${escapeHtml(titleText)}"` : '';
      const classAttr = className ? ` class="${className}"` : '';
      html += `<td data-address="${cell.address}"${classAttr} style="${cssText(cell.style)}"${rowSpan}${colSpan}${title}>${escapeHtml(cell.value)}</td>`;
    }
    html += '</tr>';
    if (isFrozen) frozenTop += sheet.rows[row - 1];
  }
  html += '</tbody></table>';
  shell.innerHTML = html;
  resetCellInspector();
  shell.onclick = event => {
    const target = event.target.closest('td[data-address]');
    if (!target || !shell.contains(target)) return;
    const cell = addressMap.get(target.dataset.address);
    if (cell) showCellInspector(target, cell);
  };
  shell.ondblclick = event => {
    const target = event.target.closest('td[data-address]');
    if (!target || !shell.contains(target)) return;
    const cell = addressMap.get(target.dataset.address);
    if (!cell) return;
    showCellInspector(target, cell);
    if (state.data.can_edit_output && (cell.editable || cell.formula)) openSourceEditor();
  };
  shell.style.zoom = `${state.zoom}%`;
  shell.hidden = false;
  element('sheet-loading').hidden = true;
  element('sheet-status').textContent = `${sheet.name} · ${sheet.rowCount} 行 × ${sheet.columnCount} 列${sheet.truncated ? ' · 预览已截取，下载文件仍保留完整内容' : ''}`;
  if (state.pendingAddress) {
    const pending = state.pendingAddress;
    state.pendingAddress = '';
    const target = shell.querySelector(`td[data-address="${pending}"]`);
    const cell = addressMap.get(pending);
    if (target && cell) {
      showCellInspector(target, cell);
      target.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }
}

function applySearch(move = 0) {
  const query = element('sheet-search').value.trim().toLowerCase();
  document.querySelectorAll('.search-match,.search-current').forEach(cell => cell.classList.remove('search-match', 'search-current'));
  if (!query) { state.matches = []; state.matchIndex = -1; return; }
  state.matches = [...document.querySelectorAll('#sheet-canvas td[data-address]')]
    .filter(cell => cell.textContent.toLowerCase().includes(query));
  state.matches.forEach(cell => cell.classList.add('search-match'));
  if (!state.matches.length) { element('sheet-status').textContent = '当前工作表没有匹配结果'; return; }
  if (move || state.matchIndex < 0) state.matchIndex = (state.matchIndex + move + state.matches.length) % state.matches.length;
  const current = state.matches[state.matchIndex];
  current.classList.add('search-current');
  current.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  element('sheet-status').textContent = `查找结果 ${state.matchIndex + 1} / ${state.matches.length} · ${current.dataset.address}`;
}

function renderWorkbook() {
  renderTabs();
  renderSheet();
  applySearch();
}

function showEditStatus(message, error = false) {
  const status = element('cell-edit-status');
  status.hidden = false;
  status.className = `cell-edit-status${error ? ' error' : ''}`;
  status.textContent = message;
}

async function saveSelectedCell() {
  const cell = state.selectedCell;
  if (!cell || !state.data?.can_edit_output || !cell.editable || cell.formula || state.saving) return false;
  const raw = element('selected-formula').value.trim();
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value)) {
    showEditStatus('请输入有效数值。', true);
    element('selected-formula').focus();
    return false;
  }
  state.saving = true;
  element('save-cell').disabled = true;
  element('reset-cell').disabled = true;
  showEditStatus('正在保存并重新计算相关公式…');
  try {
    await api(outputCellApiPath(), {
      method: 'PUT',
      body: JSON.stringify({
        sheet_name: state.data.sheets[state.activeSheet].name,
        cell_address: cell.address,
        value,
        source_dept: sourceDepartmentForCell(cell),
      }),
    });
    state.pendingAddress = cell.address;
    await loadOutput();
    showEditStatus(`已保存 ${cell.address}，相关公式和汇总已重算；对应来源部门已转为待重新审核。`);
    return true;
  } catch (error) {
    showEditStatus(error.message, true);
    return false;
  } finally {
    state.saving = false;
    element('save-cell').disabled = false;
    element('reset-cell').disabled = false;
  }
}

async function resetSelectedCell() {
  const cell = state.selectedCell;
  if (!cell || !cell.overridden || state.saving) return false;
  state.saving = true;
  element('save-cell').disabled = true;
  element('reset-cell').disabled = true;
  showEditStatus('正在恢复原值并重新计算…');
  try {
    await api(outputCellApiPath(), {
      method: 'DELETE',
      body: JSON.stringify({
        sheet_name: state.data.sheets[state.activeSheet].name,
        cell_address: cell.address,
        source_dept: sourceDepartmentForCell(cell),
      }),
    });
    state.pendingAddress = cell.address;
    await loadOutput();
    showEditStatus(`已恢复 ${cell.address} 的原值，相关公式和汇总已重算；对应来源部门已转为待重新审核。`);
    return true;
  } catch (error) {
    showEditStatus(error.message, true);
    return false;
  } finally {
    state.saving = false;
    element('save-cell').disabled = false;
    element('reset-cell').disabled = false;
  }
}

async function saveSourceEditor() {
  const editor = state.cartonEditor;
  const unitEditor = state.unitQuantityEditor;
  const formulaEditor = state.formulaEditor;
  if (!editor && !unitEditor && !formulaEditor) {
    element('selected-formula').value = element('source-edit-value').value;
    if (await saveSelectedCell()) element('source-edit-dialog').close();
    return;
  }
  if (state.saving) return;
  if (unitEditor) {
    const quantity = Number(element('unit-quantity-value').value);
    const unitPrice = Number(element('unit-price-value').value);
    const value = calculateUnitQuantity(unitEditor, quantity, unitPrice);
    if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(value)) {
      element('source-edit-help').textContent = '请输入有效的非负用量和单价。';
      element('source-edit-help').classList.add('error');
      return;
    }
    state.saving = true;
    element('source-save-cell').disabled = true;
    element('source-reset-cell').disabled = true;
    element('source-edit-help').classList.remove('error');
    element('source-edit-help').textContent = '正在按用量和单价重新计算该项成本…';
    try {
      await api(outputCellApiPath(), {
        method: 'PUT',
        body: JSON.stringify({
          sheet_name: unitEditor.targetSheetName,
          cell_address: unitEditor.targetAddress,
          calculation: { quantity, unit_price: unitPrice },
          source_dept: sourceDepartmentForCell(unitEditor.targetCell),
        }),
      });
      state.pendingAddress = unitEditor.targetAddress;
      element('source-edit-dialog').close();
      await loadOutput();
      showEditStatus('用量和单价已保存，该项金额及后续小计、成本和利润已重新计算。');
    } catch (error) {
      element('source-edit-help').textContent = error.message;
      element('source-edit-help').classList.add('error');
    } finally {
      state.saving = false;
      element('source-save-cell').disabled = false;
      element('source-reset-cell').disabled = false;
    }
    return;
  }
  const values = editor ? readCartonEditorValues() : readFormulaEditorValues();
  const activeEditor = editor || formulaEditor;
  const activeSheetName = state.data.sheets[state.activeSheet].name;
  const sourceDepartment = sourceDepartmentForCell(activeEditor.targetCell || state.selectedCell);
  const updates = activeEditor.fields.filter(field=>field.cell.editable).map(field => ({
    sheetName: field.sheetName || activeSheetName,
    address: field.cell.address,
    value: values.get(editor ? field.cell.address : `${field.sheetName}!${field.cell.address}`),
  }));
  const invalid = updates.find(update => !Number.isFinite(update.value) || update.value < 0);
  const quantityAddress = editor?.fields[4]?.cell?.address;
  const quantity = editor ? values.get(quantityAddress) : 1;
  if (invalid || !(quantity > 0) || (editor && !Number.isFinite(editor.calculatedValue))) {
    element('source-edit-help').textContent = invalid ? '请输入有效的非负数值。' : '装箱数量必须大于 0。';
    element('source-edit-help').classList.add('error');
    return;
  }
  if (editor && activeEditor.targetCell?.editable !== false) {
    updates.push({ sheetName: activeSheetName, address: editor.targetAddress, value: Number(editor.calculatedValue.toFixed(8)) });
  }
  state.saving = true;
  element('source-save-cell').disabled = true;
  element('source-reset-cell').disabled = true;
  element('source-edit-help').classList.remove('error');
  element('source-edit-help').textContent = '正在保存纸箱参数并重新计算相关成本与利润…';
  try {
    await api(outputCellApiPath(), {
      method: 'PUT',
      body: JSON.stringify({ updates: updates.map(update => ({
        sheet_name: update.sheetName, cell_address: update.address, value: update.value,
      })) }),
    });
    state.pendingAddress = activeEditor.targetAddress;
    element('source-edit-dialog').close();
    await loadOutput();
    showEditStatus(editor
      ? '纸箱参数已保存并重算；工程/业务部门已转为待重新审核。'
      : '原始计算参数已保存并重算；对应来源部门已转为待重新审核。');
  } catch (error) {
    element('source-edit-help').textContent = error.message;
    element('source-edit-help').classList.add('error');
  } finally {
    state.saving = false;
    element('source-save-cell').disabled = false;
    element('source-reset-cell').disabled = false;
  }
}

async function resetSourceEditor() {
  const editor = state.cartonEditor;
  const unitEditor = state.unitQuantityEditor;
  const formulaEditor = state.formulaEditor;
  if (!editor && !unitEditor && !formulaEditor) {
    if (await resetSelectedCell()) element('source-edit-dialog').close();
    return;
  }
  if (state.saving) return;
  const activeEditor = editor || unitEditor || formulaEditor;
  const activeSheetName = state.data.sheets[state.activeSheet].name;
  const sourceDepartment = sourceDepartmentForCell(activeEditor.targetCell || state.selectedCell);
  const targets = unitEditor ? [{ sheetName: activeSheetName, address: unitEditor.targetAddress }] : [
    ...activeEditor.fields.map(field => ({ sheetName: field.sheetName || activeSheetName, address: field.cell.address })),
    ...(editor && state.selectedCell?.editable ? [{ sheetName: activeSheetName, address: editor.targetAddress }] : []),
  ];
  const uniqueTargets = [...new Map(targets.map(target => [`${target.sheetName}!${target.address}`, target])).values()];
  state.saving = true;
  element('source-save-cell').disabled = true;
  element('source-reset-cell').disabled = true;
  element('source-edit-help').classList.remove('error');
  element('source-edit-help').textContent = unitEditor ? '正在恢复原始用量和单价并重新计算…' : '正在恢复原始参数并重新计算…';
  try {
    await api(outputCellApiPath(), {
      method: 'DELETE',
      body: JSON.stringify({updates: uniqueTargets.map(target => ({sheet_name:target.sheetName,cell_address:target.address}))}),
    });
    state.pendingAddress = activeEditor.targetAddress;
    element('source-edit-dialog').close();
    await loadOutput();
    showEditStatus(unitEditor
      ? '原始用量和单价已恢复，该项金额及后续汇总已重算。'
      : editor
      ? '纸箱参数已恢复并重算；工程/业务部门已转为待重新审核。'
      : '原始计算参数已恢复并重算；对应来源部门已转为待重新审核。');
  } catch (error) {
    element('source-edit-help').textContent = error.message;
    element('source-edit-help').classList.add('error');
  } finally {
    state.saving = false;
    element('source-save-cell').disabled = false;
    element('source-reset-cell').disabled = false;
  }
}

async function loadOutput() {
  element('sheet-loading').hidden = false;
  element('sheet-loading').textContent = '正在生成报价表格…';
  element('sheet-canvas').hidden = true;
  try {
    const layoutPath = verificationVersionId
      ? `/verifications/versions/${encodeURIComponent(verificationVersionId)}/output-layout`
      : `/quotes/${encodeURIComponent(quoteId)}/output-layout`;
    const [me, data] = await Promise.all([api('/auth/me'), api(layoutPath)]);
    state.data = data;
    const quote = data.quote;
    element('output-user').textContent = `${me.active_factory_name || me.active_factory_code || ''} · ${me.dept_name || ''}`;
    element('back-link').href = verificationVersionId
      ? `./verification.html?quote_id=${encodeURIComponent(quote.id)}`
      : `./quote.html?id=${encodeURIComponent(quoteId)}`;
    element('output-eyebrow').textContent = verificationVersionId ? '核价版本明细表' : '整单报价表';
    element('output-title').textContent = verificationVersionId ? '核价汇总与输出' : '汇总与输出';
    element('workbook-title').textContent = verificationVersionId ? '核价表格' : '报价表格';
    element('workbook-description').textContent = verificationVersionId
      ? '当前表格取自所选核价版本，并与最终核价导出 Excel 使用同一份数据和版式。'
      : '当前表格与最终导出 Excel 使用同一份数据和版式。';
    element('quote-meta').textContent = [quote.quote_no, quote.product_name, quote.customer, quote.version].filter(Boolean).join(' · ');
    element('completion-card').innerHTML = data.can_export
      ? '<strong>整单资料已审核</strong><br>可以下载最终 Excel'
      : `<strong>整单资料待补齐</strong><br>审核 ${data.approved_count} / ${data.total_departments}`;
    const download = element('download-button');
    download.href = verificationVersionId
      ? `${appBase}/api/verifications/versions/${encodeURIComponent(verificationVersionId)}/export`
      : `${appBase}/api/quotes/${encodeURIComponent(quoteId)}/output-export`;
    download.classList.toggle('disabled', !data.can_export);
    download.setAttribute('aria-disabled', data.can_export ? 'false' : 'true');
    element('output-notice').className = `notice${data.can_export ? '' : ' warning'}`;
    element('output-notice').textContent = verificationVersionId
      ? data.can_edit_output
        ? '蓝色角标单元格可修改；点击选中后可直接输入，或打开“修改来源参数”。保存后当前核价版本的公式、小计和利润会同步重算。'
        : data.can_export
          ? '当前核价版本已全部审核并锁定；点击公式单元格可查看计算过程。'
          : '当前账号没有所选部分的编辑权限，可点击公式单元格查看计算过程。'
      : data.can_edit_output
      ? '原始数值可直接修改；公式结果可点击“查看计算 / 修改参数”追溯原部门输入。保存后小计、合计和利润会同步重算。'
      : data.can_export
        ? '当前表格只读；需要修改时，请返回对应部门填写。下载文件保留全部工作表。'
        : '部分部门尚未审核；当前可预览，全部审核后才可下载最终 Excel。';
    if (data.output_notice) element('output-notice').textContent = data.output_notice;
    const stale = data.output_conflicts || [];
    element('clear-stale-output').hidden = !stale.length || !data.can_reset_conflicts;
    if (stale.length) {
      element('output-notice').className = 'notice error';
      element('output-notice').textContent = `来源资料已改变，${stale.length} 项旧修正未套用。请记录并清除失效修正后重新核对；处理前不可导出。`;
    }
    const visibleSheets = data.sheets
      .map((sheet, index) => ({ sheet, index }))
      .filter(({ sheet }) => !HIDDEN_PREVIEW_SHEETS.has(sheet.name));
    if (!visibleSheets.length) throw new Error('当前报价没有可显示的工作表');
    if (!data.sheets[state.activeSheet] || HIDDEN_PREVIEW_SHEETS.has(data.sheets[state.activeSheet].name)) {
      state.activeSheet = visibleSheets[0].index;
    }
    renderWorkbook();
  } catch (error) {
    element('sheet-loading').hidden = false;
    element('sheet-loading').innerHTML = `报价内容加载失败：${escapeHtml(error.message)}<br><button type="button" id="retry-inline" style="margin-top:18px">重新加载</button>`;
    element('output-notice').className = 'notice error';
    element('output-notice').textContent = '未能读取报价表格，请确认本地服务已启动且当前账号有权查看该报价。';
    element('retry-inline')?.addEventListener('click', loadOutput);
  }
}

element('clear-stale-output').onclick = async () => {
  if (state.saving || !state.data?.can_reset_conflicts) return;
  if (!window.confirm('清除失效的输出修正并使用当前部门资料？原部门资料会保留。')) return;
  state.saving = true;
  element('clear-stale-output').disabled = true;
  try {
    await api(outputCellApiPath(), {method:'DELETE',body:JSON.stringify({updates:state.data.output_conflicts})});
    await loadOutput();
    showEditStatus('失效修正已清除，请按当前资料重新核对。');
  } catch (error) { showEditStatus(error.message, true); }
  finally { state.saving = false; element('clear-stale-output').disabled = false; }
};

element('reload-button').onclick = loadOutput;
element('save-cell').onclick = saveSelectedCell;
element('reset-cell').onclick = resetSelectedCell;
element('source-edit-cell').onclick = openSourceEditor;
element('source-edit-close').onclick = () => element('source-edit-dialog').close();
element('source-save-cell').onclick = saveSourceEditor;
element('source-reset-cell').onclick = resetSourceEditor;
element('source-edit-value').oninput = () => updateSourceFinalAmount();
element('source-edit-value').onkeydown = event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    element('source-save-cell').click();
  }
};
element('selected-formula').onkeydown = event => {
  if (event.key === 'Enter' && !event.currentTarget.readOnly) {
    event.preventDefault();
    saveSelectedCell();
  }
  if (event.key === 'Escape' && state.selectedCell) {
    event.currentTarget.value = String(state.selectedCell.rawValue ?? '');
    event.currentTarget.blur();
  }
};
element('sheet-search').oninput = () => { state.matchIndex = -1; applySearch(); };
element('search-prev').onclick = () => applySearch(-1);
element('search-next').onclick = () => applySearch(1);
element('sheet-zoom').onchange = event => {
  state.zoom = Number(event.target.value) || 85;
  element('sheet-canvas').style.zoom = `${state.zoom}%`;
};

if (!quoteId && !verificationVersionId) {
  element('sheet-loading').textContent = '缺少报价单或核价版本编号，请从对应详情页进入。';
} else {
  loadOutput();
}
