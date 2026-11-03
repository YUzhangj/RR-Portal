'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const reports = fs.readFileSync(path.join(__dirname, 'report_export.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server/server.js'), 'utf8');
function browser() {
  const elements = new Map(), warnings = [], writes = [], store = new Map();
  const element = (id, value = '') => {
    const node = { value: String(value), dataset: {}, style: {}, textContent: '', innerHTML: '',
      classList: { add() {}, remove() {}, toggle() {} }, focus() {} };
    let currentValue = String(value);
    Object.defineProperty(node, 'value', { get: () => currentValue, set: next => { currentValue = String(next); } });
    elements.set(id, node); return node;
  };
  for (const [id, value] of Object.entries({ f_date: '2026-10-20', f_supplier: 'Test Supplier',
    f_qty: 3000, f_sampleQty: 125, f_result: 'PASS', f_type: '成品', f_aqlLevel: 'MAJ 0.65' })) element(id, value);
  for (const id of ['f_pass', 'f_fail', 'f_defectRate', 'dsSample', 'dsFail', 'dsPass', 'dsRate',
    'dsAqlSuggest', 'dsAqlResult', 'dsAqlReasons', 'defectsRows', 'defectsEmptyHint', 'measRows', 'measEmptyHint']) element(id);
  const ctx = { console, setTimeout() {}, clearTimeout() {}, setInterval() {}, addEventListener() {}, navigator: {},
    document: { addEventListener() {}, getElementById: id => elements.get(id) || null, querySelectorAll: () => [],
      querySelector: () => null, createElement: () => ({ innerHTML: '', style: {} }) },
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) },
    confirm: message => { warnings.push(message); return true; },
  };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(app, ctx); vm.runInContext(reports, ctx);
  ctx.persist = () => writes.push(JSON.parse(vm.runInContext('JSON.stringify(state)', ctx)));
  vm.runInContext(`initDefectLib=()=>{}; _checkUnknownDefects=()=>{}; getSupplierOptions=()=>['Test Supplier'];
    getCustomerOptions=()=>[];getProcessTypeOptions=()=>[];showToast=()=>{};can=()=>true;
    renderSupplierDatalist=()=>{};renderCustomerDatalist=()=>{};renderProcessTypeDatalist=()=>{};
    renderInspectorDatalist=()=>{};renderReviewPage=()=>{};updateTopKpis=()=>{};
    renderSupplierDatalist=()=>{};bindNameWhitelistCheck=()=>{};syncAqlLevelPills=()=>{};
    refreshDefectDescDatalist=()=>{};switchModalMode=()=>{};_syncOrderNoNA=()=>{};
    closeModalDirect=()=>{editingId=null};currentPage='test';
    _liveUser=()=>({username:'test-qc',name:'Test Inspector'});state={records:[],nextId:501};`, ctx);
  const run = code => vm.runInContext(code, ctx);
  const json = code => JSON.parse(run(`JSON.stringify(${code})`));
  return { ctx, elements, element, warnings, writes, run, json };
}
const defect = (qty, level = 'MAJ 0.65') => ({ desc: 'synthetic defect', qty, level, category: '外观/质量', remark: '' });
const measurement = (result = 'FAIL') => ({ item: 'synthetic measurement', measureType: 'PF', result, values: [result] });
for (const [base, badDefect, badMeas, expected] of [
  ['COND', true, true, 'COND'], ['HOLD', true, true, 'HOLD'], ['PASS', true, false, 'REJ'],
  ['PASS', false, true, 'REJ'], ['REJ', false, false, 'REJ'], ['PASS', false, false, 'PASS'],
  [' cond ', true, true, 'COND'],
]) test(`final result ${base}/${badDefect}/${badMeas} is ${expected}`, () => {
  const b = browser(); assert.equal(b.ctx.getFinalRecordResult(base, [defect(badDefect ? 3 : 2)], badMeas ? [measurement()] : [], 3000), expected);
});

