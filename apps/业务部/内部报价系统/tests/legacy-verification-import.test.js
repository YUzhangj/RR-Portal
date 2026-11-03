const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const {
  parseLegacyVerificationWorkbook,
  parseZuruVerificationWorkbook,
  parseFlexibleLegacyDetailSheet,
} = require('../backend/services/legacyVerificationImport');


function appendDetailSheet(workbook, name) {
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['料型', 'ABS 750SW'],
    ['单价', 6.5],
    ['机型', '4A-6A'],
    ['啤工价', 940],
    ['料重损耗', 1.03],
    ['模号', '名称', '料型', '料重(G)', '料重含损耗', '料价(G)', '机型', '件数', '套数', '目标数', '啤工', '料金额', '用量'],
    ['M1', '外壳', 'ABS', 10, 10.3, 0.0143, '4A-6A', 1, 1, 1000, 0.2, 0.143, 1],
    [null, null, '核价', '上次报价'],
    ['料金额', null, 0.143, 0.13],
    ['喷油人工', null, 0.2, 0.18],
    ['包装人工', null, 0.3, 0.25],
    [null, 'TOTAL(HK$)', 0.643, 0.56],
    ['运费48%', null, 0.05],
    [null, '码点 X', 1.2],
    [null, 'TOTAL（HK$）', 0.9],
    [null, 'TOTAL（US$）', 0.12],
    [null, '客人目标 US$', 0.12],
    [null, '货价', '进口料', '国内料', '吹气', '油漆'],
  ]), name);
}

test('legacy Sky Castle workbook is split into one verification item per item number', () => {
  const workbook = XLSX.utils.book_new();
  const itemHeader = Array(29).fill(null);
  itemHeader[0] = '货号'; itemHeader[1] = '货价(HK$)';
  const itemA = Array(29).fill(0);
  itemA[0] = 'SR-A'; itemA[1] = 10; itemA[2] = 8; itemA[3] = 6;
  itemA[4] = 1; itemA[5] = 2; itemA[7] = 0.5; itemA[12] = 1.5; itemA[28] = 0.04;
  const itemB = [...itemA]; itemB[0] = 'SR-B'; itemB[1] = 20;
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([itemHeader, itemA, itemB]), '货号分表');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['客名', '货号', '货品名称', '2026接单数量', '货价(HK$)'],
    ['SKY', 'SR-A', null, 1234, 10],
  ]), '总表');
  appendDetailSheet(workbook, 'SR-A');
  appendDetailSheet(workbook, 'SR-B');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-verification-'));
  const file = path.join(dir, 'sky.xlsx');
  XLSX.writeFile(workbook, file);

  const parsed = parseLegacyVerificationWorkbook(file);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.withQty, 1);
  assert.equal(parsed.withoutQty, 1);
  assert.equal(parsed.totalQty, 1234);
  assert.equal(parsed.items[0].quoteNo, 'SR-A');
  assert.equal(parsed.items[0].salesPayload.pricing_summary.t1.base_price, 10);
  assert.equal(parsed.items[0].salesPayload.pricing_summary.t3.injection_labor, 1);
  assert.equal(parsed.items[0].salesPayload.pricing_summary.t3.assembly_labor, 2);
  assert.equal(parsed.items[0].salesPayload.pricing_summary.t1.imp_mat, 0.5);
  assert.equal(parsed.items[0].salesPayload.pricing_summary.t2.color_box, 1.5);
  assert.equal(parsed.items[1].qty, null);
  assert.equal(parsed.items[1].salesPayload.legacy_import.confirmed_currency, 'HKD');
  assert.equal(parsed.items[0].salesPayload.legacy_import.detail_imported, true);
  assert.equal(parsed.items[0].departmentPayloads.molding.injection.length, 1);
  assert.equal(parsed.items[0].departmentPayloads.molding.legacy_items.length, 1);
  assert.equal(parsed.items[0].departmentPayloads.painting.legacy_items.length, 1);
  assert.equal(parsed.items[0].departmentPayloads.assembly.legacy_items.length, 1);
  assert.equal(parsed.items[0].salesPayload.legacy_import.pricing_tail.length, 6);
  assert.equal(parsed.items[0].salesPayload.legacy_import.pricing_tail[0].source_row, 12);
  assert.ok(parsed.items[0].salesPayload.legacy_import.pricing_tail
    .some(row => row.cells.includes('客人目标 US$')));
});

