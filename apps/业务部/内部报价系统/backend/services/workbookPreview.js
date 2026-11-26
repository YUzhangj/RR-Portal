'use strict';

const DEFAULT_LIMITS = { maxRows: 500, maxColumns: 120 };

function columnLetter(column) {
  let value = Number(column) || 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function parseCellAddress(address) {
  const match = /^([A-Z]+)(\d+)$/i.exec(String(address || ''));
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}

function parseRange(range) {
  const [from, to = from] = String(range || '').split(':');
  const start = parseCellAddress(from);
  const end = parseCellAddress(to);
  if (!start || !end) return null;
  return {
    top: Math.min(start.row, end.row),
    left: Math.min(start.column, end.column),
    bottom: Math.max(start.row, end.row),
    right: Math.max(start.column, end.column),
  };
}

function argbToCss(color) {
  if (!color) return '';
  if (color.argb) {
    const argb = String(color.argb).replace(/^#/, '');
    return `#${argb.length === 8 ? argb.slice(2) : argb}`;
  }
  if (color.indexed === 64) return '';
  return '';
}

function borderCss(border) {
  if (!border || !border.style) return '';
  const width = border.style === 'thin' || border.style === 'hair' ? 1
    : border.style === 'medium' ? 2 : 3;
  const style = border.style === 'dashed' || border.style === 'dashDot' ? 'dashed'
    : border.style === 'dotted' ? 'dotted' : 'solid';
  return `${width}px ${style} ${argbToCss(border.color) || '#94a3b8'}`;
}

function cellStyle(cell) {
  const font = cell.font || {};
  const alignment = cell.alignment || {};
  const fill = cell.fill || {};
  const border = cell.border || {};
  const style = {};
  const fontColor = argbToCss(font.color);
  if (fontColor) style.color = fontColor;
  if (font.name) style.fontFamily = font.name;
  if (font.size) style.fontSize = `${font.size}px`;
  if (font.bold) style.fontWeight = '700';
  if (font.italic) style.fontStyle = 'italic';
  if (font.underline) style.textDecoration = 'underline';
  if (alignment.horizontal) style.textAlign = alignment.horizontal === 'centerContinuous' ? 'center' : alignment.horizontal;
  if (alignment.vertical) style.verticalAlign = alignment.vertical;
  if (alignment.wrapText) style.whiteSpace = 'pre-wrap';
  if (fill.type === 'pattern') {
    const background = argbToCss(fill.fgColor);
    if (background) style.backgroundColor = background;
  }
  const top = borderCss(border.top);
  const right = borderCss(border.right);
  const bottom = borderCss(border.bottom);
  const left = borderCss(border.left);
  if (top) style.borderTop = top;
  if (right) style.borderRight = right;
  if (bottom) style.borderBottom = bottom;
  if (left) style.borderLeft = left;
  return style;
}

function displayValue(cell) {
  if (cell.value == null) return '';
  if (cell.value instanceof Date) return cell.value.toISOString().slice(0, 10);
  const numericValue = typeof cell.value === 'number'
    ? cell.value
    : (typeof cell.value === 'object' && typeof cell.value.result === 'number'
      ? cell.value.result
      : (typeof cell.result === 'number' ? cell.result : null));
  const numberFormat = String(cell.numFmt || '');
  const percentagePoints = numberFormat.match(/^0(?:\.(0+))?"%"$/);
  if (numericValue != null && percentagePoints) return `${numericValue.toFixed(percentagePoints[1]?.length || 0)}%`;
  const prefixedNumber = numberFormat.match(/^"([^"]*)"0(?:\.(#+|0+))?$/);
  if (numericValue != null && prefixedNumber) {
    const decimals = prefixedNumber[2] ? prefixedNumber[2].length : 0;
    const formatted = prefixedNumber[2] && prefixedNumber[2][0] === '0'
      ? numericValue.toFixed(decimals)
      : numericValue.toFixed(decimals).replace(/\.?0+$/, '');
    return `${prefixedNumber[1]}${formatted}`;
  }
  const percentFormat = numberFormat.match(/0(?:\.(0+))?%/);
  if (numericValue != null && percentFormat) {
    const decimals = percentFormat[1] ? percentFormat[1].length : 0;
    return `${(numericValue * 100).toFixed(decimals)}%`;
  }
  const decimalFormat = !numberFormat.includes('%') && numberFormat.match(/0\.(0+)/);
  if (numericValue != null && decimalFormat) {
    return numericValue.toFixed(decimalFormat[1].length);
  }
  if (typeof cell.value === 'object') {
    if (Array.isArray(cell.value.richText)) return cell.value.richText.map(part => part.text || '').join('');
    if (cell.value.text != null) return String(cell.value.text);
    if (cell.value.result != null) return String(cell.value.result);
    if (cell.result != null) return String(cell.result);
    if (cell.text != null) return String(cell.text);
  }
  return String(cell.text != null ? cell.text : cell.value);
}

function rawValue(cell) {
  if (cell.value == null) return null;
  if (cell.value instanceof Date) return cell.value.toISOString();
  if (typeof cell.value !== 'object') return cell.value;
  if (Object.prototype.hasOwnProperty.call(cell.value, 'result')) return cell.value.result ?? null;
  if (Array.isArray(cell.value.richText)) return cell.value.richText.map(part => part.text || '').join('');
  if (cell.value.text != null) return cell.value.text;
  return cell.text || null;
}

function worksheetBounds(worksheet, merges, limits) {
  // actualRowCount/actualColumnCount are counts of populated rows and columns,
  // not the last populated indexes.  Sparse templates with deliberate spacer
  // rows would therefore be truncated before their final summary blocks.
  let lastRow = Math.max(worksheet.rowCount || 0, worksheet.actualRowCount || 0, 1);
  let lastColumn = Math.max(worksheet.columnCount || 0, worksheet.actualColumnCount || 0, 1);
  for (const merge of merges) {
    lastRow = Math.max(lastRow, merge.bottom);
    lastColumn = Math.max(lastColumn, merge.right);
  }
  return {
    rowCount: Math.min(lastRow, limits.maxRows),
    columnCount: Math.min(lastColumn, limits.maxColumns),
    truncated: lastRow > limits.maxRows || lastColumn > limits.maxColumns,
  };
}

function serializeWorksheet(worksheet, limits = DEFAULT_LIMITS) {
  const mergeRanges = Array.isArray(worksheet.model?.merges) ? worksheet.model.merges : [];
  const merges = mergeRanges.map(parseRange).filter(Boolean);
  const bounds = worksheetBounds(worksheet, merges, limits);
  const covered = new Set();
  const mergeByMaster = new Map();
  for (const merge of merges) {
    if (merge.top > bounds.rowCount || merge.left > bounds.columnCount) continue;
    const clipped = {
      ...merge,
      bottom: Math.min(merge.bottom, bounds.rowCount),
      right: Math.min(merge.right, bounds.columnCount),
    };
    mergeByMaster.set(`${clipped.top}:${clipped.left}`, clipped);
    for (let row = clipped.top; row <= clipped.bottom; row += 1) {
      for (let column = clipped.left; column <= clipped.right; column += 1) {
        if (row !== clipped.top || column !== clipped.left) covered.add(`${row}:${column}`);
      }
    }
  }

  const cells = [];
  for (let row = 1; row <= bounds.rowCount; row += 1) {
    for (let column = 1; column <= bounds.columnCount; column += 1) {
      const key = `${row}:${column}`;
      if (covered.has(key)) continue;
      const cell = worksheet.getCell(row, column);
      const merge = mergeByMaster.get(key);
      const value = displayValue(cell);
      const style = cellStyle(cell);
      if (!value && !merge && !Object.keys(style).length) continue;
      const address = `${columnLetter(column)}${row}`;
      const workbookKey = `${worksheet.name}!${address}`;
      cells.push({
        row,
        column,
        address,
        value,
        rawValue: rawValue(cell),
        formula: cell.formula || '',
        sourceDepartment: cell.outputDepartment || null,
        sourceLabel: cell.outputLabel || null,
        calculation: cell.outputCalculation ? { ...cell.outputCalculation } : null,
        editable: Boolean(limits.editableCells && limits.editableCells.has(workbookKey)),
        overridden: Boolean(limits.overriddenCells && limits.overriddenCells.has(workbookKey)),
        rowSpan: merge ? merge.bottom - merge.top + 1 : 1,
        columnSpan: merge ? merge.right - merge.left + 1 : 1,
        style,
      });
    }
  }

  const columns = [];
  for (let column = 1; column <= bounds.columnCount; column += 1) {
    const width = Number(worksheet.getColumn(column).width) || 10;
    columns.push(Math.max(34, Math.min(420, Math.round(width * 7 + 8))));
  }
  const rows = [];
  for (let row = 1; row <= bounds.rowCount; row += 1) {
    const height = Number(worksheet.getRow(row).height);
    rows.push(height ? Math.max(22, Math.round(height * 96 / 72)) : 26);
  }
  return {
    id: worksheet.id,
    name: worksheet.name,
    state: worksheet.state || 'visible',
    rowCount: bounds.rowCount,
    columnCount: bounds.columnCount,
    truncated: bounds.truncated,
    columns,
    rows,
    cells,
  };
}

function serializeWorkbook(workbook, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  return workbook.worksheets
    .filter(worksheet => worksheet.state !== 'veryHidden')
    .map(worksheet => serializeWorksheet(worksheet, limits));
}

module.exports = {
  columnLetter,
  parseRange,
  serializeWorksheet,
  serializeWorkbook,
};