test('real rendered grade handler immediately recalculates AQL and the final selector', () => {
  const b = browser(); b.ctx._loadDefectRows([defect(3, 'MIN 2.5')]);
  assert.equal(b.elements.get('f_result').value, 'PASS');
  const handler = b.elements.get('defectsRows').innerHTML.match(/onchange="(_defectRows\[0\]\.level[^\"]+)"/)[1];
  b.run(`(function(){${handler}}).call({value:'MAJ 0.65'})`);
  assert.equal(b.elements.get('dsAqlResult').textContent, 'REJ'); assert.equal(b.elements.get('f_result').value, 'REJ');
  b.run(`(function(){${handler}}).call({value:'MIN 2.5'})`);
  assert.equal(b.elements.get('dsAqlResult').textContent, 'PASS'); assert.equal(b.elements.get('f_result').value, 'PASS');
});
for (const manual of ['COND', 'HOLD']) test(`editing failing measurements and defects preserves manual ${manual}`, () => {
  const b = browser(); b.elements.get('f_result').value = manual;
  b.ctx._loadDefectRows([defect(3)]); b.ctx._loadMeasRows([measurement()]);
  b.ctx.updateMeasCell(0, 'values', 0, 'FAIL'); b.ctx.updateMeasField(0, 'item', 'changed measurement');
  assert.equal(b.elements.get('f_result').value, manual);
  b.ctx.saveRecord(); assert.equal(b.json('state.records[0]').result, manual);
});

test('AQL passing defects cannot hide a measurement FAIL; removing it recalculates PASS', () => {
  const b = browser(); b.ctx._loadMeasRows([measurement()]); b.ctx._loadDefectRows([defect(2)]);
  assert.equal(b.elements.get('f_result').value, 'REJ'); b.ctx.removeMeasRow(0);
  assert.equal(b.elements.get('f_result').value, 'PASS');
});
test('manual measurement result handler participates in main judgment', () => {
  const b = browser(); b.ctx._loadMeasRows([measurement('PASS')]);
  const handler = b.elements.get('measRows').innerHTML.match(/onchange="(_measRows\[0\]\.result[^\"]+)"/)[1];
  b.run(`(function(){${handler}}).call({value:'FAIL'})`); assert.equal(b.elements.get('f_result').value, 'REJ');
});

test('over-100% confirmation cancellation preserves all records and id allocation', () => {
  const b = browser(); b.ctx._loadDefectRows([defect(100), defect(75, 'MIN 2.5')]);
  b.ctx.confirm = message => { b.warnings.push(message); return false; }; b.ctx.saveRecord();
  assert.equal(b.warnings.length, 1); assert.match(b.warnings[0], /175.*125.*100%/);
  assert.deepEqual(b.json('state'), { records: [], nextId: 501 }); assert.equal(b.writes.length, 0);
});
test('confirmed multiple defects keep their counts and >100% rate without negative pass', () => {
  const b = browser(); b.ctx._loadDefectRows([defect(100), defect(75, 'MIN 2.5')]); b.ctx.saveRecord();
  const record = b.json('state.records[0]');
  assert.deepEqual(record.defects.map(d => d.qty), [100, 75]); assert.equal(record.fail, 175);
  assert.equal(record.pass, 0); assert.equal(record.defectRate, '140.00%'); assert.equal(record.result, 'REJ');
  assert.equal(record.status, 'pending'); assert.equal(b.writes.length, 1);
});
test('PASS above AQL confirmation describes the actual forced REJ outcome', () => {
  const b = browser(); b.ctx._loadDefectRows([defect(3)]); b.elements.get('f_result').value = 'PASS'; b.ctx.saveRecord();
  assert.match(b.warnings[0], /将自动判定为 REJ/); assert.doesNotMatch(b.warnings[0], /保存为 PASS/);
  assert.equal(b.json('state.records[0]').result, 'REJ');
});

test('opening another record does not retain the previous measurement FAIL', () => {
  const b = browser(); b.ctx._loadMeasRows([measurement()]);
  b.run(`state.records=[{id:1,date:'2026-10-20',supplier:'Test Supplier',qty:3000,sampleQty:125,result:'PASS',defects:[],measurements:[]}];`);
  b.ctx.openEditModal(1); assert.equal(b.elements.get('f_result').value, 'PASS');
});
test('removing existing defects and measurements clears stored arrays rather than resurrecting old failures', () => {
  const b = browser(); b.run(`state.records=[{id:1,date:'2026-10-20',supplier:'Test Supplier',qty:3000,sampleQty:125,result:'COND',status:'rejected',rejectReason:'review'}];`);
  b.ctx.openEditModal(1); b.ctx._loadDefectRows([defect(3)]); b.ctx._loadMeasRows([measurement()]);
  b.run(`state.records[0].defects=${JSON.stringify([defect(3)])}; state.records[0].measurements=${JSON.stringify([measurement()])};`);
  b.ctx.removeDefectRow(0); b.ctx.removeMeasRow(0); b.elements.get('f_result').value = 'PASS'; b.ctx.saveRecord();
  const record = b.json('state.records[0]'); assert.deepEqual(record.defects, []); assert.deepEqual(record.measurements, []);
  assert.equal(record.result, 'PASS'); assert.equal(record.status, 'pending'); assert.equal(record.rejectReason, '');
});

