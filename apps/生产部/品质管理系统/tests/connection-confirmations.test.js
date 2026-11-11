"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf('function '+name+'(');
  if (start < 0) return '';
  const end = source.indexOf('\n}', start)+2;
  return source.slice(start, end);
}
function harness({blocked=false, persistResult=true, replacement=false}={}) {
  const messages=[], effects=[], timers=[], button={disabled:false,textContent:'确认导入 1 条'};
  const s={state:{records:[{id:1,value:'original'}],nextId:7},
    _batchRows:[{value:'preview'}],_pendingImportPlan:{mode:replacement?'replace':'append',records:[{id:2,value:'preview'}],nextId:8},
    SEED_RECORDS:[{id:3,value:'seed'}],currentPage:'records',console:{error(){}},
    __QC_MAINTENANCE:{blocked,message:'连接中断，保存已暂停，请重试'},
    document:{getElementById:()=>button},
    showToast:(...args)=>messages.push(args),
    persist(){effects.push('persist');if(s.__QC_MAINTENANCE.blocked)return false;return persistResult;},
    _newRecordId:()=>2,recs:()=>s.state.records,
    _backupConfirm:options=>{s.confirm=options.onConfirm;},
    setTimeout:fn=>timers.push(fn),
  };
  s.window=s;
  ['closeModalDirect','renderRecordsTable','updateTopKpis','renderDashboard','renderAnalysis','renderSuppliers','renderSupplierDatalist','_backupLog','_backupRefreshAll','_closeImportConfirmPreview','importReset','showPage'].forEach(name=>s[name]=()=>effects.push(name));
  vm.createContext(s);
  for(const name of ['_recordWritesPaused','_stageRecordChange','confirmBatchImport','executeImportConfirm','backupClearAll','backupRestoreSeed']) vm.runInContext(functionSource(name),s);
  return {s,messages,effects,timers,button};
}
const operations={
  batch:s=>s.confirmBatchImport(),
  append:s=>s.executeImportConfirm(),
  replace:s=>s.executeImportConfirm(),
  clear:s=>{s.backupClearAll();s.__QC_MAINTENANCE.blocked=true;return s.confirm();},
  restore:s=>{s.backupRestoreSeed();s.__QC_MAINTENANCE.blocked=true;return s.confirm();},
};
for (const [name,run] of Object.entries(operations)) {
  test(name+' confirmation after disconnect preserves records, preview and replace intent until explicit retry',()=>{
    const b=harness({blocked:!['clear','restore'].includes(name),replacement:name==='replace'}),s=b.s;
    const original=s.state.records, rows=s._batchRows, plan=s._pendingImportPlan;
    run(s);
    assert.equal(s.state.records,original);assert.equal(s.state.nextId,7);
    assert.equal(s._batchRows,rows);assert.equal(s._pendingImportPlan,plan);
    assert.equal(Object.hasOwn(s,'__QC_FORCE_REPLACE'),false);
    assert.equal(b.effects.length,0);assert.equal(b.timers.length,0);
    assert.equal(b.button.disabled,false);assert.ok(b.messages.some(([m])=>m.includes('保存已暂停')));
    s.__QC_MAINTENANCE.blocked=false;
    assert.equal(b.effects.length,0,'recovery alone never retries');
    if(name==='clear'||name==='restore')s.confirm();else run(s);
    assert.equal(b.effects.filter(x=>x==='persist').length,1);
    assert.equal(s.state.records.length,name==='clear'?0:name==='replace'||name==='restore'?1:2);
    assert.ok(b.messages.some(([m])=>m.includes('已在本地暂存')));
  });
}
for(const name of Object.keys(operations)) {
  test(name+' rejected persistence rolls back all local intent and does not clear its preview',()=>{
    const b=harness({persistResult:false,replacement:name==='replace'}),s=b.s;
    s.__QC_FORCE_REPLACE=9;
    const original=s.state.records,rows=s._batchRows,plan=s._pendingImportPlan;
    if(name==='clear'||name==='restore'){s[name==='clear'?'backupClearAll':'backupRestoreSeed']();s.confirm();}else operations[name](s);
    assert.equal(s.state.records,original);assert.equal(s.state.nextId,7);
    assert.equal(s.__QC_FORCE_REPLACE,9);assert.equal(s._batchRows,rows);assert.equal(s._pendingImportPlan,plan);
    assert.deepEqual(b.effects,['persist']);assert.equal(b.timers.length,0);assert.equal(b.button.disabled,false);
    assert.ok(!b.messages.some(([m])=>m.includes('已在本地暂存')));
  });
}
test('backup confirmation stays open on rejected callback and closes after accepted retry',()=>{
  let confirmed=false,closed=0;
  const nodes={bkCancelBtn:{},bkConfirmBtn:{}};
  const ov={classList:{remove(){closed++;}},addEventListener(){},remove(){}};
  const s={document:{getElementById:id=>nodes[id]||null,createElement:()=>ov,body:{appendChild(){}}},setTimeout(){}};
  vm.createContext(s);vm.runInContext(functionSource('_backupConfirm'),s);
  s._backupConfirm({onConfirm:()=>confirmed});
  nodes.bkConfirmBtn.onclick();assert.equal(closed,0);
  confirmed=true;nodes.bkConfirmBtn.onclick();assert.equal(closed,1);
});