function appendZuruDetailSheet(workbook, name, price) {
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    [null, '机型', '10A'],
    [null, '机型单价', 1160],
    [null, '料型', 'ABS'],
    [null, '料价$元/LBS', 6.5],
    [null, '模具编号', '工模名称', '料型', '料重/g', '料单价', '机型', '1出几套', '日产量22H', '啤工价', '料金额'],
    [null, 'M01', '外壳', 'ABS', 10, 0.0143, '10A', 2, 8000, 0.1, 0.143],
    [null, null, 'Total:', 10, null, null, null, null, 'Total:', 0.1, 0.143],
    ['用量（pcs）', '核价', '報價'],
    ['料价进口料', 0.143, 0.15],
    [null, 'TOTAL(HK$)', 0.143],
    [null, 'TOTAL（HK＄）', price],
    [name, '货价', '进口料', '国内料'],
    [null, price, 0.143, 0],
  ]), name);
}

test('ZURU workbook imports summary rows, flexible mold headers and detail-derived prices', () => {
  const workbook = XLSX.utils.book_new();
  const rows = Array.from({ length: 7 }, () => []);
  rows.push(['客名', '货号', '货品名称', '2026实际接单数量', '货价(HK$)', '成本\n(含人工)', '成本\n(不含人工)', '啤工', '装工', '料价进口料']);
  rows.push(['ZURU', 'A100', '测试产品', null, 3, 2.5, 2, 0.1, 0.2, 0.143]);
  rows.push(['ZURU', 'B200', '美人鱼', null, null, 3.5, 3, 0.1, 0.2, 0.143]);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '總表');
  appendZuruDetailSheet(workbook, 'A100', 3);
  appendZuruDetailSheet(workbook, 'B200美人鱼', 4);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-zuru-'));
  const file = path.join(dir, 'zuru.xlsx');
  XLSX.writeFile(workbook, file);

  const parsed = parseZuruVerificationWorkbook(file);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].confirmedPrice, 3);
  assert.equal(parsed.items[1].confirmedPrice, 4);
  assert.equal(parsed.items[1].salesPayload.legacy_import.source_price_from_detail, true);
  assert.equal(parsed.items[1].salesPayload.legacy_import.source_detail_sheet, 'B200美人鱼');
  assert.equal(parsed.items[0].departmentPayloads.molding.injection.length, 1);
  assert.equal(parsed.items[0].salesPayload.legacy_import.pricing_tail.length, 2);
  assert.equal(parsed.items[0].salesPayload.pricing_summary.t3.injection_labor, 0.1);
});

test('ZURU detail import retains a verified Excel formula and its shared exchange reference', () => {
  const rows = [
    ['模号', '名称', '料型', '料重(G)', '料价(G)', '机型', '件数', '套数', '目标数', '啤工'],
    ['M1', '外壳', 'ABS', 10, 0.0143, '10A', 1, 1, 1000, 0.1],
    ['TOTAL:'],
    [null, null, '核价', '报价'],
    ['收藏指南', 1, 0.2 / 0.87, 0.24],
    [null, 'TOTAL(HK$)', 0.2 / 0.87],
    [], [], [], [null, null, null, 0.87],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet.C5.f = '0.2/D10';
  const parsed = parseFlexibleLegacyDetailSheet(sheet, '92125');
  const item = parsed.departmentPayloads.engineering.legacy_items[0];
  assert.equal(item.source_formula, '0.2/D10');
  assert.equal(item.source_formula_cell, 'C5');
  assert.equal(item.source_formula_basis, 'rmb_hkd');
  assert.equal(item.source_formula_ref_value, 0.87);
});