for (const [manual, label] of [['COND', 'AOD'], ['HOLD', '待定'], ['PASS', '不合格']]) test(`IQC canvas uses ${label} for ${manual} plus measurement FAIL`, () => {
  const b = browser(), record = { id:1, date:'2026-10-20', supplier:'Test Supplier', qty:3000, sampleQty:125,
    result:manual, defects:[defect(3)], measurements:[measurement()] };
  const html = b.ctx._buildIQCCanvas(record).innerHTML;
  const selected = Array.from(html.matchAll(/<div style="text-align:center;font-size:11px;white-space:nowrap;font-weight:900;[^\"]*">([^<]*)<\/div>/g), m => m[1]);
  assert.deepEqual(selected, [label]); assert.match(html, /FAIL/); // exceptions never erase the actual measurement outcome
});

test('conditional record survives review, SQLite round trip and CSV export with its failing details', () => {
  const b = browser(); b.elements.get('f_result').value = 'COND'; b.ctx._loadDefectRows([defect(100), defect(75)]);
  b.ctx._loadMeasRows([measurement()]); b.ctx.saveRecord(); b.ctx.approveRecord(501);
  const record = b.json('state.records[0]'); assert.equal(record.result, 'COND'); assert.equal(record.reviewBy, 'Test Inspector');
  assert.equal(record.status, 'approved'); assert.ok(record.reviewAt); assert.ok(record.updatedAt);
  const core = vm.runInNewContext(server.slice(server.indexOf('const RECORD_COLS'), server.indexOf('function replaceUsers')) +
    ';({SCHEMA_SQL,upsertRecords,rowToRecord})');
  const db = new DatabaseSync(':memory:');
  try { db.exec(core.SCHEMA_SQL); core.upsertRecords(db, [record]);
    const stored = core.rowToRecord(db.prepare('SELECT * FROM records WHERE id=501').get());
    assert.equal(stored.result, 'COND'); assert.equal(stored.fail, 175); assert.equal(stored.defects.length, 2);
    assert.equal(stored.measurements[0].result, 'FAIL');
    const csv = vm.runInNewContext(server.slice(server.indexOf('function formatModifiedDate'), server.indexOf('function buildFactoryExcelHtml')) + ';buildRecordsCsv', {})([stored]);
    assert.match(csv, /COND/); assert.match(csv, /140\.00%/);
  } finally { db.close(); }
});


test('known description selection updates defaults in place without replacing the focused quantity input', () => {
  const b = browser(); b.ctx._loadDefectRows([defect(3)]);
  const before = b.elements.get('defectsRows').innerHTML, selects = [{value:''},{value:''}];
  b.ctx.findDefectLibItem = () => ({name:'known defect',defaultLevel:'MIN 2.5',category:'尺寸/测量'});
  const input = { value:'alias', parentElement:{ querySelectorAll:()=>selects } };
  b.ctx.onDefectDescSelect(0,input);
  assert.equal(b.elements.get('defectsRows').innerHTML,before); assert.equal(input.value,'known defect');
  assert.deepEqual(selects.map(x=>x.value),['MIN 2.5','尺寸/测量']);
  assert.equal(b.json('_defectRows[0]').qty,3); assert.equal(b.elements.get('f_result').value,'PASS');
});


test('editing structured defects regenerates the summary and removing the last row clears it', () => {
  const b = browser(); b.element('f_defect', 'old defect3');
  b.run(`state.records=[{id:1,date:'2026-10-20',supplier:'Test Supplier',qty:3000,sampleQty:125,result:'PASS',status:'rejected',
    defect:'old defect3',defects:[{desc:'old defect',qty:3,level:'MIN 2.5'}]}];`);
  b.ctx.openEditModal(1); b.ctx._loadDefectRows([defect(2)]); b.ctx.saveRecord();
  assert.equal(b.json('state.records[0]').defect, 'synthetic defect2');
  b.ctx.openEditModal(1); b.ctx.removeDefectRow(0); b.ctx.saveRecord();
  assert.equal(b.json('state.records[0]').defect, ''); assert.deepEqual(b.json('state.records[0]').defects, []);
});

