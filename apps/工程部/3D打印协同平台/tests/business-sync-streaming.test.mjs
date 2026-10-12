import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import core from '../shared/business-sync.cjs';
import createSync from '../production/business-sync.cjs';
import transport from '../shared/business-sync-transport.cjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clientId = '11111111-1111-1111-1111-111111111111';
const token = 'streaming-collector-test-'.repeat(2);
const otherToken = 'streaming-other-test-'.repeat(2);
const internalToken = 'streaming-internal-test-'.repeat(2);
const source = () => ({
  products: [{id: 1, name: '清溪产品', image: 'cloud-image'}],
  materials: [{id: 1, name: 'PETG'}],
  settings: {machines: 1}, inventory: {PETG: {stockG: 1000}},
  records: {'2026-10-10': {off: false, items: [{_id: 'r1', _updatedAt: 1, machine: 1, qty: 1, weight: 10, material: 'PETG'}]}},
  schedules: [], maintenance: [], miscExpenses: [], stockInLogs: []
});
const probe = {clientId, probe: true, baseHash: 'unknown', remoteHash: 'unknown'};
const internalHeaders = {'X-Internal-Token': internalToken, 'X-Printlink-Sync-Station': 'qingxi'};

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function request(base, route, data, headers = {}) {
  const response = await fetch(base + route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let responseData;
  try {responseData = JSON.parse(text);} catch {responseData = text;}
  return {status: response.status, data: responseData};
}
async function eventually(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(message);
}
function pausedUpload(base, route, headers = {}) {
  return new Promise((resolve, reject) => {
    let established = false;
    const req = http.request(base + route, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'Content-Length': 4096, Expect: '100-continue', ...headers}
    });
    req.on('error', error => {if (!established) reject(error);});
    req.on('response', res => {
      res.resume();
      if (!established) reject(Error('paused upload was rejected before the continue barrier: ' + res.statusCode));
    });
    // Node sends Continue and invokes the request handler in the same server
    // turn. Receiving it confirms that this upload acquired the gate before
    // the test sends a competing probe; no timing delay is needed.
    req.once('continue', () => {established = true; req.write('{'); resolve(req);});
    req.flushHeaders();
  });
}
function earlyResponse(base, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'Content-Length': 65536, ...headers}
    }, res => {
      let text = '';
      res.on('data', chunk => text += chunk); res.on('error', reject);
      res.on('end', () => {req.destroy(); resolve({status: res.statusCode, data: JSON.parse(text)});});
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {req.destroy(); reject(Error('early rejection waited for the incomplete upload'));});
    req.write('{');
  });
}

test('collector input keeps only the authenticated operation, station and permitted fields', () => {
  const spoofed = {action: 'resolve', station: 'other', choices: [{id: 'conflict', side: 'windows'}], clientId, base: null, remote: {products: {}}};
  assert.deepEqual(transport.collectorInput(spoofed, 'qingxi'), {
    action: 'exchange', station: 'qingxi', clientId, base: null, remote: spoofed.remote
  });
  assert.deepEqual(transport.collectorInput({...spoofed, probe: true, baseHash: 'base', remoteHash: 'remote'}, 'qingxi'), {
    action: 'probe', station: 'qingxi', clientId, baseHash: 'base', remoteHash: 'remote'
  });
  assert.equal(transport.MAX_BYTES, 128 * 1024 * 1024);
});

