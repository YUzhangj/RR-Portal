const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareWorkbookChanges, prepareNativeSectionPayload } = require('../backend/services/excelWorkbookEdit');
const { sheetLayout } = require('../backend/services/excelVerificationImport');
const fixture = () => [
  { id: 1, dept: 'sales', payload_json: JSON.stringify({ legacy_import: { excel_model: { sheet: 'S', cells: {
    'S!A1': { v: 3, owner: 'sales' }, 'S!B1': { f: 'A1*2', v: 6, owner: 'painting' },
    'S!C1': { f: '1/0', owner: 'sales' },
  } } }, excel_native: { inputs: {} }, untouched: 'preserve' }) },
  { id: 2, dept: 'painting', payload_json: JSON.stringify({ excel_native: { inputs: {} } }) },
];
const constant = n => ({ v: n, f: null, t: 'n' });
const change = (id, inputs, base_inputs = {}) => ({ section_id: id, inputs, base_inputs });
test('whole-sheet save preserves source model and supports changes across owners', () => {
  const sections = fixture(), source = JSON.parse(sections[0].payload_json).legacy_import;
  const updates = prepareWorkbookChanges(sections, [change(1, { 'S!A1': constant(4) }),
    change(2, { 'S!B1': { f: 'A1*3', t: 'n', external_input: false } })], () => true);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].payload.legacy_import, source);
  assert.equal(updates[0].payload.untouched, 'preserve');
  assert.equal(updates[1].payload.excel_native.inputs['S!B1'].f, 'A1*3');
});
test('whole-sheet save rejects stale edits, wrong owners and duplicate sections', () => {
  assert.throws(() => prepareWorkbookChanges(fixture(), [change(1, {}, { 'S!A1': constant(2) })], () => true), e => e.status === 409);
  assert.throws(() => prepareWorkbookChanges(fixture(), [change(1, { 'S!B1': constant(3) })], () => true), e => e.status === 403);
  assert.throws(() => prepareWorkbookChanges(fixture(), [change(1, {})], () => false), e => e.status === 403);
  assert.throws(() => prepareWorkbookChanges(fixture(), [change(1, {}), change(1, {})], () => true), e => e.status === 400);
  assert.throws(() => prepareWorkbookChanges([{id: 1, dept: 'sales', payload_json: '{}'}], [change(1, {})], () => true), e => e.status === 409);
});
test('whole-sheet save rejects invalid formulas and keeps existing source errors visible', () => {
  for (const f of ['B1', '1/0', 'NOTSUPPORTED(3)', 'D99', 'process.exit()']) {
    assert.throws(() => prepareWorkbookChanges(fixture(), [change(1, { 'S!A1': { f, t: 'n', external_input: false } })], () => true), e => e.status === 400);
  }
  assert.doesNotThrow(() => prepareWorkbookChanges(fixture(), [change(1, { 'S!A1': constant(4) })], () => true));
  assert.throws(() => prepareWorkbookChanges(fixture(), [change(1, { 'S!A1': {...constant(4), owner: 'painting'} })], () => true), e => e.status === 400);
});
test('sheet layout includes all populated/formula cells, not formatting-only distant cells', () => {
  const layout = sheetLayout({ '!ref': 'A1:IV65536', A1: { v: 'header' }, D20: { f: '1+2' },
    Z100: { t: 'z' }, '!merges': [{s:{r:0,c:0},e:{r:0,c:2}}] });
  assert.equal(layout.rows, 20); assert.equal(layout.columns, 4); assert.equal(layout.merges.length, 1);
});

