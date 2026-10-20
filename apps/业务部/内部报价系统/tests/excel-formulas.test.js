'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../frontend/excel-formulas');
const { auditModel, parseExcelVerificationWorkbook } = require('../backend/services/excelVerificationImport');
const { applyCostingBasisPayload, DEFAULT_COSTING_BASIS } = require('../backend/services/costingBasis');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('original painting formulas preserve the upstream calculation and editable percentages', () => {
  const model = { cells: {
    '92125!L45': { v: 4.33, t: 'n' },
    '92125!L46': { v: 1.49333333333333, f: 'L45/6*2+0.05' },
    '92125!C44': { v: .448, f: 'L46*30%' },
    '92125!C45': { v: .08362666666666665, f: 'L46*70%*0.08' },
  } };
  close(E.createEvaluator(model).value('92125!C44'), .448);
  close(E.createEvaluator(model).value('92125!C45'), .08362666666666665);
  const edited = E.createEvaluator(model, { '92125!L45': { v: 6 } });
  close(edited.value('92125!C44'), .615);
  close(edited.value('92125!C45'), .1148);
  close(E.createEvaluator(model, { '92125!C45': { f: 'L46*70%*0.1' } }).value('92125!C45'), .10453333333333333);
  assert.equal(model.cells['92125!L45'].v, 4.33);
});

test('Chinese cross-sheet references, absolute ranges, lookup and exchange dependencies', () => {
  const model = { cells: {
    '参数!A1': { v: 'ABS' }, '参数!B1': { v: 'PP' }, '参数!A2': { v: 6.5 }, '参数!B2': { v: 5.8 },
    '總表!Z3': { v: .87 }, '产品!A1': { v: 'PP' },
    '产品!B1': { f: "HLOOKUP(A1,'参数'!$A$1:$B$2,2,FALSE)" },
    '产品!D10': { f: '總表!Z3' }, '产品!C46': { f: '0.2/D10' },
    '产品!C47': { f: 'SUM(B1,C46)' },
  } };
  const evaluate = E.createEvaluator(model);
  close(evaluate.value('产品!B1'), 5.8);
  close(evaluate.value('产品!C47'), 5.8 + .2 / .87);
  close(E.createEvaluator(model, { '總表!Z3': { v: .8 } }).value('产品!C46'), .25);
  assert.ok(evaluate.dependencies('产品!C47', true).includes('總表!Z3'));
});

test('errors remain explicit and absent external tables are flagged cached inputs, not zero', () => {
  const model = { cells: {
    '产品!A1': { f: 'A2' }, '产品!A2': { f: 'A1' },
    '产品!A3': { f: '1/0' }, '产品!A4': { f: 'NOTSUPPORTED(1)' },
    '产品!B1': { v: 10, f: "'外部'!C1", external_input: true },
    '产品!B2': { f: 'B1/2' }, '产品!B3': { f: "'外部'!C1" },
    '外部!C1': { missing_sheet: true },
  } };
  const ev = E.createEvaluator(model);
  assert.throws(() => ev.value('产品!A1'), /循环/);
  assert.throws(() => ev.value('产品!A3'), /DIV/);
  assert.throws(() => ev.value('产品!A4'), /不支持/);
  assert.throws(() => ev.value('产品!B3'), /缺少来源/);
  close(ev.value('产品!B2'), 5);
  close(E.createEvaluator(model, { '产品!B1': { v: 12 } }).value('产品!B2'), 6);
  assert.throws(() => E.parse('globalThis.process.exit()', '产品'));
});

test('audit distinguishes stale saved values, errors and exact results', () => {
  const report = auditModel({ cells: { 'S!A1': { v: 1 }, 'S!A2': { v: 3, f: 'A1+1' },
    'S!A3': { v: 2, f: 'A1*2' }, 'S!A4': { v: 1, f: '1/0' } } });
  assert.equal(report.differences.length, 1);
  assert.equal(report.errors.length, 1);
  assert.equal(report.differences[0].recalculated, 2);
});

test('generic costing basis updates cannot silently replace a native workbook formula version', () => {
  const payload = { excel_native: { inputs: {} }, header: { fx_hkd_usd: 7.75 } };
  assert.equal(applyCostingBasisPayload('sales', payload, DEFAULT_COSTING_BASIS).changed, false);
  assert.equal(payload.header.fx_hkd_usd, 7.75);
});

test('actual ZURU workbook: 92125 full formula chain, tax and change propagation', { skip: !process.env.ZURU_FORMULA_TEST_FILE }, () => {
  const parsed = parseExcelVerificationWorkbook(process.env.ZURU_FORMULA_TEST_FILE);
  assert.equal(parsed.items.length, 18);
  const item = parsed.items.find(i => i.quoteNo === '92125');
  const legacy = item.salesPayload.legacy_import, model = legacy.excel_model;
  assert.equal(legacy.excel_audit.differences.length, 0);
  assert.equal(legacy.excel_audit.errors.length, 0);
  const original = E.createEvaluator(model);
  close(original.value('92125!M100'), 1.0343429177007393);
  close(original.value('92125!N100'), 35.192155175463846);
  close(original.value('92125!Q100'), 8.242284152243272);
  close(original.value('92125!C80'), 5.66105432744608);
  assert.equal(model.cells['92125!C45'].f, 'L46*70%*0.08');
  assert.equal(item.departmentPayloads.painting.legacy_items[0].excel_cell, '92125!C44');
  assert.equal(model.cells['92125!H73'].external_input, true);
  const modified = E.createEvaluator(model, { '92125!C98': { f: '0.2' } });
  close(modified.value('92125!M100') - original.value('92125!M100'),
    (original.value('92125!C95') + original.value('92125!D95') + original.value('92125!F95')) * .08 * (.2 - .115));
  assert.equal(parsed.items.find(i => i.quoteNo === '25251').salesPayload.legacy_import.excel_audit.errors.length, 7);
});

test('ToyMonster functions retain truncation, text-aware averages and lazy error fallback', () => {
  const cells = {'S!A1':{v:4},'S!A2':{v:'7'},'S!A3':{v:true},'S!A4':{v:null},'S!A5':{v:''}};
  const run = f => E.createEvaluator({cells:{...cells,'S!B1':{f}}}).value('S!B1');
  close(run('TRUNC(-12.789,2)'),-12.78);
  close(run('TRUNC(129.9,-1)'),120);
  close(run('TRUNC(12.8)'),12);
  close(run('AVERAGEA(A1:A5)'),1.25);
  close(run('AVERAGEA("7",TRUE,4)'),4);
  assert.throws(()=>run('AVERAGEA(A4)'),/DIV/);
  assert.equal(run('IFERROR(1/0,"")'),'');
  close(run('IFERROR(4,1/0)'),4);
  close(run('IFERROR(HLOOKUP("missing",A1:A2,2,FALSE),0)'),0);
  assert.throws(()=>run('IFERROR(1/0,2/0)'),/DIV/);
  close(E.createEvaluator({cells:{...cells,'S!B1':{f:'AVERAGEA(A1:A5)'}}},{'S!A1':{v:8}}).value('S!B1'),2.25);
});
