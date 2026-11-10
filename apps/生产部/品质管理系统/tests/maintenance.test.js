'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const Auth = require('../server/auth');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/server.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'maintenance.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a request body cannot pass its write boundary after maintenance is enabled', async () => {
  const start = server.indexOf('function readBody(req)');
  const end = server.indexOf('\nfunction ', start + 1);
  const sandbox = { Auth, maintenanceState: () => ({ enabled: true, message: '系统修复中' }) };
  vm.createContext(sandbox); vm.runInContext(server.slice(start, end), sandbox);
  const req = new EventEmitter();
  const pending = sandbox.readBody(req);
  req.emit('data', Buffer.from('{"records":[]}')); req.emit('end');
  await assert.rejects(pending, error => error.status === 503 && /修复中/.test(error.message));
});

function browser({ legacy = false, initialFailed = false } = {}) {
  const nodes = Object.fromEntries(['qcMaintenance','qcMaintenanceRetry','qcMaintenanceTitle','qcMaintenanceMessage','qcMaintenanceRefresh','qcConnectionNotice','qcConnectionRetry','appWrapper','loginScreen']
    .map(id => [id, { id, hidden: false, textContent: '', inert: false }]));
  if (legacy) ['qcMaintenanceRetry','qcConnectionNotice','qcConnectionRetry'].forEach(id=>delete nodes[id]);
  nodes.qcMaintenance.contains = target => Object.values(nodes).some(node =>
    node === target && node.id.startsWith('qcMaintenance'));
  const events = {}, calls = [], storage = { pendingDraft: 'original draft' };
  let enabled = false, failed = initialFailed, response = null, poll, reloads = 0;
  const s = { window: { addEventListener() {} }, location: { pathname: '/qc/index.html', reload() { reloads++; } },
    AbortController, setTimeout() { return 1; }, clearTimeout() {}, setInterval(fn) { poll = fn; },
    document: { activeElement: null, getElementById: id => nodes[id] || null, addEventListener(name, fn) { (events[name] ||= []).push(fn); } },
    localStorage: { removeItem() { throw new Error('must not clear drafts'); }, getItem: key => storage[key] },
    fetch: async (url, options) => { calls.push({url,options}); if (failed) throw new Error('offline'); return response || {ok:true,json:async()=>({enabled})}; },
  };
  Object.values(nodes).forEach(node => { node.focus = () => { s.document.activeElement = node; }; });
  vm.createContext(s); vm.runInContext(client, s);
  return { s, nodes, events, storage, calls, get reloads() {return reloads;},
    set enabled(value) { enabled = value; }, set failed(value) { failed = value; },
    set response(value) { response = value; },
    poll: () => poll(),
  };
}
test('maintenance locks existing UI, preserves drafts and requires deliberate refresh after recovery', async () => {
  const b = browser(); await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, false);
  assert.equal(b.nodes.qcMaintenance.hidden, true);
  b.enabled = true; b.poll(); await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, true);
  assert.equal(b.nodes.appWrapper.inert, true);
  assert.equal(b.nodes.loginScreen.inert, true);
  assert.equal(b.nodes.qcMaintenanceTitle.textContent, '系统修复中');
  let prevented = 0;
  for (const name of ['click','submit','keydown']) b.events[name][0]({ target:b.nodes.appWrapper, preventDefault(){prevented++;},stopImmediatePropagation(){} });
  assert.equal(prevented, 3);
  b.enabled = false; b.poll(); await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, true);
  assert.equal(b.nodes.qcMaintenanceTitle.textContent, '修复已完成');
  assert.equal(b.nodes.qcMaintenanceRefresh.hidden, false);
  assert.equal(b.reloads, 0);
  assert.equal(b.storage.pendingDraft, 'original draft');
  assert.ok(b.calls.every(call => call.url === '/qc/api/maintenance' && call.options.cache === 'no-store'));
});

test('retry checks the connection without refreshing or discarding the current form', async () => {
  const b = browser(); b.events.DOMContentLoaded.forEach(fn=>fn()); await tick();
  b.failed = true; b.poll(); await tick();
  assert.equal(b.nodes.qcConnectionNotice.hidden,false);
  assert.equal(b.nodes.qcMaintenance.hidden,true);
  assert.equal(b.nodes.qcMaintenanceRefresh.hidden,true);
  const count=b.calls.length;
  b.failed=false; b.nodes.qcConnectionRetry.onclick();
  b.nodes.qcConnectionRetry.onclick(); // A double click must not start another request.
  assert.equal(b.nodes.qcConnectionRetry.disabled,true);
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked,true);
  await tick();
  assert.equal(b.calls.length,count+1);
  assert.equal(b.nodes.qcMaintenance.hidden,true);
  assert.equal(b.nodes.appWrapper.inert,false);
  assert.equal(b.reloads,0);
  assert.equal(b.storage.pendingDraft,'original draft');
});