test('incremental JSON decoding preserves split UTF-8 and rejects oversized input before database mutation', async t => {
  const store = new DatabaseSync(':memory:');
  store.exec('CREATE TABLE snapshot(value TEXT)');
  const initial = JSON.stringify(source());
  store.prepare('INSERT INTO snapshot VALUES (?)').run(initial);
  const sync = createSync(store, {
    load: () => JSON.parse(store.prepare('SELECT value FROM snapshot').get().value),
    write: value => store.prepare('UPDATE snapshot SET value=?').run(JSON.stringify(value))
  });
  const server = http.createServer(async (req, res) => {
    try {
      const input = await transport.readJSON(req, {maxBytes: 1024});
      transport.replyJSON(res, 200, req.url === '/decode' ? input : sync(input));
    } catch (error) { transport.replyJSON(res, error.status || 400, {error: error.message}); }
  });
  const base = await listen(server);
  t.after(async () => {await close(server); store.close();});

  const bytes = Buffer.from(JSON.stringify({name: '清溪打印', note: '🙂跨块'}));
  const split = bytes.indexOf(Buffer.from('清')) + 1;
  const decoded = await new Promise((resolve, reject) => {
    const req = http.request(base + '/decode', {method: 'POST', headers: {'Content-Length': bytes.length}}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(text)}));
    });
    req.on('error', reject); req.write(bytes.subarray(0, split));
    setTimeout(() => req.end(bytes.subarray(split)), 20);
  });
  assert.deepEqual(decoded, {status: 200, data: {name: '清溪打印', note: '🙂跨块'}});
  const tooLarge = await request(base, '/sync', {action: 'exchange', remote: {padding: 'x'.repeat(2048)}});
  assert.equal(tooLarge.status, 413);
  assert.equal(typeof tooLarge.data.error, 'string');
  assert.equal(store.prepare('SELECT value FROM snapshot').get().value, initial);
  assert.equal(store.prepare('SELECT COUNT(*) count FROM business_sync_state').get().count, 0);
  for (const invalid of [null, [], 'text']) assert.equal((await request(base, '/decode', invalid)).status, 400);
  assert.equal((await request(base, '/decode', {afterFailure: true})).status, 200);
});

test('stream proxy enforces both byte-limit forms, waits for upload completion before timing out, and releases its gate', async t => {
  let accepted = 0;
  let rejectEarly = false;
  const backend = http.createServer(async (req, res) => {
    if (rejectEarly) {
      rejectEarly = false; req.resume();
      transport.replyJSON(res, 503, {error: 'synthetic backend busy'}); return;
    }
    try {
      const value = await transport.readJSON(req);
      accepted++;
      assert.equal(req.headers['x-internal-token'], internalToken);
      assert.equal(req.headers['x-printlink-sync-station'], 'qingxi');
      if (value.hang) return;
      if (value.response) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        const chunks = ['{"text":"', ...Array(32).fill('x'.repeat(32768)), '"}'];
        for (const chunk of chunks) if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
        res.end();
      } else transport.replyJSON(res, 200, {ok: true, name: value.name});
    } catch (error) { transport.replyJSON(res, error.status || 400, {error: error.message}); }
  });
  await listen(backend);
  const forward = transport.createCollectorProxy({port: backend.address().port, token: internalToken, maxBytes: 1024, timeoutMs: 500});
  const largeForward = transport.createCollectorProxy({port: backend.address().port, token: internalToken, maxBytes: 128 * 1024, timeoutMs: 500});
  const proxy = http.createServer((req, res) => {(req.url === '/early' ? largeForward : forward)(req, res, 'qingxi');});
  const base = await listen(proxy);
  t.after(async () => {await close(proxy); await close(backend);});

  const before = accepted;
  assert.equal((await request(base, '/', {padding: 'x'.repeat(2048)})).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(base, {method: 'POST', headers: {'Content-Type': 'application/json'}}, res => {
      let text = ''; res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(text)}));
    });
    req.on('error', reject); req.write('{"padding":"'); req.end('x'.repeat(2048) + '"}');
  });
  assert.equal(chunked.status, 413);
  assert.equal(accepted, before);

  const slow = await new Promise((resolve, reject) => {
    const body = JSON.stringify({name: '清溪慢速上传'});
    const req = http.request(base, {method: 'POST', headers: {'Content-Length': Buffer.byteLength(body)}}, res => {
      let text = ''; res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(text)}));
    });
    req.on('error', reject); req.write(body.slice(0, 1));
    setTimeout(() => req.end(body.slice(1)), 650);
  });
  assert.deepEqual(slow, {status: 200, data: {ok: true, name: '清溪慢速上传'}});
  const timedOut = await request(base, '/', {hang: true});
  assert.equal(timedOut.status, 504);
  assert.equal(typeof timedOut.data.error, 'string');
  assert.equal((await request(base, '/', {name: 'after-timeout'})).status, 200);
  rejectEarly = true;
  const beforeEarly = accepted;
  assert.deepEqual(await earlyResponse(base, '/early'), {status: 503, data: {error: 'synthetic backend busy'}});
  assert.equal(accepted, beforeEarly);
  assert.equal((await request(base, '/early', {name: 'after-early-response'})).status, 200);

  const streamed = await new Promise((resolve, reject) => {
    const req = http.request(base, {method: 'POST'}, res => {
      let text = ''; res.pause(); setTimeout(() => res.resume(), 80);
      res.on('data', chunk => text += chunk); res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(text)}));
    });
    req.on('error', reject); req.end(JSON.stringify({response: true}));
  });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.data.text.length, 32 * 32768);
});

