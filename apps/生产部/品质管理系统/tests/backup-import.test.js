'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the real import handlers without booting the app or opening its database.
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const section = app.indexOf('   ② 导入 JSON 备份');
assert.ok(section >= 0, 'backup import section exists');
const start = app.lastIndexOf('/*', section);
const end = app.indexOf('function backupClearAll()', section);
assert.ok(end > start, 'backup import section has an end');
function namedFunction(name) {
  const begin = app.indexOf(`function ${name}(`);
  assert.ok(begin >= 0, `${name} exists`);
  const next = app.indexOf('\nfunction ', begin + 1);
  assert.ok(next > begin, `${name} has a following function boundary`);
  return app.slice(begin, next);
}
const importSource = app.slice(start, end) + '\n' + namedFunction('_esc') + '\n' + namedFunction('_startImport');
const clone = value => JSON.parse(JSON.stringify(value));
const stamp = '2026-11-09T08:00:00.000Z';

function record(id = 101, changes = {}) {
  return { id, date: '2026-11-09', supplier: '测试供应商', qty: 20,
    updatedAt: stamp, status: 'pending', ...changes };
}

function draft(records = [record()], changes = {}) {
  return { owner: '测试检验员', company: 'dg-xingxin', revision: 16,
    token: 'test-draft', state: { records, nextId: 1000 }, deletedIds: [],
    deleteRevisions: {}, nextDeleteRevision: 0, replacement: false, ...changes };
}

