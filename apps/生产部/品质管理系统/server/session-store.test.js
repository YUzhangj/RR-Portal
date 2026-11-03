'use strict';
// Every file/server/database below belongs to a unique synthetic temporary fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const Auth = require('./auth');
const SOURCE = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
const A = 'dg-xingxin', B = 'sy-huadeng', USER = { username: '合成员工', password: 'synthetic-stored-password-hash', enabled: true };
const lifetime = 12 * 60 * 60 * 1000;
function fixture(t, auth = Auth) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qms-session-store-')));
  const file = path.join(root, 'sessions.json');
  let time = 1000000;
  const value = { root, file, auth, now: () => time, advance: n => { time += n; },
    create: () => auth.createSessions({ storeFile: file, now: () => time }) };
  t.after(async () => { try { if (value.beforeCleanup) await value.beforeCleanup(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  return value;
}
function issue(sessions, user = USER, company = A, cookie = '') {
  const headers = {}, req = { headers: { cookie }, socket: { encrypted: false, remoteAddress: '127.0.0.1' } };
  const res = { setHeader(name, value) { headers[name] = value; } };
  const csrf = sessions.login(req, res, company, user);
  return { csrf, cookie: headers['Set-Cookie'].split(';')[0], headers };
}
function request(login) { return { headers: { cookie: login.cookie }, socket: { encrypted: false } }; }
function authenticate(sessions, login, user = USER, company = A) { return sessions.authenticate(request(login), company, () => user); }
function rejected(fn, status = 503) { assert.throws(fn, error => error.status === status); }
function loadAuth(overrides = {}, cryptoOverride = crypto) {
  const mocked = Object.assign(Object.create(fs), overrides), module = { exports: {} };
  vm.runInNewContext(SOURCE, { module, Buffer, URL,
    require(name) { if (name === 'node:fs') return mocked; if (name === 'node:crypto') return cryptoOverride; if (name === 'node:path') return path; throw new Error('Unexpected module'); } });
  return module.exports;
}
function originalCopies(f) { return fs.readdirSync(f.root).filter(name => name.startsWith('sessions.json.original-')).map(name => path.join(f.root, name)); }
function setStore(f, value, mode = 0o600) { fs.writeFileSync(f.file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode }); fs.chmodSync(f.file, mode); }

test('version1 restores the same cookie and CSRF across restart, keeps company isolation and live permissions', t => {
  const f = fixture(t), s = f.create(), login = issue(s), restored = f.create();
  assert.equal(authenticate(restored, login).csrfToken, login.csrf);
  rejected(() => authenticate(restored, login, USER, B), 401);
  const row = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(row.version, 1); assert.equal(row.sessions.length, 1);
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes(login.cookie.split('=')[1]));
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes(USER.password));
  assert.equal(fs.statSync(f.file).mode & 0o7777, 0o600);
  const user = { ...USER, role: 'viewer' };
  assert.equal(authenticate(restored, login, user).user.role, 'viewer');
  rejected(() => restored.requireCSRF({ headers: { 'content-type': 'application/json', 'x-qc-csrf': 'wrong' } }, authenticate(restored, login)), 403);
});

test('API-valid 80, 81 and 100 character usernames, including Chinese names, survive restart', t => {
  for (const length of [80, 81, 100]) {
    const f = fixture(t), user = { ...USER, username: '段'.repeat(length) };
    const login = issue(f.create(), user), restored = f.create();
    const session = authenticate(restored, login, user);
    assert.equal(session.user.username, user.username);
    assert.equal(session.csrfToken, login.csrf);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions[0][1].username.length, length);
  }
});

test('a username above the API 100 character bound cannot create or restore a session', t => {
  const f = fixture(t), s = f.create(), login = issue(s), before = fs.readFileSync(f.file);
  const user = { ...USER, username: '段'.repeat(101) };
  rejected(() => issue(s, user));
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(authenticate(s, login).csrfToken, login.csrf);
  const value = JSON.parse(before); value.sessions[0][1].username = user.username; setStore(f, value);
  const original = fs.readFileSync(f.file);
  rejected(() => authenticate(f.create(), login, user), 401);
  assert.deepEqual(fs.readFileSync(f.file), original);
});

