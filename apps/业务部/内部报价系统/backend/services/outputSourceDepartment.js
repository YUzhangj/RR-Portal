'use strict';

const DEPARTMENTS = new Set(['sales', 'engineering', 'electronic', 'molding', 'painting', 'assembly', 'slush', 'sewing']);

const SHEET_DEPARTMENTS = new Map([
  ['啤机明细', 'molding'],
  ['吹气明细', 'molding'],
  ['喷油明细', 'painting'],
  ['装配明细', 'assembly'],
  ['电子明细', 'electronic'],
  ['JAZWARES运费', 'sales'],
]);

function text(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'result')) return String(value.result ?? '').trim();
  return String(value ?? '').trim();
}

function rowText(worksheet, row) {
  const values = [];
  worksheet.getRow(row).eachCell({ includeEmpty: false }, cell => values.push(text(cell.value)));
  return values.join(' ');
}

function detailDepartment(worksheet, cell) {
  const { row, col } = cell;
  if (row === 7) {
    if (col === 3) return 'sales';
    if ([5, 7, 9].includes(col)) return 'engineering';
    if (col === 11 || col === 15) return 'molding';
    if (col === 13) return 'assembly';
  }

  let moldTotalRow = 0;
  worksheet.eachRow(sourceRow => {
    if (!moldTotalRow && rowText(worksheet, sourceRow.number).includes('模具合计')) moldTotalRow = sourceRow.number;
  });
  if (row <= 6 || (row >= 10 && moldTotalRow && row <= moldTotalRow)) return 'molding';

  const content = rowText(worksheet, row);
  if (col >= 14 && /纸箱|平卡|箱价|CU\.FT|产品尺寸|装箱/.test(content)) return 'engineering';
  if (/喷油工|喷油人工|油漆/.test(content)) return 'painting';
  if (/装配工|组装人工|包装\/混装人工|半成品|包装/.test(content)) return 'assembly';
  if (/电子/.test(content)) return 'electronic';
  if (/搪胶/.test(content)) return 'slush';
  if (/车缝|车衣|车发/.test(content)) return 'sewing';
  if (/五金|利宝|说明书|其他外购|辅助材料|纸箱|平卡/.test(content)) return 'engineering';
  if (/啤工|注塑|进口料价|国内料价|料重|机型/.test(content)) return 'molding';
  if (/运输方案|运费|吊柜费|报价|码点|找数|汇率|利润|税/.test(content)) return 'sales';
  return null;
}

function inferOutputSourceDepartment(workbook, sheetName, address) {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet || !/^[A-Z]{1,3}[1-9]\d*$/.test(address)) return null;
  const cell = worksheet.getCell(address);
  if (DEPARTMENTS.has(cell.outputDepartment)) return cell.outputDepartment;
  if (SHEET_DEPARTMENTS.has(sheetName)) return SHEET_DEPARTMENTS.get(sheetName);
  return sheetName === '报价明细' ? detailDepartment(worksheet, cell) : null;
}

module.exports = { inferOutputSourceDepartment };
