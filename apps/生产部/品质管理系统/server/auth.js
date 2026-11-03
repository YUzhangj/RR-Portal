'use strict';
const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

const MENUS = ['dashboard', 'records', 'review', 'analysis', 'suppliers', 'daily', 'weekly',
  'monthly', 'yearly', 'supplier-report', 'defectlib', 'import', 'users'];
const COLUMNS = ['v', 'e', 'a', 'm'];
class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new AuthError(status, message); };
const bit = v => v === true || v === 1;
function permissions(user) {
  const result = {};
  let override = user && user.perms;
  if (typeof override === 'string') { try { override = JSON.parse(override); } catch (_) { override = null; } }
  for (const menu of MENUS) {
    const role = user && user.role;
    let row = { v: 0, e: 0, a: 0, m: 0 };
    if (role === 'admin') row = { v: 1, e: 1, a: 1, m: 1 };
    if (role === 'manager') row = { v: 1,
      e: +['records', 'suppliers', 'defectlib', 'import'].includes(menu),
      a: +['records', 'review'].includes(menu), m: +['defectlib', 'import'].includes(menu) };
    if (role === 'viewer') row = {
      v: +['dashboard', 'records', 'review', 'analysis', 'suppliers', 'daily', 'weekly', 'monthly', 'yearly', 'supplier-report'].includes(menu),
      e: +(menu === 'records'), a: 0, m: 0 };
    if (role && ['admin', 'manager', 'viewer'].includes(role) && !(user.username === 'jc' && role === 'admin') &&
        override && !Array.isArray(override) && override[menu] && typeof override[menu] === 'object') {
      for (const col of COLUMNS) if (Object.hasOwn(override[menu], col)) row[col] = +bit(override[menu][col]);
    }
    result[menu] = row;
  }
  return result;
}
function can(user, menu, col) { return permissions(user)[menu]?.[col] === 1; }
function requirePermission(user, menu, col) {
  if (!can(user, menu, col)) fail(403, '当前账号无权限执行此操作');
}
function publicUser(user) {
  let source = user.perms;
  if (typeof source === 'string') { try { source = JSON.parse(source); } catch (_) { source = null; } }
  let overrides = null;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    overrides = {};
    for (const menu of MENUS) if (Object.hasOwn(source, menu) && source[menu] && typeof source[menu] === 'object') {
      overrides[menu] = {};
      for (const col of COLUMNS) if (Object.hasOwn(source[menu], col)) overrides[menu][col] = +bit(source[menu][col]);
    }
  }
  if (!['admin', 'manager', 'viewer'].includes(user.role)) overrides = permissions(user);
  return { username: user.username, role: user.role, enabled: !!user.enabled,
    name: user.name || '', dept: user.dept || '', createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null, perms: overrides };
}
function equalSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && b.length > 0 &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}
function legacyHash(value) {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h) ^ value.charCodeAt(i);
  return (h >>> 0).toString(16);
}
function hashPassword(password, minimum = 6) {
  if (typeof password !== 'string' || password.length < minimum || password.length > 1024) fail(400, '密码长度须为6至1024个字符');
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(password, salt, 32).toString('hex');
}
function checkPassword(password, stored) {
  if (typeof password !== 'string' || !password || password.length > 1024 || typeof stored !== 'string') return false;
  if (/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(stored)) {
    const [, salt, hash] = stored.split('$');
    return equalSecret(crypto.scryptSync(password, salt, 32).toString('hex'), hash);
  }
  return /^[a-f0-9]{1,8}$/.test(stored) && equalSecret(legacyHash(password), stored);
}
function validJSONRequest(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, '请求须使用JSON格式');
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, '请求来源不允许');
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch (_) { fail(403, '请求来源不允许'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) fail(403, '请求来源不允许');
  }
}
function createSessions({ now = Date.now, lifetime = 12 * 60 * 60 * 1000, storeFile = null } = {}) {
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) throw new TypeError('Invalid session lifetime');
  const MAX_SESSIONS = 4096, MAX_STORE_BYTES = 4 * 1024 * 1024;
  let sessions = new Map(), observedStore = null, unreadableStore = false, preserveOriginal = false;
  const failures = new Map();
  const digest = s => crypto.createHash('sha256').update(s).digest('hex');
  function prune(map) { for (const [key, value] of map) if (value.expires <= now()) map.delete(key); }
  const identity = s => [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  function storeFailure() { fail(503, '登录会话存储暂不可用，请稍后重试'); }
  function parents(allowMissing) {
    for (let p = path.dirname(storeFile); ; p = path.dirname(p)) {
      let s;
      try { s = fs.lstatSync(p); }
      catch (error) { if (allowMissing && error.code === 'ENOENT') { if (p === path.dirname(p)) throw error; continue; } throw error; }
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe session directory');
      if (p === path.dirname(p)) break;
    }
  }
  function readStore() {
    parents(true);
    let before;
    try { before = fs.lstatSync(storeFile); }
    catch (error) { if (error.code === 'ENOENT') return { absent: true }; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_STORE_BYTES) throw new Error('Unsafe session store');
    const fd = fs.openSync(storeFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (identity(before) !== identity(opened)) throw new Error('Session store changed');
      const body = fs.readFileSync(fd);
      if (body.length > MAX_STORE_BYTES || body.length !== opened.size || identity(opened) !== identity(fs.fstatSync(fd)) || identity(opened) !== identity(fs.lstatSync(storeFile))) throw new Error('Session store changed');
      return { absent: false, body, fingerprint: identity(opened), mode: opened.mode & 0o7777 };
    } finally { fs.closeSync(fd); }
  }
  function decodeStore(snapshot) {
    const text = snapshot.body.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(snapshot.body)) throw new Error('Invalid session encoding');
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'sessions,version' || value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS || snapshot.mode !== 0o600) throw new Error('Invalid session store');
    const next = new Map(), keys = new Set(), time = now();
    if (!Number.isSafeInteger(time)) throw new Error('Invalid session clock');
    for (const entry of value.sessions) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid session entry');
      const [key, v] = entry;
      if (!hex(key) || keys.has(key) || !v || Array.isArray(v) || typeof v !== 'object' ||
          Object.keys(v).sort().join(',') !== 'company,csrfToken,expires,password,username' ||
          typeof v.username !== 'string' || !v.username || v.username.length > 100 || v.username.trim() !== v.username || /[\u0000-\u001f\u007f]/.test(v.username) ||
          typeof v.company !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(v.company) || v.company.length > 80 ||
          !hex(v.password) || !hex(v.csrfToken) || !Number.isSafeInteger(v.expires) || v.expires < 0 || v.expires > time + lifetime) throw new Error('Invalid session entry');
      keys.add(key);
      if (v.expires > time) next.set(key, { username: v.username, company: v.company, password: v.password, expires: v.expires, csrfToken: v.csrfToken });
    }
    return next;
  }
  if (storeFile !== null) {
    if (typeof storeFile !== 'string' || !path.isAbsolute(storeFile) || path.resolve(storeFile) !== storeFile || !fs.constants.O_NOFOLLOW) throw new TypeError('Invalid session store path');
    try {
      observedStore = readStore();
      if (!observedStore.absent) {
        try { sessions = decodeStore(observedStore); }
        catch (_) { preserveOriginal = true; } // 旧数组/坏文件不继承；启动不改写或删除。
      }
    } catch (_) { unreadableStore = true; } // 不安全/超限/不可读的原文件不可覆盖。
  }
  function unchangedStore() {
    const current = readStore();
    if (current.absent !== observedStore.absent || !current.absent && (current.fingerprint !== observedStore.fingerprint || !current.body.equals(observedStore.body))) throw new Error('Session store changed outside this process');
  }
  function exclusiveFile(kind, body) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const name = storeFile + '.' + kind + '-' + crypto.randomBytes(16).toString('hex');
      let fd;
      try { fd = fs.openSync(name, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      let original;
      try {
        original = fs.fstatSync(fd);
        if (!original.isFile() || original.nlink !== 1 || (original.mode & 0o7777) !== 0o600) throw new Error('Unsafe session temporary file');
        fs.writeFileSync(fd, body); fs.fsyncSync(fd);
        const after = fs.fstatSync(fd);
        if (!after.isFile() || after.nlink !== 1 || after.ino !== original.ino || after.dev !== original.dev || after.size !== body.length || (after.mode & 0o7777) !== 0o600 || identity(after) !== identity(fs.lstatSync(name))) throw new Error('Session temporary file changed');
        return { name, dev: after.dev, ino: after.ino };
      } catch (error) {
        if (original) {
          try { const s = fs.lstatSync(name); if (s.dev === original.dev && s.ino === original.ino && s.isFile() && s.nlink === 1) fs.unlinkSync(name); } catch (_) {}
        }
        throw error;
      } finally { fs.closeSync(fd); }
    }
    throw new Error('Session temporary file collision');
  }
  function syncDirectory() {
    const fd = fs.openSync(path.dirname(storeFile), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { if (!fs.fstatSync(fd).isDirectory()) throw new Error('Unsafe session directory'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  function removeOwnTemporary(file) {
    if (!file) return;
    try { const s = fs.lstatSync(file.name); if (s.isFile() && s.nlink === 1 && s.dev === file.dev && s.ino === file.ino) fs.unlinkSync(file.name); } catch (_) {}
  }
  function commit(next) {
    if (!storeFile) { sessions = next; return; }
    let temporary, renamed = false;
    try {
      if (unreadableStore) throw new Error('Unreadable original session store');
      parents(false); unchangedStore();
      const body = Buffer.from(JSON.stringify({ version: 1, sessions: [...next] }));
      if (body.length > MAX_STORE_BYTES) throw new Error('Session store capacity');
      decodeStore({ body, mode: 0o600 });
      // 原坏/旧格式先保留逐字节私有副本；仅第一次迁移，不为日常写入累积备份。
      if (preserveOriginal) {
        exclusiveFile('original', observedStore.body); preserveOriginal = false; syncDirectory();
      }
      temporary = exclusiveFile('tmp', body); unchangedStore();
      fs.renameSync(temporary.name, storeFile); renamed = true;
      // rename 已可见之后不能声称失败可回滚。保留实际新状态，仍报503、不发cookie。
      sessions = next; observedStore = readStore(); syncDirectory();
    } catch (_) {
      if (renamed) {
        sessions = next;
        try { observedStore = readStore(); } catch (_) { unreadableStore = true; }
      }
      storeFailure();
    } finally { if (!renamed) removeOwnTemporary(temporary); }
  }
  function changedSessions() { const next = new Map(sessions); prune(next); return next; }
  function removeSession(key) {
    const next = changedSessions(); next.delete(key); commit(next);
  }
  function cookieName(company) { return 'rr_qms_session_' + company.replace(/-/g, '_'); }
  function token(req, company) {
    const matches = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(cookieName(company) + '='));
    if (matches.length !== 1) return null;
    const value = matches[0].slice(cookieName(company).length + 1);
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  }
  function cookie(res, req, company, value, age) {
    // The cookie is scoped by company name; no credentials are placed in localStorage.
    res.setHeader('Set-Cookie', cookieName(company) + '=' + value + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + age + (req.socket.encrypted ? '; Secure' : ''));
  }
  function clear(req, res, company) {
    const value = token(req, company); if (value) removeSession(digest(value));
    cookie(res, req, company, '', 0);
  }
  return {
    login(req, res, company, user) {
      const next = changedSessions();
      const old = token(req, company); if (old) next.delete(digest(old));
      if (next.size >= MAX_SESSIONS) fail(503, '登录会话繁忙，请稍后重试');
      const value = crypto.randomBytes(32).toString('hex'), csrfToken = crypto.randomBytes(32).toString('hex');
      next.set(digest(value), { username: user.username, company, password: digest(user.password), expires: now() + lifetime, csrfToken });
      commit(next);
      cookie(res, req, company, value, Math.floor(lifetime / 1000)); return csrfToken;
    },
    authenticate(req, company, lookup) {
      prune(sessions); const value = token(req, company), session = value && sessions.get(digest(value));
      if (!session || session.company !== company) fail(401, '请登录品质系统');
      const user = lookup(session.username);
      if (!user || !user.enabled || typeof user.password !== 'string' || !equalSecret(session.password, digest(user.password))) {
        try { removeSession(digest(value)); } catch (_) {} // 无效用户仍始终拒绝；清理失败不授予认证。
        fail(401, '登录已失效，请重新登录');
      }
      return { user, csrfToken: session.csrfToken };
    },
    requireCSRF(req, session) { validJSONRequest(req); if (!equalSecret(req.headers['x-qc-csrf'], session.csrfToken)) fail(403, '请刷新页面后重试'); },
    revoke(company, username) {
      const next = changedSessions();
      for (const [key, value] of next) if (value.company === company && value.username === username) next.delete(key);
      commit(next);
    },
    clear,
    loginAttempt(req, company, username) {
      prune(failures); const key = digest(String(req.socket.remoteAddress) + '\0' + company + '\0' + username);
      const value = failures.get(key) || { count: 0, expires: now() + 15 * 60 * 1000 };
      if (value.count >= 10 || failures.size >= 10000 && !failures.has(key)) fail(429, '登录尝试过多，请稍后重试');
      value.count++; failures.set(key, value); return () => failures.delete(key);
    },
  };
}
module.exports = { MENUS, COLUMNS, AuthError, fail, can, permissions, publicUser, requirePermission,
  equalSecret, legacyHash, hashPassword, checkPassword, validJSONRequest, createSessions };