test('Tab reaches Retry from outside the locked UI without enabling business operations', async () => {
  const b = browser({ initialFailed: true }); b.events.DOMContentLoaded.forEach(fn => fn()); await tick();
  let prevented = 0, stopped = 0;
  const outside = { target: b.nodes.loginScreen, key: 'Tab',
    preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } };
  b.events.keydown[0](outside);
  assert.equal(b.s.document.activeElement, b.nodes.qcMaintenanceRetry);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  assert.equal(b.nodes.appWrapper.inert, true);
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, true);
  // The guard must allow the focused control's normal keyboard activation.
  b.events.keydown[0]({ ...outside, target: b.nodes.qcMaintenanceRetry, key: 'Enter' });
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  b.failed = false; b.nodes.qcMaintenanceRetry.onclick();
  assert.equal(b.nodes.qcMaintenanceRetry.disabled, true);
  b.s.document.activeElement = null;
  b.events.keydown[0](outside);
  assert.equal(b.s.document.activeElement, null, 'a disabled retry must not receive focus');
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, true);
  await tick();
  assert.equal(b.nodes.qcMaintenance.hidden, true);
  assert.equal(b.nodes.appWrapper.inert, false);
  assert.equal(b.reloads, 0);
  assert.equal(b.storage.pendingDraft, 'original draft');
});

test('Tab reaches deliberate Refresh after maintenance ends, but does not refresh automatically', async () => {
  const b = browser(); b.events.DOMContentLoaded.forEach(fn => fn()); await tick();
  b.enabled = true; b.poll(); await tick();
  const tab = { target: b.nodes.appWrapper, key: 'Tab', preventDefault() {}, stopImmediatePropagation() {} };
  b.events.keydown[0](tab);
  assert.equal(b.s.document.activeElement, null, 'hidden actions cannot receive focus during maintenance');
  b.enabled = false; b.poll(); await tick();
  b.events.keydown[0](tab);
  assert.equal(b.s.document.activeElement, b.nodes.qcMaintenanceRefresh);
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, true);
  assert.equal(b.reloads, 0);
  b.nodes.qcMaintenanceRefresh.onclick();
  assert.equal(b.reloads, 1);
  assert.equal(b.storage.pendingDraft, 'original draft');
});

test('new maintenance client remains safe with cached HTML that has no Retry button', async () => {
  const b = browser({ legacy: true });
  assert.doesNotThrow(() => b.events.DOMContentLoaded.forEach(fn => fn()));
  await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, false);
  b.failed = true; b.poll(); await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, true);
  assert.equal(b.nodes.appWrapper.inert, true);
  assert.equal(b.nodes.qcMaintenanceTitle.textContent, '暂时无法连接系统');
  b.failed = false; b.poll(); await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, false);
  assert.equal(b.nodes.qcMaintenance.hidden, true);
  b.enabled = true; b.poll(); await tick();
  b.enabled = false; b.poll(); await tick();
  assert.equal(b.nodes.qcMaintenanceRefresh.hidden, false);
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, true);
  assert.equal(b.reloads, 0);
  b.nodes.qcMaintenanceRefresh.onclick();
  assert.equal(b.reloads, 1);
  assert.equal(b.storage.pendingDraft, 'original draft');
});