test('successful logout and revoke reject the original cookie after restart', t => {
  for (const action of ['logout', 'revoke']) {
    const f = fixture(t), s = f.create(), login = issue(s), headers = {};
    if (action === 'logout') { s.clear(request(login), { setHeader(n, v) { headers[n] = v; } }, A); assert.match(headers['Set-Cookie'], /Max-Age=0/); }
    else s.revoke(A, USER.username);
    rejected(() => authenticate(s, login), 401); rejected(() => authenticate(f.create(), login), 401);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions.length, 0);
  }
});

test('expiry is not renewed by restart and password, disable or deletion always deny the old token', t => {
  for (const user of [{ ...USER, password: 'different-stored-hash' }, { ...USER, enabled: false }, null]) {
    const f = fixture(t), login = issue(f.create()), restored = f.create();
    rejected(() => authenticate(restored, login, user), 401); rejected(() => authenticate(f.create(), login, user), 401);
  }
  const f = fixture(t), login = issue(f.create()); f.advance(lifetime);
  rejected(() => authenticate(f.create(), login), 401);
});

test('legacy arrays and corrupt stores do not authenticate or write during startup; first login retains original bytes', t => {
  for (const corrupt of [false, true]) {
    const f = fixture(t), login = issue(f.create()), valid = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    const original = Buffer.from(corrupt ? '{broken old session store' : JSON.stringify(valid.sessions));
    setStore(f, original, 0o644);
    const before = fs.readFileSync(f.file), s = f.create();
    assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(originalCopies(f).length, 0);
    rejected(() => authenticate(s, login), 401);
    const fresh = issue(s); assert.equal(authenticate(f.create(), fresh).csrfToken, fresh.csrf);
    const copies = originalCopies(f); assert.equal(copies.length, 1); assert.deepEqual(fs.readFileSync(copies[0]), original);
    assert.equal(fs.statSync(copies[0]).mode & 0o7777, 0o600);
    issue(s); assert.equal(originalCopies(f).length, 1);
  }
});

test('the entire version1 structure is validated before any session is accepted', t => {
  const cases = [
    v => v.sessions.push(null), v => v.sessions.push(v.sessions[0]), v => { v.version = 2; },
    v => { v.extra = true; }, v => { v.sessions[0][0] = 'not-a-digest'; },
    v => { v.sessions[0][1].csrfToken = {}; }, v => { delete v.sessions[0][1].password; },
    v => { v.sessions[0][1].username = 'bad\nuser'; }, v => { v.sessions[0][1].company = '../company'; },
    v => { v.sessions[0][1].expires += 1; }, v => { v.sessions[0][1].expires = 1e100; },
    v => { v.sessions[0][1].extra = true; },
  ];
  for (const mutate of cases) {
    const f = fixture(t), login = issue(f.create()), value = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    mutate(value); setStore(f, value); const original = fs.readFileSync(f.file), restored = f.create();
    rejected(() => authenticate(restored, login), 401); assert.deepEqual(fs.readFileSync(f.file), original);
  }
});

