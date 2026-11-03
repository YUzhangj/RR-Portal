const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

async function load() {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/api.ts'), 'utf8');
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'));
}

test('anonymous and read-only generic writes reject before fetch or XHR', async () => {
  const { api, setApiSession } = await load();
  const previousFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => { requests++; throw Error('unexpected request'); };
  try {
    for (const session of [null, { id: 'reader', name: 'Synthetic reader', canRead: true, canEdit: false, canReview: false }]) {
      setApiSession(session);
      for (const action of [() => api.mkdir('x'), () => api.rename('x', 'y'), () => api.remove('x'),
        () => api.batchDelete(['x']), () => api.createProject('A', '2026', 'P'), () => api.copyTemplate('a', 'b', 'c'),
        () => api.restore('fixture'), () => api.purge('fixture'), () => api.upload('x', new File(['x'], 'x.xlsx'))])
        await assert.rejects(action(), /只读/);
    }
    assert.equal(requests, 0);
  } finally { setApiSession(null); global.fetch = previousFetch; }
});

test('personal login keeps same-origin cookies and the request marker without a browser Bearer', async () => {
  const { api } = await load();
  const previous = global.fetch;
  let observed;
  global.fetch = async (url, options) => {
    observed = { url, options };
    return { ok: true, json: async () => ({ id: 'editor', name: 'Synthetic editor', canRead: true, canEdit: true, canReview: false }) };
  };
  try {
    await api.epmsLogin('synthetic-user', 'synthetic-password');
    assert.equal(observed.url, 'api/epms/login');
    assert.deepEqual(JSON.parse(observed.options.body), { username: 'synthetic-user', password: 'synthetic-password' });
    assert.equal(observed.options.headers.get('X-EPMS-Request'), '1');
    assert.equal(observed.options.headers.has('Authorization'), false);
    assert.equal(observed.options.credentials, 'same-origin');
  } finally { global.fetch = previous; }
});

test('legacy uploads retain conflict timestamps without sending a removed workbench lock token', async () => {
  const { api, setApiSession } = await load();
  setApiSession({ id: 'editor', name: 'Synthetic editor', canRead: true, canEdit: true, canReview: false });
  const previous = global.XMLHttpRequest;
  let xhr;
  global.XMLHttpRequest = class {
    constructor() { xhr = this; this.upload = {}; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send() { this.status = 200; this.responseText = '{"ok":true,"name":"x.xlsx"}'; this.onload(); }
  };
  try {
    await api.upload('A/2026/P', new File(['fixture'], '排模表.xlsx'), undefined, { overwrite: true, baseMtime: 123 });
    assert.equal(xhr.headers['X-EPMS-Request'], '1');
    assert.equal(xhr.headers['X-EPMS-Lock-Token'], undefined);
    assert.ok(xhr.url.includes('baseMtime=123') && xhr.url.includes('overwrite=1'));
  } finally { global.XMLHttpRequest = previous; setApiSession(null); }
});

test('editor access is an escaped read-only GET and API errors retain HTTP status', async () => {
  const { api } = await load();
  const previous = global.fetch;
  let observed;
  global.fetch = async (url, options) => {
    observed = { url, options };
    return { ok: true, json: async () => ({ readOnly: true, reason: '历史受控资料只读' }) };
  };
  try {
    assert.equal((await api.editorAccess('A/2026/资料.xlsx')).readOnly, true);
    assert.equal(observed.url, 'api/editor-access?path=' + encodeURIComponent('A/2026/资料.xlsx'));
    assert.equal(observed.options.headers.has('X-EPMS-Request'), false);
    global.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'synthetic core unavailable' }) });
    await assert.rejects(api.epmsSession(), error => error.status === 503 && error.message === 'synthetic core unavailable');
  } finally { global.fetch = previous; }
});
