const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const {DatabaseSync} = require('node:sqlite');

test('output editing preserves read-only access, permissions, and completed-version locks', {timeout: 60000}, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-costing-api-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const database = path.join(temporary, 'test.db'), pgUrl = process.env.TEST_DATABASE_URL;
  const schema = `direct_costing_${process.pid}_${Math.random().toString(16).slice(2)}`;
  let pgAdmin, pgRead, native;
  if (pgUrl) {
    const {Pool} = require('pg');
    pgAdmin = new Pool({connectionString: pgUrl});
    await pgAdmin.query(`CREATE SCHEMA ${schema}`);
    pgRead = new Pool({connectionString: pgUrl, options: `-c search_path=${schema},public`});
  }
  const child = spawn(process.execPath, ['backend/server.js'], {cwd: path.join(__dirname, '..'), env: {
    ...process.env, NODE_ENV: 'test', DB_DRIVER: pgUrl ? 'postgres' : 'sqlite', DB_FILE: pgUrl ? '' : database,
    DATABASE_URL: pgUrl || '', DB_SCHEMA: schema, PORT: String(port), HOST: '127.0.0.1',
    SESSION_SECRET: 'direct-costing-synthetic-only', COOKIE_SECURE: '0', ADMIN_INITIAL_PASSWORD: 'direct-costing-synthetic-only',
  }, stdio: ['ignore', 'pipe', 'pipe']});
  let errors = '';
  child.stderr.on('data', value => { errors += value; });
  t.after(async () => {
    if (child.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done; }
    if (native) native.close();
    if (pgRead) await pgRead.end();
    if (pgAdmin) { await pgAdmin.query(`DROP SCHEMA ${schema} CASCADE`); await pgAdmin.end(); }
    fs.rmSync(temporary, {recursive: true, force: true});
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('synthetic server startup timed out: ' + errors)), 15000);
    child.stdout.on('data', value => { if (String(value).includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`synthetic server exit ${code}: ${errors}`)); });
  });
  if (!pgUrl) native = new DatabaseSync(database);
  async function rows(sql, args = []) {
    if (!pgUrl) return native.prepare(sql).all(...args);
    let index = 0;
    return (await pgRead.query(sql.replace(/\?/g, () => `$${++index}`), args)).rows;
  }
  async function run(sql, args = []) {
    if (!pgUrl) return native.prepare(sql).run(...args);
    let index = 0;
    return pgRead.query(sql.replace(/\?/g, () => `$${++index}`), args);
  }
  const one = async (sql, args) => (await rows(sql, args))[0];
  function session() {
    let cookie = '';
    return async (url, method = 'GET', body) => {
      if (url.endsWith('/output-cell') && body && body.base_revision === undefined) {
        const layout=await fetch(`http://127.0.0.1:${port}/api${url.replace('/output-cell','/output-layout')}`,{headers:{Cookie:cookie}});
        body={...body,base_revision:(await layout.json()).revision};
      }
      const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {method,
        headers: {Cookie: cookie, 'Content-Type': 'application/json'}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
      if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      return {status: response.status, body: (response.headers.get('content-type') || '').includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())};
    };
  }
  const api = session();
  assert.equal((await api('/auth/login', 'POST', {username: 'admin', password: 'direct-costing-synthetic-only'})).status, 200);

  const made = await api('/quotes', 'POST', {quote_no:'PR1144-OUTPUT',customer:'TEST',product_name:'Synthetic',qty:100});
  assert.equal(made.status,200);
  const id=made.body.id;
  const endpoint=`/quotes/${id}/output-cell`;
  const cell={sheet_name:'报价明细',cell_address:'C2',value:12};
  await t.test('viewing an approved output with saved corrections must not change any business rows',async()=>{
    await run(`INSERT INTO quote_output_overrides (quote_id,sheet_name,cell_address,value_json,updated_by) VALUES (?,?,?,?,?)`,[id,cell.sheet_name,cell.cell_address,'12','fixture']);
    await run(`UPDATE quote_sections SET status='approved',reviewed_by='synthetic supervisor',reviewed_at='2026-01-01' WHERE quote_id=?`,[id]);
    await run(`UPDATE quotes SET status='fully_approved' WHERE id=?`,[id]);
    const before=await rows('SELECT * FROM quote_sections WHERE quote_id=? ORDER BY id',[id]);
    const response=await api(`/quotes/${id}/output-layout`);
    assert.equal(response.status,200);
    assert.deepEqual(await rows('SELECT * FROM quote_sections WHERE quote_id=? ORDER BY id',[id]),before);
    assert.equal((await one('SELECT status FROM quotes WHERE id=?',[id])).status,'fully_approved');
  });
  await t.test('editing or resetting an approved department reopens only that source for review',async()=>{
    for(const method of ['PUT','DELETE']) {
      await run(`UPDATE quote_sections SET status='approved' WHERE quote_id=?`,[id]);
      assert.equal((await api(endpoint,method,cell)).status,200);
      assert.equal((await one("SELECT status FROM quote_sections WHERE quote_id=? AND dept='molding'",[id])).status,'filled');
      assert.equal(Number((await one("SELECT COUNT(*) AS n FROM quote_sections WHERE quote_id=? AND status='approved'",[id])).n),7);
    }
  });
  await t.test('a user with page edit but no molding edit cannot write molding output or spoof its department',async()=>{
    await run(`UPDATE quote_sections SET status='empty' WHERE quote_id=?`,[id]);
    const admin=await one("SELECT * FROM users WHERE username='admin'");
    await run(`INSERT INTO users (username,password_hash,display_name,dept,role,factory_code) VALUES (?,?,?,?,?,?)`,['limited-output',admin.password_hash,'Limited','sales','staff',admin.factory_code]);
    const u=await one("SELECT id FROM users WHERE username='limited-output'");
    for(const menu of ['报价单详情','业务部']) await run(`INSERT INTO user_perms (user_id,menu,can_view,can_edit,can_review,can_admin) VALUES (?,?,1,1,0,0)`,[u.id,menu]);
    await run('INSERT INTO user_customers (user_id,customer) VALUES (?,?)',[u.id,'TEST']);
    const limited=session();
    assert.equal((await limited('/auth/login','POST',{username:'limited-output',password:'direct-costing-synthetic-only'})).status,200);
    for(const method of ['PUT','DELETE']) assert.equal((await limited(endpoint,method,{...cell,source_dept:'sales'})).status,403);
    const layout=await limited(`/quotes/${id}/output-layout`);
    assert.equal(layout.body.sheets.find(s=>s.name==='报价明细').cells.find(c=>c.address==='C2').editable,false);
  });
  await t.test('authorized corrections can be saved, reopened, reset and audited',async()=>{
    await run(`UPDATE quote_sections SET status='empty' WHERE quote_id=?`,[id]);
    assert.equal((await api(endpoint,'PUT',cell)).status,200);
    const layout=await api(`/quotes/${id}/output-layout`);
    assert.equal(layout.body.sheets.find(s=>s.name==='报价明细').cells.find(c=>c.address==='C2').rawValue,12);
    assert.equal((await api(endpoint,'DELETE',cell)).status,200);
    assert.equal((await rows('SELECT * FROM quote_output_overrides WHERE quote_id=?',[id])).length,0);
    assert.equal((await rows("SELECT * FROM audit_log WHERE quote_id=? AND action='output_reset'",[id])).length,2);
  });
  await t.test('stale pages cannot overwrite newer corrections, and a failing batch rolls back all cells',async()=>{
    const before=await api(`/quotes/${id}/output-layout`);
    assert.equal((await api(endpoint,'PUT',{...cell,value:15,base_revision:before.body.revision})).status,200);
    assert.equal((await api(endpoint,'PUT',{...cell,value:25,base_revision:before.body.revision})).status,409);
    const saved=await rows('SELECT * FROM quote_output_overrides WHERE quote_id=? ORDER BY cell_address',[id]);
    const batch=await api(endpoint,'PUT',{updates:[{...cell,value:30},{...cell,cell_address:'A8',value:10}]});
    assert.equal(batch.status,400);
    assert.deepEqual(await rows('SELECT * FROM quote_output_overrides WHERE quote_id=? ORDER BY cell_address',[id]),saved);
  });
  await t.test('confirmation and version copy retain independent output corrections',async()=>{
    assert.equal((await api(`/quote-summary/${id}/confirmation`,'PUT',{status:'confirmed',confirmed_price:10})).status,200);
    const view=await api(`/verifications/${id}`);assert.equal(view.status,200);
    const vid=view.body.selected_version.id;
    assert.equal((await rows('SELECT * FROM quote_verification_output_overrides WHERE version_id=?',[vid])).length,1);
    await run("UPDATE quote_verification_sections SET status='approved' WHERE version_id=?",[vid]);
    await run("UPDATE quote_verification_versions SET status='completed' WHERE id=?",[vid]);
    const next=await api(`/verifications/${id}/versions`,'POST',{source_type:'version',source_version_id:vid});
    assert.equal(next.status,200,JSON.stringify(next.body));
    const all=await rows('SELECT * FROM quote_verification_output_overrides ORDER BY version_id');
    assert.equal(all.length,2);assert.equal(all[0].value_json,all[1].value_json);
  });
  await t.test('verification output writes are atomic, revision guarded, independent and review locked',async()=>{
    const made=await api('/verifications','POST',{quote_no:'PR1144-VERIFY-EDIT',product_name:'Synthetic',customer:'TEST',qty:100,quote_type:'single'});
    assert.equal(made.status,201,JSON.stringify(made.body));
    const vid=made.body.version_id, path=`/verifications/versions/${vid}/output-cell`;
    const original=await rows('SELECT * FROM quote_sections WHERE quote_id=? ORDER BY id',[made.body.id]);
    const before=await api(path.replace('/output-cell','/output-layout'));
    let saved=await api(path,'PUT',{...cell,value:22,base_revision:before.body.revision});
    assert.equal(saved.status,200,JSON.stringify(saved.body));
    assert.equal((await api(path,'PUT',{...cell,value:33,base_revision:before.body.revision})).status,409);
    const snapshot=await rows('SELECT * FROM quote_verification_output_overrides WHERE version_id=?',[vid]);
    assert.equal((await api(path,'PUT',{updates:[{...cell,value:32},{...cell,cell_address:'A8'}]})).status,400);
    assert.deepEqual(await rows('SELECT * FROM quote_verification_output_overrides WHERE version_id=?',[vid]),snapshot);
    assert.deepEqual(await rows('SELECT * FROM quote_sections WHERE quote_id=? ORDER BY id',[made.body.id]),original);
    await run("UPDATE quote_verification_sections SET status='approved' WHERE version_id=? AND dept='molding'",[vid]);
    assert.equal((await api(path,'DELETE',cell)).status,200);
    assert.equal((await one("SELECT status FROM quote_verification_sections WHERE version_id=? AND dept='molding'",[vid])).status,'filled');
    await run("UPDATE quote_verification_versions SET status='completed' WHERE id=?",[vid]);
    assert.equal((await api(path,'PUT',cell)).status,409);
  });
  assert.ok(!/cannot start a transaction|SQLITE_BUSY|no transaction is active|\[error\]/.test(errors),errors);
});