test('more than 4096 entries, malformed UTF8, unsafe file mode and oversized files fail closed', t => {
  for (const kind of ['count', 'utf8', 'mode', 'size']) {
    const f = fixture(t), login = issue(f.create()), value = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    if (kind === 'count') { const row = value.sessions[0]; value.sessions = Array.from({ length: 4097 }, (_, i) => [i ? crypto.createHash('sha256').update(String(i)).digest('hex') : row[0], row[1]]); setStore(f, value); }
    if (kind === 'utf8') setStore(f, Buffer.concat([Buffer.from('{"version":1,"sessions":[],"'), Buffer.from([0xff]), Buffer.from('":true}')]));
    if (kind === 'mode') setStore(f, value, 0o644);
    if (kind === 'size') setStore(f, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
    const original = fs.readFileSync(f.file), s = f.create(); rejected(() => authenticate(s, login), 401);
    if (kind === 'size') { rejected(() => issue(s)); assert.equal(originalCopies(f).length, 0); }
    assert.deepEqual(fs.readFileSync(f.file), original);
  }
});

test('exactly 4096 valid entries load while a new login without a replaced cookie is rejected', t => {
  const f = fixture(t), login = issue(f.create()), value = JSON.parse(fs.readFileSync(f.file, 'utf8')), row = value.sessions[0];
  value.sessions = Array.from({ length: 4096 }, (_, i) => [i ? crypto.createHash('sha256').update(String(i)).digest('hex') : row[0], row[1]]);
  setStore(f, value); const before = fs.readFileSync(f.file), s = f.create();
  assert.equal(authenticate(s, login).csrfToken, login.csrf);
  rejected(() => issue(s)); assert.deepEqual(fs.readFileSync(f.file), before);
});

test('store, parent links, hardlinks and directories are never followed or overwritten', t => {
  for (const kind of ['symlink', 'hardlink', 'directory', 'parent']) {
    const f = fixture(t), sentinel = path.join(f.root, 'private-original'); fs.writeFileSync(sentinel, 'synthetic private original');
    if (kind === 'symlink') fs.symlinkSync(sentinel, f.file);
    if (kind === 'hardlink') fs.linkSync(sentinel, f.file);
    if (kind === 'directory') fs.mkdirSync(f.file);
    let store = f.file;
    if (kind === 'parent') { const target = path.join(f.root, 'actual'); fs.mkdirSync(target); const link = path.join(f.root, 'linked'); fs.symlinkSync(target, link); store = path.join(link, 'sessions.json'); }
    const s = f.auth.createSessions({ storeFile: store, now: f.now }); rejected(() => issue(s));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'synthetic private original');
  }
});

test('a new data directory is not created at startup and becomes usable after server bootstrap creates it', t => {
  const f = fixture(t), folder = path.join(f.root, 'new-data'), store = path.join(folder, 'sessions.json');
  const s = Auth.createSessions({ storeFile: store, now: f.now }); assert.equal(fs.existsSync(folder), false);
  fs.mkdirSync(folder); const login = issue(s);
  assert.equal(authenticate(Auth.createSessions({ storeFile: store, now: f.now }), login).csrfToken, login.csrf);
});

test('random exclusive temporary names skip collisions and every new store is 0600 even under a permissive umask', t => {
  let collision = true;
  const fixed = Buffer.alloc(16, 0xab), fakeCrypto = Object.assign(Object.create(crypto), { randomBytes(size) { if (size === 16 && collision) { collision = false; return fixed; } return crypto.randomBytes(size); } });
  const f = fixture(t, loadAuth({}, fakeCrypto)), name = f.file + '.tmp-' + fixed.toString('hex');
  fs.writeFileSync(name, 'existing collision must stay unchanged');
  const mask = process.umask(0);
  try { issue(f.create()); } finally { process.umask(mask); }
  assert.equal(fs.readFileSync(name, 'utf8'), 'existing collision must stay unchanged');
  assert.equal(fs.statSync(f.file).mode & 0o7777, 0o600);
});

test('pre-rename write, file-fsync and rename failures report 503 without cookie or partial state changes', t => {
  for (const point of ['write', 'fsync', 'rename']) {
    let failIO = false;
    const overrides = {
      writeFileSync(...args) { if (failIO && point === 'write') throw Object.assign(new Error('synthetic failure'), { code: 'ENOSPC' }); return fs.writeFileSync(...args); },
      fsyncSync(fd) { if (failIO && point === 'fsync' && fs.fstatSync(fd).isFile()) throw Object.assign(new Error('synthetic failure'), { code: 'EIO' }); return fs.fsyncSync(fd); },
      renameSync(...args) { if (failIO && point === 'rename') throw Object.assign(new Error('synthetic failure'), { code: 'EIO' }); return fs.renameSync(...args); },
    };
    const f = fixture(t, loadAuth(overrides)), s = f.create(), login = issue(s), before = fs.readFileSync(f.file); failIO = true;
    const headers = {}; rejected(() => s.clear(request(login), { setHeader(n, v) { headers[n] = v; } }, A));
    assert.equal(headers['Set-Cookie'], undefined); assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(authenticate(s, login).csrfToken, login.csrf); assert.equal(authenticate(f.create(), login).csrfToken, login.csrf);
    rejected(() => s.revoke(A, USER.username)); assert.deepEqual(fs.readFileSync(f.file), before);
    const response = {}; rejected(() => s.login({ headers: {}, socket: {} }, { setHeader(n, v) { response[n] = v; } }, A, USER));
    assert.equal(response['Set-Cookie'], undefined); assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(fs.readdirSync(f.root).filter(n => n.includes('.tmp-')).length, 0);
  }
});

