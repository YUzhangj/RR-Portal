'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { inferOutputSourceDepartment } = require('../backend/services/outputSourceDepartment');
const { sourceFieldForOutputCell } = require('../backend/services/outputSourceSync');

function workbookFixture() {
  const workbook = new ExcelJS.Workbook();
  const detail = workbook.addWorksheet('报价明细');
  detail.getCell('A23').value = '模具合计';
  detail.getCell('B35').value = '五金';
  detail.getCell('C35').value = '螺丝';
  detail.getCell('D35').value = 0.2;
  detail.getCell('B36').value = '喷油工';
  detail.getCell('D36').value = 1.2;
  detail.getCell('B50').value = '纸箱';
  detail.getCell('C50').value = '纸箱 / 平卡';
  detail.getCell('B60').value = '× 码点';
  detail.getCell('D60').value = 1.2;
  detail.getCell('B61').value = '÷ 找数';
  detail.getCell('D61').value = 0.98;
  detail.getCell('B86').value = 'HK 40柜运费+吊柜费';
  detail.getCell('C86').value = 8000;
  detail.getCell('B82').value = '10吨车：';
  detail.getCell('C82').value = 1166;
  detail.getCell('D50').value = 1.4;
  workbook.addWorksheet('电子明细').getCell('C4').value = 1;
  return workbook;
}

test('输出修改按对应来源部门撤销审核', () => {
  const workbook = workbookFixture();
  assert.equal(inferOutputSourceDepartment(workbook, '报价明细', 'D11'), 'molding');
  assert.equal(inferOutputSourceDepartment(workbook, '报价明细', 'D35'), 'engineering');
  assert.equal(inferOutputSourceDepartment(workbook, '报价明细', 'D36'), 'painting');
  assert.equal(inferOutputSourceDepartment(workbook, '报价明细', 'D50'), 'engineering');
  assert.equal(inferOutputSourceDepartment(workbook, '电子明细', 'C4'), 'electronic');
  assert.equal(inferOutputSourceDepartment(workbook, '报价明细', 'D35', 'assembly'), 'engineering');
  assert.equal(inferOutputSourceDepartment(workbook, '系统报价汇总', 'C10', 'assembly'), null);
  assert.deepEqual(sourceFieldForOutputCell(workbook, '报价明细', 'D60'), {
    dept: 'sales', path: ['shipping', 'markup_x'],
  });
  assert.deepEqual(sourceFieldForOutputCell(workbook, '报价明细', 'D61'), {
    dept: 'sales', path: ['shipping', 'divisor'],
  });
  assert.deepEqual(sourceFieldForOutputCell(workbook, '报价明细', 'C82'), {
    dept: 'sales', path: ['freight_calc', 'cap_10t'],
  });
  assert.deepEqual(sourceFieldForOutputCell(workbook, '报价明细', 'C86'), {
    dept: 'sales', path: ['freight_calc', 'hk40'],
  });
});
