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

function browser() {
  const nodes = Object.fromEntries(['qcMaintenance','qcMaintenanceTitle','qcMaintenanceMessage','qcMaintenanceRefresh','appWrapper','loginScreen']
    .map(id => [id, { id, hidden: false, textContent: '', inert: false }]));
  nodes.qcMaintenance.contains = target => target === nodes.qcMaintenance;
  const events = {}, calls = [], storage = { pendingDraft: 'original draft' };
  let enabled = false, failed = false, poll, reloads = 0;
  const s = { window: { addEventListener() {} }, location: { pathname: '/qc/index.html', reload() { reloads++; } },
    AbortController, setTimeout() { return 1; }, clearTimeout() {}, setInterval(fn) { poll = fn; },
    document: { getElementById: id => nodes[id], addEventListener(name, fn) { (events[name] ||= []).push(fn); } },
    localStorage: { removeItem() { throw new Error('must not clear drafts'); }, getItem: key => storage[key] },
    fetch: async (url, options) => { calls.push({url,options}); if (failed) throw new Error('offline'); return {ok:true,json:async()=>({enabled})}; },
  };
  vm.createContext(s); vm.runInContext(client, s);
  return { s, nodes, events, storage, calls, get reloads() {return reloads;},
    set enabled(value) { enabled = value; }, set failed(value) { failed = value; },
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
test('loss of status connection prevents further operations until a healthy status is available', async () => {
  const b = browser(); await tick(); b.failed = true; b.poll(); await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, true);
  assert.equal(b.nodes.qcMaintenanceTitle.textContent, '暂时无法连接系统');
  b.failed = false; b.poll(); await tick();
  assert.equal(b.s.window.__QC_MAINTENANCE.blocked, false);
  assert.equal(b.nodes.qcMaintenance.hidden, true);
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
