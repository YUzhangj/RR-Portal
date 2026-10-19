const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
test('正式货号导入：两种顺序、旧关联自动同步、重复导入及冲突回滚', { timeout: 30000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-quotation-'));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['backend/server.js'], { cwd: path.join(__dirname, '..'), env: {
    ...process.env, NODE_ENV: 'test', DB_DRIVER: 'sqlite', DB_FILE: path.join(temporary, 'test.db'),
    DATABASE_URL: '', PORT: String(port), HOST: '127.0.0.1', SESSION_SECRET: 'mixed-test-only-secret', COOKIE_SECURE: '0', ADMIN_INITIAL_PASSWORD: 'mixed-test-only',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stderr.on('data', data => { logs += data; });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); fs.rmSync(temporary, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server start timed out: ' + logs)), 15000);
    child.stdout.on('data', data => { if (String(data).includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/uploads/mold/audit-missing.png`)).status, 401);
  let cookie = '';
  async function api(url, method = 'GET', body, status = 200) {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    if (res.headers.getSetCookie().length) cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const json = (res.headers.get('content-type') || '').includes('json');
    const data = json ? await res.json() : Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, status, `${method} ${url}: ${JSON.stringify(data)}`); return data;
  }
  await api('/auth/login', 'POST', { username: 'admin', password: 'mixed-test-only' });
  const {apply}=require('../frontend/mixed-sku');
  const records=[{source_number:'36',code:'BEAUTYM-S3-037',name:'指甲胶',na_ratio:.1},{source_number:'37',code:'BEAUTYM-S3-038',name:'面膜',na_ratio:.2}];
  const molds=[{mold_no:'M',parts:[{name:'37-瓶盖',material:'ABS',weight_g:1},{name:'38-瓶身',material:'ABS',weight_g:2}]}];
  const read=id=>api('/quotes/'+id);
  const saveConfig=(id,data,next)=>api('/quotes/'+id+'/mixed','PUT',{config:next,expected_config:data.mixed_quote,product_import:true});
  const selections=data=>JSON.parse(data.sections.find(s=>s.dept==='engineering').payload_json).mixed_part_selections;
  const importMolds=async(id,data,explicit=false)=>{
    const engineering=data.sections.find(s=>s.dept==='engineering');
    await api('/quotes/'+id+'/mixed/import-molds','POST',{expected_config:data.mixed_quote,base_filled_at:engineering.filled_at,engineering:JSON.parse(engineering.payload_json||'{}'),molds:explicit?molds.map(m=>({...m,parts:m.parts.map(p=>({...p,source_product_code:'BEAUTYM-S3-0'+p.name.slice(0,2)}))})):molds});
    return read(id);
  };
  for(const [moldsFirst,explicit] of [[true,false],[false,false],[true,true],[false,true]]) {
    const {id}=await api('/quotes','POST',{quote_no:'SKU-ORDER-'+moldsFirst+'-'+explicit,product_name:'导入顺序测试',customer:'TEST',quote_type:'mixed'});
    let data=await read(id);
    if(moldsFirst)data=await importMolds(id,data,explicit);
    const next=apply(data.mixed_quote,records).config;
    await saveConfig(id,data,next); data=await read(id);
    if(!moldsFirst)data=await importMolds(id,data,explicit);
    const eng=JSON.parse(data.sections.find(s=>s.dept==='engineering').payload_json);
    const parts=new Map(eng.mixed_imported_parts.map(p=>[p.id,p.name]));
    for(const p of data.mixed_quote.products) {
      const number=Number(p.code.slice(-3));
      assert.deepEqual(eng.mixed_part_selections[p.id].map(r=>parts.get(r.part_id)),[number===37?'37-瓶盖':'38-瓶身']);
    }
    const previous=selections(data);
    await saveConfig(id,data,apply(data.mixed_quote,records).config);
    data=await read(id);assert.deepEqual(selections(data),previous);
  }
  // Reimporting the product file also fixes saved links from the old NO. rule.
  const {id}=await api('/quotes','POST',{quote_no:'SKU-LEGACY',product_name:'旧资料测试',customer:'TEST',quote_type:'mixed'});
  let data=await read(id);
  const cfg={...data.mixed_quote,products:[{id:'sku36',code:'BEAUTYM-S3-037',source_number:'36',name:'指甲胶',ratio:1},{id:'sku37',code:'BEAUTYM-S3-038',source_number:'37',name:'面膜',ratio:1}]};
  await saveConfig(id,data,cfg);data=await read(id);
  let eng=data.sections.find(s=>s.dept==='engineering');
  const part={id:'legacy37',name:'37-瓶盖',material:'ABS',material_unit_price:.02,shot_price:.5};
  const legacy={mixed_imported_parts:[part],mixed_part_selections:{sku37:[{part_id:part.id,usage:2}]},mixed_shared:{hardware:[{name:'保留',qty:1,unit_price:3}]}};
  await api('/sections/'+eng.id,'PUT',{payload:legacy,submit:false,base_filled_at:eng.filled_at});data=await read(id);
  await saveConfig(id,data,apply(data.mixed_quote,records).config);data=await read(id);
  const after=JSON.parse(data.sections.find(s=>s.dept==='engineering').payload_json);
  assert.deepEqual(after.mixed_part_selections.sku36,[{part_id:part.id,usage:2}]);
  assert.deepEqual(after.mixed_part_selections.sku37,[]);
  assert.deepEqual(after.mixed_shared,legacy.mixed_shared);
  assert.deepEqual(after.mixed_imported_parts,legacy.mixed_imported_parts);
  // A missing official target aborts the whole import, including config and audit.
  eng=data.sections.find(s=>s.dept==='engineering');
  await api('/sections/'+eng.id,'PUT',{payload:legacy,submit:false,base_filled_at:eng.filled_at});data=await read(id);
  const missing=structuredClone(data.mixed_quote);missing.products[0].code='OTHER-037';
  const before=data.sections.map(s=>[s.id,s.payload_json,s.filled_at]);
  const failure=await api('/quotes/'+id+'/mixed','PUT',{config:missing,expected_config:data.mixed_quote,product_import:true},409);
  assert.match(failure.error,/正式货号37未找到/);
  const unchanged=await read(id);
  assert.deepEqual(unchanged.mixed_quote,data.mixed_quote);
  assert.deepEqual(unchanged.sections.map(s=>[s.id,s.payload_json,s.filled_at]),before);
  const {DatabaseSync}=require('node:sqlite');
  const database=new DatabaseSync(path.join(temporary,'test.db'));
  const audit=database.prepare("SELECT detail FROM audit_log WHERE quote_id=? AND action='mixed_sku_import_links'").all(id);
  assert.equal(audit.length,1);
  assert.deepEqual(JSON.parse(JSON.parse(audit[0].detail).sections.find(s=>s.dept==='engineering').payload_json),legacy);
  database.close();
});