test('editing or clearing an input cannot introduce errors in dependent departments or totals', () => {
  const sections = fixture();
  const payload = JSON.parse(sections[0].payload_json);
  payload.legacy_import.excel_model.cells['S!B1'] = { f: '10/A1', v: 10 / 3, owner: 'painting' };
  payload.legacy_import.excel_model.cells['S!D1'] = { f: 'B1*2', v: 20 / 3, owner: 'sales' };
  sections[0].payload_json = JSON.stringify(payload);
  assert.throws(() => prepareWorkbookChanges(sections, [change(1, { 'S!A1': constant(0) })], () => true),
    e => e.status === 400 && /S!B1.*DIV\/0/.test(e.message));
  assert.doesNotThrow(() => prepareWorkbookChanges(sections, [change(1, { 'S!A1': constant(4) })], () => true));

  payload.legacy_import.excel_model.cells['S!A1'].v = 0;
  payload.excel_native.inputs = { 'S!A1': constant(4) };
  sections[0].payload_json = JSON.stringify(payload);
  assert.throws(() => prepareWorkbookChanges(sections, [change(1, {}, payload.excel_native.inputs)], () => true),
    e => e.status === 400 && /S!B1.*DIV\/0/.test(e.message));
});

test('affected source errors that already existed remain visible without blocking valid input changes', () => {
  const sections = fixture(), payload = JSON.parse(sections[0].payload_json);
  payload.legacy_import.excel_model.cells['S!B1'] = { f: 'A1/0', owner: 'painting' };
  sections[0].payload_json = JSON.stringify(payload);
  assert.doesNotThrow(() => prepareWorkbookChanges(sections, [change(1, { 'S!A1': constant(4) })], () => true));
});

test('department saves share workbook validation while accepting the compact legacy form inputs', () => {
  const sections = fixture();
  const submitted = JSON.parse(sections[0].payload_json);
  submitted.excel_native.inputs['S!A1'] = { v: 4 };
  const saved = prepareNativeSectionPayload(sections, 1, submitted, () => true);
  assert.deepEqual(saved.excel_native.inputs['S!A1'], constant(4));
  assert.deepEqual(saved.legacy_import, submitted.legacy_import);
  const formulaPayload = JSON.parse(sections[1].payload_json);
  formulaPayload.excel_native.inputs['S!B1'] = { f: 'A1*3' };
  assert.deepEqual(prepareNativeSectionPayload(sections, 2, formulaPayload, () => true).excel_native.inputs['S!B1'],
    { f: 'A1*3', t: 'n', external_input: false });
});

test('department saves cannot replace source data, edit another owner or bypass formula errors', () => {
  const sections = fixture();
  const submitted = JSON.parse(sections[0].payload_json);
  submitted.legacy_import.excel_model.cells['S!B1'].owner = 'sales';
  assert.throws(() => prepareNativeSectionPayload(sections, 1, submitted, () => true), error => error.status === 403);
  const crossOwner = JSON.parse(sections[0].payload_json);
  crossOwner.excel_native.inputs['S!B1'] = { v: 100 };
  assert.throws(() => prepareNativeSectionPayload(sections, 1, crossOwner, () => true), error => error.status === 403);
  const invalidFormula = JSON.parse(sections[1].payload_json);
  invalidFormula.excel_native.inputs['S!B1'] = { f: 'A1/0' };
  assert.throws(() => prepareNativeSectionPayload(sections, 2, invalidFormula, () => true), error => error.status === 400);
  const original = JSON.parse(sections[0].payload_json);
  original.legacy_import.excel_model.cells['S!B1'].f = '10/A1';
  sections[0].payload_json = JSON.stringify(original);
  original.excel_native.inputs['S!A1'] = { v: 0 };
  assert.throws(() => prepareNativeSectionPayload(sections, 1, original, () => true), error => error.status === 400);
});

test('ordinary form saves cannot introduce an unvalidated native workbook', () => {
  const sections = [{ id: 1, dept: 'sales', payload_json: JSON.stringify({ header: {currency:'HKD'} }) }];
  assert.deepEqual(prepareNativeSectionPayload(sections, 1, { header: {currency:'RMB'} }, () => true), { header: {currency:'RMB'} });
  assert.throws(() => prepareNativeSectionPayload(sections, 1, { legacy_import: {excel_model:{cells:{}}} }, () => true), error => error.status === 400);
});
