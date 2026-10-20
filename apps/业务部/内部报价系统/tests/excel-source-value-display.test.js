const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ExcelFormulas = require('../frontend/excel-formulas');
const context = { window: {}, ExcelFormulas };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/excel-grid.js'), 'utf8'), context);
const { editorText, snapshotNote } = context.window.ExcelGrid;

test('external source formula is displayed while its saved value remains authoritative', () => {
  const original = { f: "'[11]核价基数'!C9", v: 4.5, t: 'n', external_input: true };
  const model = { cells: { 'SRMC201!C2': original,
    '[11]核价基数!C9': { missing_sheet: true },
    '核价基数!C9': { v: 5.8, t: 'n' },
    'SRMC201!D2': { f: 'C2*2', v: 9, t: 'n' } } };
  const before = JSON.stringify(model);
  assert.equal(editorText(original), "='[11]核价基数'!C9");
  assert.match(snapshotNote(original), /使用原表保存值：4.5/);
  assert.match(snapshotNote(original), /不套用当前基数/);
  const evaluator = ExcelFormulas.createEvaluator(model);
  assert.equal(evaluator.value('SRMC201!C2'), 4.5);
  assert.equal(evaluator.value('SRMC201!D2'), 9);
  assert.equal(JSON.stringify(model), before);
});

test('normal formulas, zero and blanks retain their distinct displays', () => {
  assert.equal(editorText({ f: 'A1*2', v: 8 }), '=A1*2');
  assert.equal(snapshotNote({ f: 'A1*2', v: 8 }), '');
  assert.equal(editorText({ v: 0 }), 0);
  assert.equal(editorText({ v: null }), '');
  assert.match(snapshotNote({ f: 'Missing!A1', external_input: true, v: 0 }), /保存值：0/);
});

test('missing direct source uses saved value and downstream calculation without changing formula',()=>{
  const model={cells:{'25251!C103':{v:0.99,f:'總表!N2'},'總表!N2':{v:null},'25251!C112':{v:26.43713325,f:'26.704175*C103'}}};
  const e=ExcelFormulas.createEvaluator(model);
  assert.equal(e.value('25251!C103'),0.99);
  assert.equal(e.value('25251!C112'),26.43713325);
  assert.match(e.fallback('25251!C103'),/沿用原表保存值/);
  assert.equal(model.cells['25251!C103'].f,'總表!N2');
  const zero=ExcelFormulas.createEvaluator(model,{'總表!N2':{v:0}});
  assert.equal(zero.value('25251!C103'),0);
  assert.equal(zero.fallback('25251!C103'),'');
  const blank=ExcelFormulas.createEvaluator(model,{'總表!N2':{v:null}});
  assert.equal(blank.value('25251!C103'),null);
});