test('directory fsync failure after rename is reported honestly and never revives the revoked token', t => {
  let failDirectory = false;
  const auth = loadAuth({ fsyncSync(fd) { if (failDirectory && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('synthetic directory failure'), { code: 'EIO' }); return fs.fsyncSync(fd); } });
  const f = fixture(t, auth), s = f.create(), login = issue(s), before = fs.readFileSync(f.file), headers = {};
  failDirectory = true; rejected(() => s.clear(request(login), { setHeader(n, v) { headers[n] = v; } }, A));
  assert.equal(headers['Set-Cookie'], undefined); assert.notDeepEqual(fs.readFileSync(f.file), before);
  rejected(() => authenticate(s, login), 401); rejected(() => authenticate(f.create(), login), 401);
});

test('post-rename fsync failure never issues a login cookie or upgrades the previous cookie', t => {
  let failDirectory = false;
  const auth = loadAuth({ fsyncSync(fd) { if (failDirectory && fs.fstatSync(fd).isDirectory()) throw new Error('synthetic directory failure'); return fs.fsyncSync(fd); } });
  const f = fixture(t, auth), s = f.create(), old = issue(s), headers = {};
  failDirectory = true;
  rejected(() => s.login(request(old), { setHeader(n, v) { headers[n] = v; } }, A, { ...USER, username: 'another-user' }));
  assert.equal(headers['Set-Cookie'], undefined);
  rejected(() => authenticate(s, old), 401); rejected(() => authenticate(f.create(), old), 401);
});

test('a failed legacy migration retains the original bytes once without making repeated backup files', t => {
  const f = fixture(t), login = issue(f.create()), original = Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions));
  setStore(f, original, 0o644);
  const auth = loadAuth({ writeFileSync(fd, body, ...rest) { if (Buffer.isBuffer(body) && body.toString().startsWith('{"version":1,')) throw new Error('synthetic new-store write failure'); return fs.writeFileSync(fd, body, ...rest); } });
  const s = auth.createSessions({ storeFile: f.file, now: f.now });
  rejected(() => authenticate(s, login), 401);
  rejected(() => issue(s)); rejected(() => issue(s));
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(originalCopies(f).length, 1); assert.deepEqual(fs.readFileSync(originalCopies(f)[0]), original);
});

test('an unexpected external store replacement cannot be silently overwritten by a stale process', t => {
  const f = fixture(t), s = f.create(), login = issue(s);
  const replacement = Buffer.from('{"version":1,"sessions":[]}'); fs.writeFileSync(f.file, replacement);
  rejected(() => issue(s)); assert.deepEqual(fs.readFileSync(f.file), replacement);
  assert.equal(authenticate(s, login).csrfToken, login.csrf); rejected(() => authenticate(f.create(), login), 401);
});