test('free-text legacy defect notes survive editing without structured rows', () => {
  const b = browser(); b.element('f_defect');
  b.run(`state.records=[{id:1,date:'2026-10-20',supplier:'Test Supplier',qty:3000,sampleQty:125,result:'PASS',status:'pending',defect:'legacy note'}];`);
  b.ctx.openEditModal(1); b.ctx.saveRecord(); assert.equal(b.json('state.records[0]').defect, 'legacy note');
});

test('continue entry retains supplier customer process product delivery number type and AQL but clears prior item values', () => {
  const b = browser();
  for (const [id,value] of Object.entries({ f_client:'Synthetic Client', f_processType:'Synthetic Process', f_productNo:'P-001',
    f_productName:'Prior Name', f_orderNo:'PO-OLD', f_deliveryNo:'DL-OLD', f_remark:'Prior Note', f_defect:'Prior Defect' })) b.element(id,value);
  b.ctx.getCustomerOptions=()=>['Synthetic Client']; b.ctx.getProcessTypeOptions=()=>['Synthetic Process'];
  b.ctx._loadDefectRows([defect(2)]); b.ctx.saveRecord({continueEntry:true});
  assert.equal(b.json('state.records[0]').processType, 'Synthetic Process');
  assert.equal(b.json('state.records[0]').deliveryNo, 'DL-OLD');
  for (const [id,value] of Object.entries({ f_supplier:'Test Supplier', f_client:'Synthetic Client', f_processType:'Synthetic Process',
    f_productNo:'P-001', f_deliveryNo:'DL-OLD', f_type:'成品', f_aqlLevel:'MAJ 0.65' })) assert.equal(b.elements.get(id).value, value);
  for (const id of ['f_productName','f_orderNo','f_remark','f_defect','f_qty','f_sampleQty']) assert.equal(b.elements.get(id).value, '');
  assert.deepEqual(b.json('_defectRows'), []); assert.deepEqual(b.json('_measRows'), []); assert.equal(b.json('editingId'), null);
});


test('measurement tolerance includes exact decimal boundaries without admitting real excess', () => {
  const b=browser();
  for (const value of ['2.25','2.35']) {
    assert.equal(b.ctx._inTol(value,'2.3','0.05'),true);
    assert.equal(b.ctx._autoJudgeMeas({standard:'2.3',tolerance:'0.05',values:[value]}),'PASS');
  }
  for (const value of ['2.2499999999','2.3500000001']) {
    assert.equal(b.ctx._inTol(value,'2.3','0.05'),false);
    assert.equal(b.ctx._autoJudgeMeas({standard:'2.3',tolerance:'0.05',values:[value]}),'FAIL');
  }
  assert.equal(b.ctx._autoJudgeMeas({measureType:'LW',standardL:'2.3',toleranceL:'0.05',lValues:['2.35'],standardW:'2.3',toleranceW:'0.05',wValues:['2.25']}),'PASS');
  assert.equal(b.ctx._autoJudgeMeas({measureType:'LW',standardL:'2.3',toleranceL:'0.05',lValues:['2.3500000001'],standardW:'2.3',toleranceW:'0.05',wValues:['2.25']}),'FAIL');
});

test('tolerance guard scales down and preserves exact zero, negative and missing tolerance behavior', () => {
  const b=browser();
  assert.equal(b.ctx._inTol('1.0500000001e-12','1e-12','5e-14'),false);
  assert.equal(b.ctx._inTol('-2.35','-2.3','0.05'),true);
  assert.equal(b.ctx._inTol('-2.3500000001','-2.3','0.05'),false);
  assert.equal(b.ctx._inTol('2.3','2.3','0'),true);
  assert.equal(b.ctx._inTol('2.3000000000000003','2.3','0'),false);
  assert.equal(b.ctx._inTol('2.3','2.3','-0.0000000001'),false);
  for (const args of [['2.3','2.3',''],['','2.3','0.05'],['2.3','','0.05'],['Infinity','2.3','0.05']])
    assert.equal(b.ctx._inTol(...args),null);
});
