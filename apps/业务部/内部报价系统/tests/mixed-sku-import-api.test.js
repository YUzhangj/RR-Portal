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
  const missing=structuredClone(data.mixed_quote);missing.products[0].code='OTHER-999';
  const before=data.sections.map(s=>[s.id,s.payload_json,s.filled_at]);
  const failure=await api('/quotes/'+id+'/mixed','PUT',{config:missing,expected_config:data.mixed_quote,product_import:true},409);
  assert.match(failure.error,/正式货号37未找到/);
  const unchanged=await read(id);
  assert.deepEqual(unchanged.mixed_quote,data.mixed_quote);
  assert.deepEqual(unchanged.sections.map(s=>[s.id,s.payload_json,s.filled_at]),before);
  // Exercise the real product-import route when a shared part already has one
  // correct link. The missing link must inherit usage, not a new default of 1.
  const sharedQuote=await api('/quotes','POST',{quote_no:'SKU-SHARED-PARTIAL',product_name:'共用零件补齐',customer:'TEST',quote_type:'mixed'});
  let sharedData=await read(sharedQuote.id);
  await saveConfig(sharedQuote.id,sharedData,{...cfg,products:cfg.products.map(p=>p.id==='sku37'?{...p,code:'WAITING-999'}:p)});sharedData=await read(sharedQuote.id);
  const sharedPart={...part,id:'shared',name:'共用盖',source_product_code:'BEAUTYM-S3-037/BEAUTYM-S3-038'};
  const sharedEngineering={mixed_imported_parts:[sharedPart],mixed_part_selections:{sku36:[{part_id:'shared',usage:2}]},mixed_shared:legacy.mixed_shared};
  const sharedMolding={parts_catalog:{parts:[sharedPart],selections:sharedEngineering.mixed_part_selections}};
  for(const [dept,payload]of [['engineering',sharedEngineering],['molding',sharedMolding]]){
    const section=sharedData.sections.find(s=>s.dept===dept);
    await api('/sections/'+section.id,'PUT',{payload,submit:false,base_filled_at:section.filled_at});sharedData=await read(sharedQuote.id);
  }
  const moldingBefore=JSON.parse(sharedData.sections.find(s=>s.dept==='molding').payload_json).parts_catalog.parts;
  await saveConfig(sharedQuote.id,sharedData,{...sharedData.mixed_quote,products:sharedData.mixed_quote.products.map(p=>p.id==='sku37'?{...p,code:'BEAUTYM-S3-038'}:p)});sharedData=await read(sharedQuote.id);
  const expectedShared={sku36:[{part_id:'shared',usage:2}],sku37:[{part_id:'shared',usage:2}]};
  assert.deepEqual(selections(sharedData),expectedShared);
  assert.deepEqual(JSON.parse(sharedData.sections.find(s=>s.dept==='molding').payload_json).parts_catalog,{parts:moldingBefore,selections:expectedShared});
  await saveConfig(sharedQuote.id,sharedData,sharedData.mixed_quote);sharedData=await read(sharedQuote.id);assert.deepEqual(selections(sharedData),expectedShared);
  // A user deliberately deselects the second eligible SKU. Neither reimporting
  // ratios nor adding an unrelated third SKU may silently add that cost back.
  for(const dept of ['engineering','molding']) {
    const section=sharedData.sections.find(s=>s.dept===dept), payload=JSON.parse(section.payload_json);
    if(dept==='engineering')payload.mixed_part_selections.sku37=[];
    else payload.parts_catalog.selections.sku37=[];
    await api('/sections/'+section.id,'PUT',{payload,submit:false,base_filled_at:section.filled_at});sharedData=await read(sharedQuote.id);
  }
  const manualSelections=structuredClone(selections(sharedData));
  const ratioUpdate=structuredClone(sharedData.mixed_quote);ratioUpdate.products[0].ratio=2;
  await saveConfig(sharedQuote.id,sharedData,ratioUpdate);sharedData=await read(sharedQuote.id);
  assert.deepEqual(selections(sharedData),manualSelections);
  const withThird={...sharedData.mixed_quote,products:[...sharedData.mixed_quote.products,{id:'third',code:'BEAUTYM-S3-039',source_number:'38',name:'第三款',ratio:1}]};
  await saveConfig(sharedQuote.id,sharedData,withThird);sharedData=await read(sharedQuote.id);
  assert.deepEqual(selections(sharedData),manualSelections);
  assert.deepEqual(JSON.parse(sharedData.sections.find(s=>s.dept==='molding').payload_json).parts_catalog.selections,manualSelections);
  const conflicting={...sharedEngineering,mixed_part_selections:{sku36:[{part_id:'shared',usage:2}],third:[{part_id:'shared',usage:3}]}};
  const sharedEng=sharedData.sections.find(s=>s.dept==='engineering');
  await api('/sections/'+sharedEng.id,'PUT',{payload:conflicting,submit:false,base_filled_at:sharedEng.filled_at});sharedData=await read(sharedQuote.id);
  const sharedBefore=sharedData.sections.map(s=>[s.id,s.payload_json,s.filled_at]);
  const conflict=await api('/quotes/'+sharedQuote.id+'/mixed','PUT',{config:sharedData.mixed_quote,expected_config:sharedData.mixed_quote,product_import:true},409);assert.match(conflict.error,/用量不同/);
  assert.deepEqual((await read(sharedQuote.id)).sections.map(s=>[s.id,s.payload_json,s.filled_at]),sharedBefore);
  const ambiguousQuote=await api('/quotes','POST',{quote_no:'SKU-AMBIGUOUS',product_name:'占位冲突',customer:'TEST',quote_type:'mixed'});
  let ambiguousData=await read(ambiguousQuote.id);
  await saveConfig(ambiguousQuote.id,ambiguousData,{...cfg,products:[{id:'number_37',code:'37',name:'37',ratio:1},{id:'number_99',code:'99',name:'99',ratio:1}]});ambiguousData=await read(ambiguousQuote.id);
  const ambiguousEng=ambiguousData.sections.find(s=>s.dept==='engineering'),ambiguousBefore=ambiguousData.sections.map(s=>[s.id,s.payload_json,s.filled_at]);
  const ambiguousFailure=await api('/quotes/'+ambiguousQuote.id+'/mixed/import-molds','POST',{expected_config:ambiguousData.mixed_quote,base_filled_at:ambiguousEng.filled_at,engineering:JSON.parse(ambiguousEng.payload_json||'{}'),molds:[{mold_no:'M',parts:[{name:'共用盖',source_product_code:'BEAUTYM-S3-037/OTHER-S3-037'}]}]},409);
  assert.match(ambiguousFailure.error,/占位.*多个/);assert.deepEqual((await read(ambiguousQuote.id)).sections.map(s=>[s.id,s.payload_json,s.filled_at]),ambiguousBefore);
  // Reordering the updated product sheet cannot move department data by row.
  // Summary weights must use the newly imported ratios, including explicit 0.
  const updateQuote=await api('/quotes','POST',{quote_no:'SKU-UPDATE-RATIOS',product_name:'更新同步',customer:'TEST',quote_type:'mixed'});
  let updateData=await read(updateQuote.id);
  await saveConfig(updateQuote.id,updateData,{...updateData.mixed_quote,na_direct:true,products:[
    {id:'a',code:'SKU-001',source_number:'01',name:'旧一',ratio:1,na_ratio:.1},
    {id:'b',code:'SKU-002',source_number:'02',name:'旧二',ratio:1,na_ratio:.2},
  ]});
  updateData=await read(updateQuote.id);
  for(const section of updateData.sections) {
    const payload=section.dept==='sales'
      ? {mixed_quote:updateData.mixed_quote,header:{fx_hkd_usd:1,fx_rmb_hkd:1},shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}}
      : {mixed_products:{a:{note:section.dept+' 一'},b:{note:section.dept+' 二'}},mixed_shared:{note:'共用保留'}};
    if(section.dept==='engineering') {
      payload.mixed_products.a.hardware=[{qty:1,unit_price:10}];
      payload.mixed_products.b.hardware=[{qty:1,unit_price:20}];
      payload.mixed_shared.hardware=[{qty:1,unit_price:2}];
    }
    await api('/sections/'+section.id,'PUT',{payload,submit:false,base_filled_at:section.filled_at});
  }
  updateData=await read(updateQuote.id);
  const departmentPayloads=updateData.sections.filter(s=>s.dept!=='sales').map(s=>[s.dept,s.payload_json]);
  const importUpdated=apply(updateData.mixed_quote,[
    {source_number:'01',code:'SKU-002',name:'更新二',na_ratio:.4},
    {source_number:'02',code:'SKU-001',name:'更新一',na_ratio:0},
  ]).config;
  await saveConfig(updateQuote.id,updateData,importUpdated);
  updateData=await read(updateQuote.id);
  assert.deepEqual(updateData.sections.filter(s=>s.dept!=='sales').map(s=>[s.dept,s.payload_json]),departmentPayloads);
  assert.deepEqual(updateData.mixed_quote.products.map(p=>[p.id,p.code,p.name,p.na_ratio]),[
    ['b','SKU-002','更新二',.4],['a','SKU-001','更新一',0],
  ]);
  const updatedSummary=await api('/quotes/'+updateQuote.id+'/mixed');
  assert.equal(updatedSummary.valid,true);
  assert.equal(updatedSummary.final_usd,10); // 10*0 + 20*.4 + shared 2
  assert.deepEqual(updatedSummary.products.map(p=>[p.id,p.weight]),[['b',.4],['a',0]]);
  // Completing a formal code through the ordinary configuration save also
  // fills its existing unassigned part, without a separate repair action.
  const updateEng=updateData.sections.find(s=>s.dept==='engineering');
  const updatePayload=JSON.parse(updateEng.payload_json);
  updatePayload.mixed_imported_parts=[{id:'waiting',name:'新瓶身',source_product_code:'SKU-003'}];
  await api('/sections/'+updateEng.id,'PUT',{payload:updatePayload,submit:false,base_filled_at:updateEng.filled_at});
  updateData=await read(updateQuote.id);
  const withNew={...updateData.mixed_quote,products:[...updateData.mixed_quote.products,{id:'new',code:'SKU-003',name:'新增',ratio:1,na_ratio:0}]};
  await api('/quotes/'+updateQuote.id+'/mixed','PUT',{config:withNew,expected_config:updateData.mixed_quote});
  updateData=await read(updateQuote.id);
  assert.deepEqual(selections(updateData).new,[{part_id:'waiting',usage:1}]);
  const {DatabaseSync}=require('node:sqlite');
  const database=new DatabaseSync(path.join(temporary,'test.db'));
  const audit=database.prepare("SELECT detail FROM audit_log WHERE quote_id=? AND action='mixed_sku_import_links'").all(id);
  assert.equal(audit.length,1);
  assert.deepEqual(JSON.parse(JSON.parse(audit[0].detail).sections.find(s=>s.dept==='engineering').payload_json),legacy);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM audit_log WHERE quote_id=? AND action='mixed_sku_import_links'").get(sharedQuote.id).n,1);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM audit_log WHERE quote_id=? AND action='mixed_part_import'").get(ambiguousQuote.id).n,0);
  database.close();
});