test('real isolated API leaves all user rows intact when required revoke persistence fails', { timeout: 30000 }, async t => {
  const f = fixture(t), app = path.join(f.root, 'api'), serverDir = path.join(app, 'server'), dataDir = path.join(f.root, 'data');
  fs.mkdirSync(serverDir, { recursive: true }); fs.mkdirSync(dataDir);
  for (const name of ['server.js', 'auth.js']) {
    let contents = fs.readFileSync(path.join(__dirname, name), 'utf8');
    if (name === 'server.js') { assert.ok(contents.includes("server.listen(PORT, '0.0.0.0'")); contents = contents.replace("server.listen(PORT, '0.0.0.0'", "server.listen(PORT, '127.0.0.1'"); }
    fs.writeFileSync(path.join(serverDir, name), contents);
  }
  const password = 'synthetic-session-api-password';
  fs.writeFileSync(path.join(serverDir, 'seed.json'), JSON.stringify({ records: [], defectLib: [], users: [
    { username: 'jc', password: Auth.legacyHash(password), role: 'admin', enabled: true },
    { username: '合成员工', password: Auth.legacyHash(password), role: 'viewer', enabled: true },
  ] }));
  fs.writeFileSync(path.join(serverDir, 'ai-config.json'), JSON.stringify({ enabled: false, apiKey: '', baseURL: 'http://127.0.0.1:1/disabled-test-only' }));
  let child, base;
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } };
  f.beforeCleanup = stop;
  async function start() {
    child = spawn(process.execPath, [path.join(serverDir, 'server.js')], { cwd: app,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: f.root, TMPDIR: f.root, NODE_ENV: 'test', NODE_NO_WARNINGS: '1', DATA_PATH: dataDir, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr.on('data', b => { errors += b; if (errors.length > 1024 ** 2) child.kill(); });
    const deadline = Date.now() + 7000;
    child.stdout.on('data', b => { output += b; if (output.length > 1024 ** 2) child.kill(); });
    while (Date.now() < deadline) {
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { base = 'http://127.0.0.1:' + match[1]; return; }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Synthetic API failed to start: ' + errors);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Synthetic API startup deadline');
  }
  async function api(route, session, body) {
    const headers = { 'content-type': 'application/json' };
    if (session) { headers.cookie = session.cookie; headers['x-qc-csrf'] = session.csrf; }
    const response = await fetch(base + route + (route.includes('?') ? '&' : '?') + 'company=' + A, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  function users() { const db = new DatabaseSync(path.join(dataDir, A, 'qc.db'), { readOnly: true }); try { return JSON.parse(JSON.stringify(db.prepare('SELECT * FROM users ORDER BY username').all())); } finally { db.close(); } }
  await start();
  const login = await api('/api/login', null, { username: 'jc', password }); assert.equal(login.status, 200);
  const admin = { cookie: login.cookie.split(';')[0], csrf: login.body.csrfToken };
  const viewer = await api('/api/login', null, { username: '合成员工', password }); assert.equal(viewer.status, 200);
  for (const route of ['/data/sessions.json', '/server/data/sessions.json']) assert.equal((await fetch(base + route)).status, 403);
  const store = path.join(dataDir, 'sessions.json'), saved = path.join(dataDir, 'held-original-store');
  for (const action of ['disable', 'password', 'delete', 'reenable']) {
    if (action === 'reenable') { const db = new DatabaseSync(path.join(dataDir, A, 'qc.db')); try { db.prepare('UPDATE users SET enabled=0 WHERE username=?').run('合成员工'); } finally { db.close(); } }
    const before = users(), bootstrap = await api('/api/bootstrap', admin);
    let input = bootstrap.body.users;
    if (action === 'delete') input = input.filter(u => u.username !== '合成员工');
    else input = input.map(u => u.username === '合成员工' ? { ...u, ...(action === 'password' ? { newPassword: 'synthetic-updated-password' } : { enabled: action === 'reenable' }) } : u);
    const original = fs.readFileSync(store); fs.renameSync(store, saved); fs.mkdirSync(store);
    const failedLogout = await api('/api/logout', admin, {}); assert.equal(failedLogout.status, 503); assert.equal(failedLogout.cookie, null);
    const result = await api('/api/users', admin, { users: input });
    assert.equal(result.status, 503, action); assert.deepEqual(users(), before, action); assert.deepEqual(fs.readFileSync(saved), original);
    assert.equal(result.cookie, null);
    fs.rmdirSync(store); fs.renameSync(saved, store);
    await stop(); await start();
    const refreshed = await api('/api/session', admin); assert.equal(refreshed.status, 200); assert.equal(refreshed.body.csrfToken, admin.csrf);
  }
  const loggedOut = await api('/api/logout', admin, {}); assert.equal(loggedOut.status, 200); assert.match(loggedOut.cookie, /Max-Age=0/);
  await stop(); await start(); assert.equal((await api('/api/session', admin)).status, 401);
  await stop();
});
