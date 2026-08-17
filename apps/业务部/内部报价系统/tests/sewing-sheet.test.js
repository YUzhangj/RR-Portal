'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');

const { parseWorkbook } = require('../backend/services/parseSewingSheet');

test('sewing import finds detail sheet and reads merged product groups under one header', async () => {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet('总表');
  summary.addRow(['报价单', '货名', '不含税货价']);

  const detail = workbook.addWorksheet('明细');
  detail.addRow(['物料名称', '裁片部位', '供应商', '', '', '用量/码', '单价', '成本', '码点', '价钱', '备注']);
  detail.mergeCells('A2:K2');
  detail.getCell('A2').value = '产品甲';
  detail.addRow(['面料甲', '前身', '', '', '', 0.5, 10, 5, 1.1, 5.5, '']);
  detail.addRow(['胶件/包装由总部报价']);
  detail.addRow(['', '', '', '', '', '', '', '', '合计', 5.5, '']);
  detail.mergeCells('A6:K6');
  detail.getCell('A6').value = '产品乙';
  detail.addRow(['面料乙', '后身', '', '', '', 0.25, 12, 3, 1.1, 3.3, '']);
  detail.addRow(['', '', '', '', '', '', '', '', '合计', 3.3, '']);

  const result = await parseWorkbook(await workbook.xlsx.writeBuffer());

  assert.equal(result.error, undefined);
  assert.equal(result.sheet_used, '明细');
  assert.equal(result.count, 2);
  assert.deepEqual(result.groups.map(group => group.name), ['产品甲', '产品乙']);
  assert.deepEqual(result.groups.map(group => group.items[0].material), ['面料甲', '面料乙']);
});

test('sewing import splits products by 名称 column when the sheet has only one header', async () => {
  const workbook = new ExcelJS.Workbook();
  const detail = workbook.addWorksheet('车缝报价');
  detail.addRow(['名称', '物料名称', '裁片部位', '用量', '单价', '价钱', '备注']);
  detail.addRow(['角色1', '', '', '', '', '', '']);
  detail.addRow(['', '面料甲', '前身', 0.5, 10, 5, '']);
  detail.addRow(['', '合计', '', '', '', 5, '']);
  detail.addRow(['角色2', '', '', '', '', '', '']);
  detail.addRow(['', '面料乙', '后身', 0.25, 12, 3, '']);

  const result = await parseWorkbook(await workbook.xlsx.writeBuffer());

  assert.equal(result.error, undefined);
  assert.deepEqual(result.groups.map(group => group.name), ['角色1', '角色2']);
  assert.deepEqual(result.groups.map(group => group.items[0].material), ['面料甲', '面料乙']);
});

test('sewing import supports ZURU 布料名称/部位 format and fills down repeated fabric', async () => {
  const workbook = new ExcelJS.Workbook();
  const quote = workbook.addWorksheet('报价单');
  quote.addRow(['图片', '货号', '货品', '人民币报价']);

  const detail = workbook.addWorksheet('明细表7-24');
  detail.addRow(['摇摆水豚鼠-明细表']);
  detail.addRow([]);
  detail.addRow(['图片', '名称', '布料名称', '部位', '用量', '物料价（RMB）', '价钱（RMB）', '码点', '总价钱（RMB）', '布料', '备注']);
  detail.addRow(['图片', '名称', '布料名称', '部位', '用量', '物料价（RMB）', '价钱（RMB）', '码点', '总价钱（RMB）', 'MOQ', '备注']);
  detail.addRow(['', '摇摆水豚鼠']);
  detail.addRow(['', '', '棕色长短云貂绒', '身', 0.12, 20, 2.4, 1.05, 2.52]);
  detail.addRow(['', '', '', '前胸', 0.01, 20, 0.2, 1.05, 0.21]);
  detail.addRow(['', '', '人工', '', 1, 6, 6, 1.05, 6.3]);
  detail.addRow(['', '', '', '', '', '', '', '合计', 9.03]);

  const result = await parseWorkbook(await workbook.xlsx.writeBuffer());

  assert.equal(result.error, undefined);
  assert.equal(result.sheet_used, '明细表7-24');
  assert.equal(result.count, 1);
  assert.equal(result.groups[0].name, '摇摆水豚鼠');
  assert.deepEqual(result.groups[0].items.map(item => item.material), [
    '棕色长短云貂绒',
    '棕色长短云貂绒',
    '人工',
  ]);
  assert.equal(result.groups[0].items[0].unit_price, 20);
  assert.equal(result.groups[0].items[0].markup, 1.05);
  assert.equal(result.groups[0].items[0].price, 2.52);
  assert.equal(result.groups[0].labor_amount, 6.3);
});
