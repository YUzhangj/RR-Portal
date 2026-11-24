'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { columnLetter, parseRange, serializeWorkbook } = require('../backend/services/workbookPreview');

test('workbook preview serializes values, styles and merged ranges', () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('报价明细');
  sheet.getColumn(1).width = 18;
  sheet.getRow(1).height = 30;
  sheet.mergeCells('A1:C1');
  sheet.getCell('A1').value = '整单报价';
  sheet.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
  sheet.getCell('A2').value = 12.5;
  sheet.getCell('A2').numFmt = '0.0000';
  sheet.getCell('B2').value = 0.03;
  sheet.getCell('B2').numFmt = '0.00%';
  sheet.getCell('C2').value = 4;
  sheet.getCell('C2').numFmt = '"数量: "0.###';

  const [preview] = serializeWorkbook(workbook, {
    editableCells: new Set(['报价明细!A2']),
    overriddenCells: new Set(['报价明细!A2']),
  });
  assert.equal(preview.name, '报价明细');
  assert.equal(preview.rowCount, 2);
  assert.equal(preview.columnCount, 3);
  assert.equal(preview.cells.find(cell => cell.address === 'A1').columnSpan, 3);
  assert.equal(preview.cells.find(cell => cell.address === 'A1').style.color, '#FF0000');
  assert.equal(preview.cells.find(cell => cell.address === 'A1').style.backgroundColor, '#FFFF00');
  assert.equal(preview.cells.find(cell => cell.address === 'A2').value, '12.5000');
  assert.equal(preview.cells.find(cell => cell.address === 'A2').rawValue, 12.5);
  assert.equal(preview.cells.find(cell => cell.address === 'A2').editable, true);
  assert.equal(preview.cells.find(cell => cell.address === 'A2').overridden, true);
  assert.equal(preview.cells.find(cell => cell.address === 'B2').value, '3.00%');
  assert.equal(preview.cells.find(cell => cell.address === 'C2').value, '数量: 4');
});

test('workbook preview helpers support Excel addresses', () => {
  assert.equal(columnLetter(28), 'AB');
  assert.deepEqual(parseRange('B3:D5'), { top: 3, left: 2, bottom: 5, right: 4 });
});

test('workbook preview keeps summary rows after intentional blank spacers', () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('报价明细');
  sheet.getCell('A1').value = '上方明细';
  sheet.getCell('A5').value = '底部汇总';
  const [preview] = serializeWorkbook(workbook);
  assert.equal(preview.rowCount, 5);
  assert.ok(preview.cells.some(cell => cell.address === 'A5' && cell.value === '底部汇总'));
});
