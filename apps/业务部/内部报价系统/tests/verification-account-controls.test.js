'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/verification.js'), 'utf8');
const switchSource = source.slice(source.indexOf('async function switchFactory('), source.indexOf('function renderUserHeader('));
const apiSource = source.slice(source.indexOf('let authRedirectStarted'), source.indexOf('function requestText('));

function factoryPage({dirty = false, pending = {}, confirm = true, api, probe} = {}) {
  const writes = [], requests = [], destinations = [], alerts = [], confirmations = [];
  const content = {inert: false}, buttons = [{disabled: false}, {disabled: false}];
  const task = {quote: {id: 1}, sections: [{_draft: {note: 'unsaved draft'}}]};
  let headerRenders = 0;
  const location = {};
  Object.defineProperty(location, 'href', {set: value => destinations.push(value)});
  const context = {
    me: {active_factory_code: 'qingxi'}, taskState: task, sectionDirty: dirty,
    sectionSavePending: false, versionLoadPending: false, workshopSavePending: false,
    factorySwitchPending: false, ...pending,
    document: {querySelector: () => content}, window: {location},
    $: () => ({querySelectorAll: () => buttons}),
    confirm: message => { confirmations.push(message); return confirm; },
    alert: message => alerts.push(message),
    renderUserHeader: () => { headerRenders++; buttons.forEach(button => {button.disabled = false;}); },
    api: async (url, options) => {
      requests.push(url);
      if (options?.method === 'POST') {
        writes.push({url, data: JSON.parse(options.body)});
        return api?.();
      }
      return probe ? probe() : {active_factory_code: 'qingxi'};
    },
  };
  vm.createContext(context);
  vm.runInContext(switchSource, context);
  return {context, writes, requests, destinations, alerts, confirmations, content, buttons, task, headerRenders: () => headerRenders};
}

test('factory switch cancelled for unsaved changes preserves the draft and session', async () => {
  const p = factoryPage({dirty: true, confirm: false});
  await p.context.switchFactory('heyuan');
  assert.equal(p.confirmations.length, 1);
  assert.equal(p.writes.length, 0);
  assert.equal(p.destinations.length, 0);
  assert.equal(p.context.taskState, p.task);
  assert.equal(p.context.sectionDirty, true);
  assert.equal(p.content.inert, false);
});

test('factory switch is blocked during a department save, version read, workshop save or another switch', async () => {
  for (const flag of ['sectionSavePending', 'versionLoadPending', 'workshopSavePending', 'factorySwitchPending']) {
    const p = factoryPage({pending: {[flag]: true}});
    await p.context.switchFactory('heyuan');
    assert.equal(p.writes.length, 0, flag);
    assert.equal(p.destinations.length, 0, flag);
    assert.equal(p.context.taskState, p.task, flag);
  }
});

test('successful factory switch waits for acknowledgement, freezes the old detail and opens a fresh workspace', async () => {
  let complete;
  const gate = new Promise(resolve => {complete = resolve;});
  const p = factoryPage({dirty: true, api: () => gate});
  const switching = p.context.switchFactory('heyuan');
  assert.deepEqual(p.writes, [{url: '/auth/factory', data: {factory_code: 'heyuan'}}]);
  assert.equal(p.content.inert, true);
  assert.ok(p.buttons.every(button => button.disabled));
  assert.equal(p.context.versionLoadPending, true);
  assert.equal(p.context.sectionDirty, true);
  assert.equal(p.destinations.length, 0);
  await p.context.switchFactory('third-factory');
  assert.equal(p.writes.length, 1);
  complete();
  await switching;
  assert.deepEqual(p.destinations, ['./verification.html']);
  assert.equal(p.context.sectionDirty, false);
  assert.equal(p.content.inert, true, 'old detail remains inaccessible until page navigation');
  assert.equal(p.context.versionLoadPending, true);
});

test('failed factory switch retains the current draft and restores available controls', async () => {
  const p = factoryPage({dirty: true, api: async () => {throw new Error('factory unavailable');}});
  await p.context.switchFactory('heyuan');
  assert.deepEqual(p.alerts, ['factory unavailable']);
  assert.equal(p.destinations.length, 0);
  assert.equal(p.context.taskState, p.task);
  assert.equal(p.context.sectionDirty, true);
  assert.equal(p.content.inert, false);
  assert.equal(p.context.factorySwitchPending, false);
  assert.equal(p.context.versionLoadPending, false);
  assert.equal(p.headerRenders(), 1);
  assert.ok(p.buttons.every(button => !button.disabled));
  assert.deepEqual(p.requests, ['/auth/factory', '/auth/me']);
});

test('interrupted factory response cannot unlock old editors after the effective session has changed', async () => {
  const p = factoryPage({
    dirty: true,
    api: async () => {throw new SyntaxError('Unexpected end of JSON input');},
    probe: async () => ({active_factory_code: 'heyuan'}),
  });
  await p.context.switchFactory('heyuan');
  assert.deepEqual(p.requests, ['/auth/factory', '/auth/me']);
  assert.deepEqual(p.destinations, ['./verification.html']);
  assert.equal(p.content.inert, true);
  assert.ok(p.buttons.every(button => button.disabled));
  assert.equal(p.context.versionLoadPending, true);
  assert.equal(p.context.factorySwitchPending, true);
  assert.equal(p.context.sectionDirty, false);
  assert.equal(p.headerRenders(), 0);
});

test('unconfirmed session factory leaves editors locked and provides a refresh recovery path', async () => {
  for (const probe of [async () => {throw new Error('probe unavailable');}, async () => ({})]) {
    const p = factoryPage({dirty: true, api: async () => {throw new Error('connection interrupted');}, probe});
    await p.context.switchFactory('heyuan');
    assert.deepEqual(p.requests, ['/auth/factory', '/auth/me']);
    assert.equal(p.destinations.length, 0);
    assert.equal(p.context.taskState, p.task);
    assert.equal(p.context.sectionDirty, true);
    assert.equal(p.content.inert, true);
    assert.ok(p.buttons.every(button => button.disabled));
    assert.equal(p.context.versionLoadPending, true);
    assert.equal(p.context.factorySwitchPending, true);
    assert.equal(p.headerRenders(), 0);
    assert.match(p.alerts[0], /已暂停编辑.*浏览器刷新/);
  }
});

function authenticationPage(error) {
  const redirects = [];
  const context = {
    fetch: async () => ({status: 401, ok: false, json: async () => ({error})}),
    window: {location: {replace: url => redirects.push(url)}},
  };
  vm.createContext(context);
  vm.runInContext(apiSource, context);
  return {context, redirects};
}

test('incorrect current password stays on the workspace and reports the server validation error', async () => {
  const p = authenticationPage('当前密码错误');
  await assert.rejects(p.context.api('/auth/change-password', {method: 'POST'}), /当前密码错误/);
  assert.deepEqual(p.redirects, []);
});

test('expired password session and other unauthenticated requests still return to sign-in', async () => {
  for (const [url, error] of [['/auth/change-password', '未登录'], ['/auth/me', '当前密码错误']]) {
    const p = authenticationPage(error);
    await assert.rejects(p.context.api(url), /登录状态已失效/);
    assert.deepEqual(p.redirects, ['./index.html?next=verification']);
  }
});
