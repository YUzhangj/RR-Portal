const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const app = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(app, 'src/sections/DocEditor.tsx'), 'utf8');
const tree = ts.createSourceFile('DocEditor.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && node.arguments[1]?.getText(tree) === '[path, session?.id, session?.canEdit]') effect = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(tree); assert.ok(effect);
const effectJs = ts.transpileModule('(' + effect.getText(tree) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function open(file, exists, replayEffect = false, access = { readOnly: false }, canEdit = true) {
  const calls = [], values = {};
  const context = vm.createContext({ path: file, fileName: path.basename(file), dirtyRef: { current: false }, destroyedRef: { current: false }, CONTAINER_ID: 'test-editor',
    session: { id: 'synthetic-user', canEdit },
    api: { stat: async p => { calls.push(['stat', p]); if (!exists.includes(p)) throw Error('404'); return { mtime: 100, size: 1 }; }, fileUrl: p => p,
      editorAccess: async p => { calls.push(['access', p]); if (access instanceof Error) throw access; return access; } },
    fetch: async p => { calls.push(['fetch', p]); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; },
    ensureLuckysheet: async () => calls.push(['engine']),
    window: { LuckyExcel: { transformExcelToLucky: (_buf, cb) => cb({ sheets: [{}] }) }, luckysheet: { create: options => calls.push(['create', options]), destroy() {} } },
    setResolvedPath: p => { values.resolvedPath = p; }, setBaseMtime: n => { values.baseMtime = n; },
    setError: e => { values.error = e; }, setPhase: p => { values.phase = p; }, setAccess: value => { values.access = value; }, setDirty() {}, onDirtyChange() {},
    document: { getElementById: () => ({ addEventListener() {}, removeEventListener() {} }) }, markDirty() {},
  });
  const setup = vm.runInContext(effectJs, context);
  const cleanup = setup();
  // React StrictMode replays setup after cleanup on the same mounted refs.
  if (replayEffect) { cleanup(); setup(); }
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  return { calls, values };
}

test('legacy XLS redirects to its same-directory xlsx and obtains the xlsx conflict timestamp', async () => {
  const { calls, values } = await open('客户/2026/资料/排模表.XLS', ['客户/2026/资料/排模表.xlsx']);
  assert.equal(values.resolvedPath, '客户/2026/资料/排模表.xlsx');
  assert.equal(values.phase, 'ready'); assert.equal(values.baseMtime, 100);
  assert.deepEqual(calls.filter(c => c[0] === 'fetch'), [['fetch', '客户/2026/资料/排模表.xlsx']]);
});
test('xlsx opens directly and a missing sibling preserves the unsupported legacy error', async () => {
  const normal = await open('客户/排模表.XLSX', ['客户/排模表.XLSX']);
  assert.equal(normal.values.phase, 'ready');
  assert.deepEqual(normal.calls.filter(c => c[0] === 'stat'), [['stat', '客户/排模表.XLSX']]);
  const missing = await open('客户/排模表.xls', ['客户/排模表.xls']);
  assert.equal(missing.values.phase, 'error'); assert.match(missing.values.error, /旧版.*xls/);
  assert.ok(!missing.calls.some(c => c[0] === 'engine' || c[0] === 'fetch'));
});
test('other document types never enter the Excel resolver or workbook parser', async () => {
  for (const file of ['客户/生产注意事项.pdf', '客户/排模表.xlsm']) {
    const result = await open(file, [file]); assert.equal(result.values.phase, 'error');
    assert.deepEqual(result.calls, []);
  }
});

test('editor still initializes after StrictMode cleanup replays its effect', async () => {
  const result = await open('客户/排模表.xlsx', ['客户/排模表.xlsx'], true);
  assert.equal(result.values.phase, 'ready');
  assert.equal(result.calls.filter(c => c[0] === 'create').length, 1);
});

test('editor is read-only for readers, controlled documents, or failed access checks', async () => {
  for (const [access, canEdit] of [[{ readOnly: false }, false], [{ readOnly: true, reason: '历史受控资料只读' }, true], [new Error('offline'), true]]) {
    const result = await open('客户/排模表.xlsx', ['客户/排模表.xlsx'], false, access, canEdit);
    assert.equal(result.values.phase, 'ready');
    const options = result.calls.find(c => c[0] === 'create')[1];
    assert.equal(options.allowEdit, false);
    assert.equal(options.enableAddRow, false);
    assert.equal(options.showtoolbar, false);
    if (access instanceof Error) assert.equal(result.values.access.readOnly, true);
  }
});

test('historical protection uses a read-only explanation without hiding corrupt-record errors', async () => {
  const historical = await open('客户/排模表.xlsx', ['客户/排模表.xlsx'], false, { readOnly: true, reason: '编辑锁已失效或属于其他窗口，请重新读取并获取锁' });
  assert.equal(historical.values.access.reason, '历史受控资料已保留，当前界面仅供查看');
  const damaged = await open('客户/排模表.xlsx', ['客户/排模表.xlsx'], false, { readOnly: true, reason: '单据记录损坏，原资料已保留' });
  assert.equal(damaged.values.access.reason, '单据记录损坏，原资料已保留');
});

// Extract actual read-only route dependencies and handler, rather than reimplement selection.
const server = fs.readFileSync(path.join(app, 'vite-plugin-docs-api.ts'), 'utf8');
const source = ts.createSourceFile('plugin.ts', server, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declarations = source.statements.filter(n => ts.isFunctionDeclaration(n) && ['resolveSafe', 'walk'].includes(n.name?.text)).map(n => n.getText(source));
const routes = source.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(source) === 'routes').declarationList.declarations[0].initializer;
const route = routes.properties.find(n => n.name.getText(source) === '"/api/doctypes"');
const handler = route.initializer.properties.find(n => n.name.getText(source) === 'handler').initializer.getText(source);
const routeJs = ts.transpileModule(declarations.join('\n') + '\n globalThis.handler = ' + handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('actual doctypes route prefers xlsx case-insensitively while retaining legacy fallback and traversal guard', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-legacy-path-'));
  try {
    const project = '客户/2026/项目';
    for (const name of ['a/排模表.xls', 'b/排模表.XLSX', 'a/排模图.xls']) {
      const p = path.join(root, project, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'synthetic');
    }
    let result;
    const context = vm.createContext({ fs, fsp, path, SKIP_DIRS: new Set(), json: (_res, status, body) => { result = { status, body }; } });
    vm.runInContext(routeJs, context);
    await context.handler({ res: {}, url: new URL('http://local/api/doctypes?project=' + encodeURIComponent(project)), root, projectRoot: root });
    assert.equal(result.status, 200);
    assert.equal(result.body.items.find(i => i.name === '排模表').existing, 'b/排模表.XLSX');
    assert.equal(result.body.items.find(i => i.name === '排模图').existing, 'a/排模图.xls');
    await context.handler({ res: {}, url: new URL('http://local/api/doctypes?project=../outside'), root, projectRoot: root });
    assert.ok(result.body.items.every(i => i.existing === null));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
