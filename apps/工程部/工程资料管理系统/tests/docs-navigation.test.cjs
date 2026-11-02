const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['allowLeaveEditor', 'navigate', 'goPath', 'openEditor'].includes(node.name.getText(tree)))
    callbacks[node.name.getText(tree)] = ts.transpileModule('(' + node.initializer.arguments[0].getText(tree) + ')', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
  ts.forEachChild(node, visit);
}
visit(tree);

test('all header navigation preserves a dirty editor when the user cancels leaving', () => {
  const state = [], back = { current: { type: 'clients' } };
  const scope = vm.createContext({ view: { type: 'editor', path: 'old.xlsx' }, editorDirty: true,
    editorBackRef: back, setView: value => state.push(value), window: { confirm: () => false } });
  scope.allowLeaveEditor = vm.runInContext(callbacks.allowLeaveEditor, scope);
  vm.runInContext(callbacks.navigate, scope)({ type: 'trash' });
  vm.runInContext(callbacks.goPath, scope)('another/path');
  vm.runInContext(callbacks.openEditor, scope)('another.xlsx', 'another.xlsx');
  assert.equal(state.length, 0);
  assert.equal(back.current.type, 'clients');
  scope.window.confirm = () => true;
  vm.runInContext(callbacks.navigate, scope)({ type: 'clients' });
  assert.equal(state.length, 1);
  assert.equal(state[0].type, 'clients');
});

test('clean or non-editor views navigate without an unsaved prompt', () => {
  for (const [view, editorDirty] of [[{ type: 'editor' }, false], [{ type: 'clients' }, true]]) {
    let prompts = 0, next;
    const scope = vm.createContext({ view, editorDirty, setView: value => { next = value; }, window: { confirm: () => { prompts++; return false; } } });
    scope.allowLeaveEditor = vm.runInContext(callbacks.allowLeaveEditor, scope);
    vm.runInContext(callbacks.navigate, scope)({ type: 'recent' });
    assert.equal(next.type, 'recent'); assert.equal(prompts, 0);
  }
});