test('gateway maintenance HTML remains a maintenance lock until deliberate refresh after recovery', async () => {
  const b = browser(); await tick();
  b.response={ok:false,status:503,headers:{get:key=>key==='Retry-After'?'60':null},json(){throw new Error('HTML must not be parsed');}};
  b.poll(); await tick();
  assert.equal(b.nodes.qcMaintenanceTitle.textContent,'系统修复中');
  assert.equal(b.nodes.qcMaintenanceRetry.hidden,true);
  assert.equal(b.nodes.appWrapper.inert,true);
  b.response=null; b.poll(); await tick();
  assert.equal(b.nodes.qcMaintenanceTitle.textContent,'修复已完成');
  assert.equal(b.nodes.qcMaintenanceRefresh.hidden,false);
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked,true);
  assert.equal(b.reloads,0);
});
test('repeated status failures pause writes without masking or intercepting an existing form', async () => {
  const b = browser(); await tick(); b.failed = true; b.poll(); await tick();
  b.poll(); await tick(); b.poll(); await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, true);
  assert.equal(b.nodes.qcMaintenance.hidden,true);
  assert.equal(b.nodes.qcConnectionNotice.hidden,false);
  assert.equal(b.nodes.appWrapper.inert,false);
  let prevented=0;
  for (const name of ['click','keydown']) b.events[name][0]({target:b.nodes.appWrapper,preventDefault(){prevented++;},stopImmediatePropagation(){}});
  assert.equal(prevented,0);
  assert.match(b.s.window.__QC_MAINTENANCE.message,/保存已暂停/);
  b.failed = false; b.poll(); await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, false);
  assert.equal(b.nodes.qcMaintenance.hidden, true);
  assert.equal(b.nodes.qcConnectionNotice.hidden,true);
  assert.equal(b.reloads,0);
  assert.equal(b.storage.pendingDraft,'original draft');
});

test('an unknown initial status still blocks the page; confirmed maintenance immediately replaces the small notice', async () => {
  const first=browser({initialFailed:true}); await tick();
  assert.equal(first.nodes.qcMaintenance.hidden,false);
  assert.equal(first.nodes.appWrapper.inert,true);
  assert.equal(first.nodes.qcConnectionNotice.hidden,true);
  const b=browser(); await tick(); b.failed=true; b.poll(); await tick();
  b.failed=false; b.enabled=true; b.poll(); await tick();
  assert.equal(b.nodes.qcMaintenance.hidden,false);
  assert.equal(b.nodes.qcMaintenanceTitle.textContent,'系统修复中');
  assert.equal(b.nodes.qcConnectionNotice.hidden,true);
  assert.equal(b.nodes.appWrapper.inert,true);
  b.failed=true; b.poll(); await tick();
  assert.equal(b.nodes.qcMaintenanceTitle.textContent,'系统修复中');
  assert.equal(b.nodes.qcMaintenance.hidden,false);
});

test('record save stops before reading or changing the form when connection checks have paused writes', () => {
  const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  const start=app.indexOf('function saveRecord('),end=app.indexOf('\nfunction ',start+1);
  const messages=[],s={window:{__QC_MAINTENANCE:{blocked:true,message:'连接中断，保存已暂停，请重试'}},showToast:m=>messages.push(m)};
  vm.createContext(s);vm.runInContext(app.slice(start,end),s);
  assert.equal(s.saveRecord(),false);
  assert.deepEqual(messages,['连接中断，保存已暂停，请重试']);
});

test('maintenance blocks local persistence and retry before they can overwrite an existing pending draft', async () => {
  const prefix = 'xingxin_qms_dg-xingxin_';
  const store = new Map([[prefix+'records', '{"records":[],"nextId":31}'], [prefix+'pending_records_tester','original pending draft'], [prefix+'users','[]']]);
  const before = [...store], callbacks = [];
  let writes = 0, requests = 0;
  const guard = {blocked:true,activate(){}};
  const s = { window:{__QC_MAINTENANCE:guard,persist(){writes++;}}, location:{pathname:'/qc/'}, console:{log(){},warn(){}},
    localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)},
    document:{getElementById:()=>null,addEventListener:(_name,fn)=>callbacks.push(fn)},setTimeout(){},
    XMLHttpRequest:class {open(){} send(){this.status=503;} getResponseHeader(){return '1';}},
    fetch(){requests++;throw new Error('must not send');},
  };
  vm.createContext(s); vm.runInContext(fs.readFileSync(path.join(root,'qc-backend.js'),'utf8'),s);
  s.window.__QC_AUTH={user:{username:'tester'},company:'dg-xingxin',csrfToken:'synthetic'};
  callbacks.forEach(callback=>callback());
  assert.equal(s.window.persist(),false);
  assert.equal(await s.window.__QC_SYNC_NOW(),false);
  await assert.rejects(s.window.__QC_REQUEST('/api/records',{method:'POST'}),/修复中/);
  assert.equal(writes,0);assert.equal(requests,0);assert.deepEqual([...store],before);
});