async function platform(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'printlink-streaming-'));
  writeFileSync(path.join(dir, 'production-source.json'), JSON.stringify(source()));
  writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({internal: internalToken, collector: token}), {mode: 0o600});
  const cloudPortServer = http.createServer(), internalPortServer = http.createServer();
  await listen(cloudPortServer); await listen(internalPortServer);
  const port = cloudPortServer.address().port, productionPort = internalPortServer.address().port;
  await close(cloudPortServer); await close(internalPortServer);
  let logs = '';
  const child = spawn(process.execPath, ['start.mjs', '--cloud-only'], {
    cwd: root, env: {...process.env, APP_MODE: 'production', HOST: '127.0.0.1', PLATFORM_DATA_DIR: dir,
      PORT: String(port), PRODUCTION_PORT: String(productionPort), ADMIN_PASSWORD: 'streaming-test-password',
      COOKIE_SECURE: 'false', BUSINESS_SYNC_STATION: 'qingxi', COLLECTOR_STATIONS: JSON.stringify([
        {id: 'qingxi', name: '清溪', factories: ['清溪'], machines: ['101'], token},
        {id: 'other', name: '其他站', factories: ['湖南'], machines: ['201'], token: otherToken}
      ])}, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => logs = (logs + chunk).slice(-15000));
  child.stderr.on('data', chunk => logs = (logs + chunk).slice(-15000));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      await new Promise(resolve => child.once('exit', resolve)); clearTimeout(timer);
    }
    rmSync(dir, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${port}`, internal = `http://127.0.0.1:${productionPort}`;
  await eventually(async () => {
    assert.equal(child.exitCode, null, logs);
    try {return (await fetch(base + '/api/health')).ok;} catch {return false;}
  }, 'platform did not start: ' + logs);
  await eventually(async () => {
    try {return (await request(internal, '/bridge/business-sync', {action: 'status'}, {'X-Internal-Token': internalToken})).status === 200;}
    catch {return false;}
  }, 'production service did not start: ' + logs);
  const read = () => {
    const db = new DatabaseSync(path.join(dir, 'production.sqlite'));
    try {
      return {snapshot: db.prepare('SELECT value FROM snapshot WHERE id=1').get().value,
        state: db.prepare('SELECT value FROM business_sync_state WHERE id=1').get()?.value || '{}',
        backups: db.prepare('SELECT COUNT(*) count FROM business_sync_backups').get().count};
    } finally {db.close();}
  };
  return {base, internal, child, read, logs: () => logs,
    exchange: input => request(base, '/api/collector/business-sync', input, {Authorization: 'Bearer ' + token}),
    admin: input => request(internal, '/bridge/business-sync', input, {'X-Internal-Token': internalToken})};
}