function harness(options = {}) {
  const notices = [], logs = [], confirmations = [];
  let saved = 0, refreshed = 0, selectedMode = 'append';
  const user = { username: 'jc', role: 'admin', enabled: true };
  const window = { __QC_COMPANY: options.company || 'dg-xingxin',
    __QC_DRAFT_RECOVERY_BLOCKED: !!options.blocked,
    __QC_AUTH: { company: options.company || 'dg-xingxin', user } };
  const sandbox = {
    window,
    state: { records: clone(options.records || []), nextId: 31 },
    can: () => options.allowed !== false && !window.__QC_DRAFT_RECOVERY_BLOCKED,
    getCompany: () => window.__QC_COMPANY,
    getCurrentUser: () => user,
    nowIso: () => stamp,
    recs: () => sandbox.state.records,
    persist: () => {
      saved++;
      if (options.persistError) throw new Error(options.persistError);
      return options.persistResult !== false;
    },
    showToast: (message, type) => notices.push({ message, type }),
    _backupLog: (message, type) => logs.push({ message, type }),
    _backupRefreshAll: () => { refreshed++; },
    _backupConfirm: options => confirmations.push(options),
    _showFatalError: message => notices.push({ message, type: 'error' }),
    _newRecordId: used => {
      let id = 9000;
      while (used.has(id)) id++;
      used.add(id);
      return id;
    },
    document: { querySelector: () => ({ value: selectedMode }) },
    FileReader: class {
      readAsText(file) { this.onload({ target: { result: file.text } }); }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(importSource, sandbox, { filename: 'app.js:backup-import' });
  return {
    sandbox, window, notices, logs, confirmations,
    get saved() { return saved; },
    get refreshed() { return refreshed; },
    get records() { return clone(sandbox.state.records); },
    load(payload, prefix = '') {
      const input = { files: [{ name: 'selected.json', text: prefix + JSON.stringify(payload) }], value: 'selected.json' };
      sandbox.backupImportJSON({ target: input });
      assert.equal(input.value, '', 'file input permits reselecting the same file');
    },
    route(payload, name = 'pending.JSON') {
      sandbox._startImport({ name, text: JSON.stringify(payload) });
    },
    confirm(mode = 'append') {
      assert.ok(confirmations.length, 'valid input presents a confirmation');
      selectedMode = mode;
      confirmations.at(-1).onConfirm();
    },
  };
}

test('existing array and records-package formats still import, including UTF-8 BOM', () => {
  for (const payload of [[record()], { version: 1, records: [record()], exportedAt: stamp }]) {
    const h = harness();
    h.load(payload, '\uFEFF');
    h.confirm();
    assert.equal(h.records.length, 1);
    assert.equal(h.records[0].id, 101);
    assert.equal(h.saved, 1);
  }
});

test('an exported pending draft without a baseline is recognized and appended', () => {
  const h = harness({ records: [record(100)] });
  h.load(draft());
  h.confirm();
  assert.deepEqual(h.records.map(row => row.id), [100, 101]);
  assert.equal(h.saved, 1);
  assert.equal(h.window.__QC_FORCE_REPLACE, undefined);
});

test('the main file-picker/drop route accepts JSON without loading the Excel library', () => {
  const h = harness();
  assert.equal(typeof h.sandbox.XLSX, 'undefined');
  h.route(draft());
  h.confirm();
  assert.equal(h.saved, 1);
  assert.deepEqual(h.records.map(row => row.id), [101]);
  assert.equal(h.notices.filter(entry => entry.type === 'error').length, 0);
});

test('draft owner names are escaped in the confirmation HTML', () => {
  const h = harness();
  h.load(draft([record()], { owner: '<img src=x onerror="alert(1)">' }));
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0].body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(h.confirmations[0].body, /<img/);
});

test('draft deletion/replacement metadata cannot delete or replace existing data', () => {
  const h = harness({ records: [record(100)] });
  h.load(draft([record()], { deletedIds: [100], replacement: true }));
  assert.equal(h.confirmations.length, 1);
  assert.doesNotMatch(h.confirmations[0].body, /value=["']replace["']/);
  h.confirm('replace'); // A stale or tampered mode must not turn a draft into a full replacement.
  assert.deepEqual(h.records.map(row => row.id), [100, 101]);
  assert.equal(h.window.__QC_FORCE_REPLACE, undefined);
});

test('direct draft replacement is also rejected before mutation', () => {
  const existing = [record(100)];
  const h = harness({ records: existing });
  assert.equal(h.sandbox._backupDoImport(draft(), 'replace'), false);
  assert.deepEqual(h.records, existing);
  assert.equal(h.saved, 0);
  assert.equal(h.window.__QC_FORCE_REPLACE, undefined);
});

test('draft import cannot inherit an already pending full-data replacement', () => {
  const existing = [record(100)];
  const h = harness({ records: existing });
  h.window.__QC_FORCE_REPLACE = 1;
  h.load(draft());
  if (h.confirmations.length) h.confirm();
  assert.deepEqual(h.records, existing);
  assert.equal(h.saved, 0);
  assert.equal(h.window.__QC_FORCE_REPLACE, 1);
  assert.ok(h.notices.some(entry => entry.type === 'error'));
});

test('same numbered identical records are skipped without a second write', () => {
  const h = harness();
  h.load(draft());
  h.confirm();
  const first = h.records;
  h.load(draft());
  h.confirm();
  assert.deepEqual(h.records, first);
  assert.equal(h.saved, 1);
  assert.ok(h.notices.some(entry => /跳过 1/.test(entry.message)));
});

test('an ID conflict rejects the entire batch before even unrelated new rows are added', () => {
  const existing = [record(101, { supplier: '服务器供应商' })];
  const h = harness({ records: existing });
  h.load(draft([record(102), record(101)]));
  h.confirm();
  assert.deepEqual(h.records, existing);
  assert.equal(h.saved, 0);
  assert.ok(h.notices.some(entry => /冲突|与现有内容不同/.test(entry.message)));
});

test('conflicting duplicate IDs inside the file are rejected atomically', () => {
  const h = harness();
  h.load(draft([record(), record(101, { qty: 99 })]));
  h.confirm();
  assert.deepEqual(h.records, []);
  assert.equal(h.saved, 0);
  assert.ok(h.notices.some(entry => /冲突/.test(entry.message)));
});

test('a draft from another company is rejected before confirmation', () => {
  const existing = [record(100)];
  const h = harness({ records: existing });
  h.load(draft([record()], { company: 'sy-huadeng' }));
  assert.equal(h.confirmations.length, 0);
  assert.deepEqual(h.records, existing);
  assert.equal(h.saved, 0);
  assert.ok(h.notices.some(entry => /公司|厂区/.test(entry.message)));
});

test('missing permission or a pending-recovery lock prevents importing', () => {
  for (const options of [{ allowed: false }, { blocked: true }]) {
    const existing = [record(100)];
    const h = harness({ ...options, records: existing });
    h.load(draft());
    if (h.confirmations.length) h.confirm();
    assert.deepEqual(h.records, existing);
    assert.equal(h.saved, 0);
    assert.ok(h.notices.some(entry => entry.type === 'error'));
  }
});

test('permission is rechecked if it changes while confirmation is open', () => {
  const h = harness();
  h.load(draft());
  assert.equal(h.confirmations.length, 1);
  h.window.__QC_DRAFT_RECOVERY_BLOCKED = true;
  h.confirm();
  assert.deepEqual(h.records, []);
  assert.equal(h.saved, 0);
});

test('company is rechecked if it changes while confirmation is open', () => {
  const h = harness();
  h.load(draft());
  assert.equal(h.confirmations.length, 1);
  h.window.__QC_COMPANY = 'sy-huadeng';
  h.confirm();
  assert.deepEqual(h.records, []);
  assert.equal(h.saved, 0);
  assert.ok(h.notices.some(entry => /公司/.test(entry.message)));
});

test('invalid draft IDs reject the entire batch instead of allocating new IDs', () => {
  for (const id of [undefined, null, 0, -1, '', 'not-an-id', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const existing = [record(100)];
    const h = harness({ records: existing });
    h.load(draft([record(102), record(101, { id })]));
    if (h.confirmations.length) h.confirm();
    assert.deepEqual(h.records, existing, `invalid ID: ${id}`);
    assert.equal(h.saved, 0);
    assert.ok(h.notices.some(entry => entry.type === 'error'));
  }
});

test('invalid draft record containers are rejected without changing current state', () => {
  for (const payload of [null, { state: { records: 'bad' } }, draft([]),
    draft([{ id: 101, date: '', supplier: '' }])]) {
    const h = harness();
    h.load(payload);
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.saved, 0);
    assert.deepEqual(h.records, []);
  }
});

test('regular backups retain their explicitly selected replacement mode', () => {
  const h = harness({ records: [record(100)] });
  h.load({ version: 1, records: [record()] });
  h.confirm('replace');
  assert.deepEqual(h.records.map(row => row.id), [101]);
  assert.equal(h.window.__QC_FORCE_REPLACE, 1);
  assert.equal(h.saved, 1);
});

test('a rejected persist restores records, nextId, and replacement state', () => {
  for (const mode of ['append', 'replace']) {
    const existing = [record(100)];
    const h = harness({ records: existing, persistResult: false });
    h.window.__QC_FORCE_REPLACE = 3;
    h.load({ records: [record()] });
    h.confirm(mode);
    assert.deepEqual(h.records, existing);
    assert.equal(h.sandbox.state.nextId, 31);
    assert.equal(h.window.__QC_FORCE_REPLACE, 3);
    assert.equal(h.refreshed, 0);
    assert.ok(h.notices.some(entry => entry.type === 'error'));
  }
});

test('a throwing persist also restores all prior state and removes a newly set replacement flag', () => {
  for (const mode of ['append', 'replace']) {
    const existing = [record(100)];
    const h = harness({ records: existing, persistError: 'storage quota exceeded' });
    h.load({ records: [record()] });
    h.confirm(mode);
    assert.deepEqual(h.records, existing);
    assert.equal(h.sandbox.state.nextId, 31);
    assert.equal(Object.prototype.hasOwnProperty.call(h.window, '__QC_FORCE_REPLACE'), false);
    assert.equal(h.refreshed, 0);
    assert.ok(h.notices.some(entry => /storage quota exceeded/.test(entry.message)));
  }
});

test('optional user-provided draft imports all records and skips a repeat', {
  skip: !process.env.QC_DRAFT_FIXTURE,
}, () => {
  const payload = JSON.parse(fs.readFileSync(process.env.QC_DRAFT_FIXTURE, 'utf8').replace(/^\uFEFF/, ''));
  const h = harness({ company: payload.company });
  h.load(payload);
  h.confirm();
  assert.equal(h.records.length, payload.state.records.length);
  assert.equal(h.saved, 1);
  h.load(payload);
  h.confirm();
  assert.equal(h.records.length, payload.state.records.length);
  assert.equal(h.saved, 1);
});

function withoutUpdatedAt(row) {
  const copy = clone(row);
  delete copy.updatedAt;
  return copy;
}
function sqliteRoundTrip(rows) {
  const { DatabaseSync } = require('node:sqlite');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server/server.js'), 'utf8');
  const begin = source.indexOf('const RECORD_COLS =');
  const finish = source.indexOf('function nextRecordId(', begin);
  assert.ok(begin >= 0 && finish > begin);
  const dbRuntime = vm.createContext({});
  vm.runInContext(source.slice(begin, finish) + ';globalThis.storage={RECORD_COLS,SCHEMA_SQL,recordValues,rowToRecord};', dbRuntime);
  const { RECORD_COLS, SCHEMA_SQL, recordValues, rowToRecord } = dbRuntime.storage;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    const insert = db.prepare('INSERT INTO records(' + RECORD_COLS.join(',') + ') VALUES(' + RECORD_COLS.map(() => '?').join(',') + ')');
    for (const row of rows) insert.run(...recordValues(row));
    return clone(db.prepare('SELECT * FROM records ORDER BY id').all().map(rowToRecord));
  } finally { db.close(); }
}

test('a draft missing updatedAt skips an unchanged repeat across clocks and an actual SQLite reload', () => {
  const payload = draft([withoutUpdatedAt(record(701, {
    defects: [{ desc: '合成缺陷', qty: 1, level: 'MIN' }],
    measurements: [{ item: '合成尺寸', standard: '10', values: [10, 10.1] }],
  }))]);
  const first = harness();
  first.load(payload); first.confirm();
  assert.equal(first.saved, 1);
  assert.equal(first.records[0].updatedAt, stamp);
  const fromServer = sqliteRoundTrip(first.records);
  assert.deepEqual(fromServer, first.records);
  const repeated = harness({ records: fromServer });
  repeated.sandbox.nowIso = () => '2026-11-09T08:00:01.000Z';
  repeated.load(payload); repeated.confirm();
  assert.equal(repeated.saved, 0);
  assert.deepEqual(repeated.records, fromServer);
  assert.ok(repeated.notices.some(entry => /跳过 1/.test(entry.message)));
  assert.equal(repeated.notices.some(entry => entry.type === 'error'), false);
});

test('a mixed draft skips the missing-timestamp existing row and stamps only the new row', () => {
  const existingDraft = withoutUpdatedAt(record(702));
  const first = harness(); first.load(draft([existingDraft])); first.confirm();
  const fromServer = sqliteRoundTrip(first.records);
  const next = harness({ records: fromServer });
  next.sandbox.nowIso = () => '2026-11-09T08:00:02.000Z';
  next.load(draft([existingDraft, withoutUpdatedAt(record(703, { qty: 31 }))])); next.confirm();
  assert.equal(next.saved, 1);
  assert.deepEqual(next.records[0], fromServer[0]);
  assert.equal(next.records[1].id, 703);
  assert.equal(next.records[1].qty, 31);
  assert.equal(next.records[1].updatedAt, '2026-11-09T08:00:02.000Z');
});

test('missing updatedAt never hides business, nested-detail or approval differences and rejects the whole mixed batch', () => {
  const original = withoutUpdatedAt(record(704));
  const first = harness(); first.load(draft([original])); first.confirm();
  const fromServer = sqliteRoundTrip(first.records);
  for (const change of [{ qty: 21 }, { supplier: '不同合成供应商' },
    { defects: [{ desc: '新增合成缺陷', qty: 1 }] }, { measurements: [{ item: '新增尺寸', values: [12] }] },
    { status: 'approved', reviewBy: 'different-reviewer' }]) {
    const next = harness({ records: fromServer });
    next.sandbox.nowIso = () => '2026-11-09T08:00:03.000Z';
    next.load(draft([withoutUpdatedAt(record(705)), { ...original, ...change }])); next.confirm();
    assert.equal(next.saved, 0);
    assert.deepEqual(next.records, fromServer);
    assert.equal(next.sandbox.state.nextId, 31);
    assert.equal(next.window.__QC_FORCE_REPLACE, undefined);
    assert.ok(next.notices.some(entry => /编号 704.*内容不同/.test(entry.message)));
  }
});

test('explicit different, null or empty timestamps are not treated as missing and still conflict', () => {
  const original = withoutUpdatedAt(record(706));
  const first = harness(); first.load(draft([original])); first.confirm();
  const fromServer = sqliteRoundTrip(first.records);
  for (const updatedAt of ['2026-11-09T08:00:04.000Z', null, '']) {
    const next = harness({ records: fromServer });
    next.sandbox.nowIso = () => '2026-11-09T08:00:05.000Z';
    next.load(draft([{ ...original, updatedAt }])); next.confirm();
    assert.equal(next.saved, 0);
    assert.deepEqual(next.records, fromServer);
    assert.ok(next.notices.some(entry => /编号 706.*内容不同/.test(entry.message)));
  }
});

test('duplicate new IDs with omitted and explicitly different timestamps fail atomically', () => {
  const firstRow = withoutUpdatedAt(record(707));
  const h = harness();
  h.load(draft([firstRow, { ...firstRow, updatedAt: '2026-11-09T07:59:59.000Z' }])); h.confirm();
  assert.equal(h.saved, 0);
  assert.deepEqual(h.records, []);
  assert.ok(h.notices.some(entry => /备份内编号 707.*冲突/.test(entry.message)));
});
