'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/verification.js'), 'utf8');
const start = source.indexOf('async function loadList(');
const end = source.indexOf('\nfunction cacheVersion(', start);
const basis = { data: { version: '2026-10-20' } };
const flush = () => new Promise(resolve => setImmediate(resolve));
function page(api) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {value: '', innerHTML: '', textContent: ''});
    return nodes.get(id);
  };
  const rendered = [];
  const context = {
    api, $: node, window: {}, listRequestSequence: 0, me: null,
    listState: [], workshopSelected: new Set(), workshopRevisions: new Map(),
    selectedQuoteId: null, esc: String,
    renderCostingBasis() { rendered.push({user: context.me, basis: context.costingBasisState}); },
    renderList() {}, selectTask() {},
  };
  context.window.VerificationCustomers = {display: String, options: names => names};
  vm.runInNewContext(source.slice(start, end), context);
  return {context, rendered};
}
test('initial basis render uses the authenticated administrator permissions', async () => {
  const admin = {role: 'admin', dept_name: '业务', username: 'test'};
  const p = page(async url => url === '/auth/me' ? admin : url === '/refs/costing_basis' ? basis : {rows: []});
  await p.context.loadList();
  assert.equal(p.rendered.length, 1);
  assert.equal(p.rendered[0].user, admin);
  assert.equal(p.rendered[0].basis, basis.data);
});
test('a stale basis response cannot overwrite a newer refresh or its user permissions', async () => {
  let release;
  let bases = 0;
  const p = page(async url => {
    if (url === '/refs/costing_basis') return ++bases === 1 ? new Promise(resolve => release = resolve) : basis;
    if (url === '/auth/me') return {role: bases === 0 ? 'staff' : 'admin'};
    return {rows: []};
  });
  const old = p.context.loadList();
  await flush();
  await p.context.loadList();
  release({data: {version: 'old'}});
  await old;
  assert.equal(p.rendered.length, 1);
  assert.equal(p.context.costingBasisState, basis.data);
  assert.equal(p.context.me.role, 'admin');
});
test('basis fetch failure clears stale data while retaining the authenticated task list', async () => {
  const p = page(async url => {
    if (url === '/refs/costing_basis') throw new Error('offline');
    return url === '/auth/me' ? {role: 'staff'} : {rows: []};
  });
  p.context.costingBasisState = {version: 'stale'};
  await p.context.loadList();
  assert.equal(p.context.costingBasisState, null);
  assert.equal(p.context.window.__costingBasis, null);
  assert.equal(p.rendered.length, 1);
});