test('real cloud and production routes reject spoofing and busy uploads, survive aborts, and retain reconciliation semantics', {timeout: 30000}, async t => {
  const app = await platform(t);
  const initial = app.read();
  assert.equal((await request(app.base, '/api/collector/business-sync', probe)).status, 401);
  assert.equal((await request(app.base, '/api/collector/business-sync', probe, {Authorization: 'Bearer ' + otherToken})).status, 403);
  assert.equal((await request(app.internal, '/bridge/collector-business-sync', probe, {'X-Internal-Token': 'invalid'})).status, 401);
  assert.equal((await request(app.internal, '/bridge/collector-business-sync', probe, {...internalHeaders, 'X-Printlink-Sync-Station': 'other'})).status, 403);
  assert.equal((await app.admin({action: 'status'})).data.active, 'qingxi');

  for (const side of ['cloud', 'production']) {
    const base = side === 'cloud' ? app.base : app.internal;
    const route = side === 'cloud' ? '/api/collector/business-sync' : '/bridge/collector-business-sync';
    const headers = side === 'cloud' ? {Authorization: 'Bearer ' + token} : internalHeaders;
    const upload = await pausedUpload(base, route, headers);
    t.after(() => upload.destroy());
    await eventually(async () => (await request(base, route, probe, headers)).status === 503, side + ' gate was not acquired');
    const busy = await request(base, route, probe, headers);
    assert.equal(busy.status, 503); assert.equal(typeof busy.data.error, 'string');
    if (side === 'production') {
      const upstreamBusy = await earlyResponse(app.base, '/api/collector/business-sync', {Authorization: 'Bearer ' + token});
      assert.equal(upstreamBusy.status, 503); assert.equal(typeof upstreamBusy.data.error, 'string');
    }
    assert.deepEqual(app.read(), initial, 'busy or partial uploads must not alter persisted business state');
    upload.destroy();
    await eventually(async () => (await request(base, route, probe, headers)).status === 200, side + ' gate was not released after abort');
    await eventually(async () => (await app.exchange(probe)).status === 200, 'cloud gate was not released after upstream rejection');
    assert.equal((await fetch(app.base + '/api/health')).status, 200);
    assert.equal(app.child.exitCode, null, app.logs());
    assert.deepEqual(app.read(), initial);
  }

  const remote = core.project(source());
  remote.products['1'].name = 'Windows 产品'; remote.inventory.PETG.stockG = 990; remote.records.r1.qty = 2;
  const expected = core.merge(null, core.project(source()), remote);
  const first = await app.exchange({clientId, remote, action: 'resolve', station: 'other', choices: [{id: 'spoof', side: 'windows'}]});
  assert.deepEqual(first, {status: 200, data: {ok: false, conflicts: expected.conflicts.length}});
  const state = JSON.parse(app.read().state);
  assert.equal(state.station, 'qingxi'); assert.deepEqual(state.choices, {});
  assert.deepEqual(state.conflicts.map(({id, signature}) => ({id, signature})), expected.conflicts.map(({id, signature}) => ({id, signature})));
  assert.equal(app.read().snapshot, initial.snapshot);
  assert.equal(state.lastSuccess, undefined); assert.equal(app.read().backups, 0);
  const choices = state.conflicts.map(({id, signature}) => ({id, signature, side: 'windows'}));
  const spoofedResolution = await app.exchange({clientId, remote, action: 'resolve', station: 'other', choices});
  assert.deepEqual(spoofedResolution, {status: 200, data: {ok: false, conflicts: expected.conflicts.length}});
  assert.deepEqual(JSON.parse(app.read().state).choices, {});
  assert.equal((await app.admin({action: 'resolve', choices})).status, 200);
  const resolved = await app.exchange({clientId, remote});
  assert.equal(resolved.status, 200); assert.equal(resolved.data.ok, true);
  assert.equal(core.fingerprint(resolved.data.data), core.fingerprint(remote));
  let persisted = app.read(), snapshot = JSON.parse(persisted.snapshot);
  assert.equal(core.fingerprint(core.project(snapshot)), core.fingerprint(remote));
  assert.equal(snapshot.inventory.PETG.stockG, 990);
  assert.equal(snapshot.records['2026-10-10'].items[0].inventorySync, true);
  assert.equal(persisted.backups, 1);
  const successfulState = JSON.parse(persisted.state);
  assert.equal(successfulState.receipt.request, core.fingerprint({base: null, remote}));
  assert.equal(successfulState.receipt.result, core.fingerprint(remote));
  assert.ok(successfulState.lastSuccess);
  const afterWrite = persisted.snapshot;
  const commonBase = resolved.data.data;
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = await app.exchange({clientId, base: commonBase, remote: commonBase});
    assert.equal(retry.status, 200); assert.equal(retry.data.ok, true);
    persisted = app.read();
    assert.equal(persisted.snapshot, afterWrite); assert.equal(persisted.backups, 1);
    assert.equal(JSON.parse(persisted.snapshot).inventory.PETG.stockG, 990);
    assert.equal(JSON.parse(persisted.state).receipt.request, core.fingerprint({base: commonBase, remote: commonBase}));
  }
  const hash = core.fingerprint(commonBase);
  assert.deepEqual(await app.exchange({clientId, probe: true, baseHash: hash, remoteHash: hash, action: 'resolve', choices}), {status: 200, data: {unchanged: true}});
  assert.equal(app.child.exitCode, null, app.logs());
});
