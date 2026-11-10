const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../frontend/mixed-molds');
const { calculateMixedQuote } = require('../backend/services/mixedQuotation');

const config = { enabled:true, mode:'equal', units_per_pack:12,
  products:[{id:'a',code:'A',name:'A'}, {id:'b',code:'B',name:'B'}] };
function fixture() {
  const parts = Array.from({length:145}, (_, i) => ({id:`numbered_${i}`, name:`产品零件${i}`,
    mold_no:`P${i}`, material:'ABS', weight_g:1, cavity:1, target:1000,
    production_demand:100, material_unit_price:.1, machine_price:100, loss_pct:0}));
  const refs = {a:[{part_id:parts[0].id,usage:1}], b:[{part_id:parts[1].id,usage:1}]};
  const shared = [15,19].map((weight, i) => ({mold_no:`0${i+1}M`, name:i ? '球下壳' : '球上壳',
    material:'再生PP+PP', sets:6, machine:'10A', machine_model:'10A', target:null,
    parts:[{name:i ? '球下壳' : '球上壳', material:'再生PP+PP', weight_g:weight, cavity:6,
      injection_run_id:`row:${i+6}`, injection_run_part_index:0}]}));
  return { engineering:{ mixed_imported_parts:parts, mixed_imported_molds:shared,
    mixed_shared:{molds:shared}, mixed_part_selections:refs, mixed_deleted_part_ids:['old_upload'] },
    molding:{mixed_shared:{}, parts_catalog:{version:1, parts:structuredClone(parts), selections:structuredClone(refs)}} };
}
test('#97 旧结构：145条产品零件加2条共有球壳，重复读取不增加、不修改源资料', () => {
  const {engineering,molding} = fixture(), before = JSON.stringify({engineering,molding});
  const merged = M.engineeringCatalog(molding,engineering);
  assert.equal(merged.parts_catalog.parts.length,147);
  assert.deepEqual(merged.parts_catalog.parts.slice(-2).map(p=>[p.name,p.weight_g,p.cavity,p.machine_model,p.target ?? null]),
    [['球上壳',15,6,'10A',null],['球下壳',19,6,'10A',null]]);
  assert.deepEqual(merged.parts_catalog.selections.__shared__.map(r=>r.usage),[1,1]);
  assert.equal(JSON.stringify(M.engineeringCatalog(merged,engineering)),JSON.stringify(merged));
  assert.equal(JSON.stringify({engineering,molding}),before);
  assert.throws(()=>M.catalogRows(merged,config,100),/日产啤次/);
});
test('共有球壳价格及已设用量保留；共有成本每包装一次，不乘12个小产品', () => {
  const {engineering,molding} = fixture();
  const merged = M.engineeringCatalog(molding,engineering);
  const shells = merged.parts_catalog.parts.slice(-2);
  shells.forEach(p=>Object.assign(p,{target:1000,machine_price:100,material_unit_price:.1,loss_pct:0}));
  merged.parts_catalog.selections.__shared__[1].usage=2;
  const again = M.engineeringCatalog(merged,engineering);
  assert.equal(again.parts_catalog.parts.at(-1).target,1000);
  assert.equal(again.parts_catalog.parts.at(-1).material_unit_price,.1);
  const sections = [
    {dept:'sales',payload_json:JSON.stringify({mixed_quote:config,shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}})},
    {dept:'engineering',payload_json:JSON.stringify(engineering)},
    {dept:'molding',payload_json:JSON.stringify(again)},
  ];
  const result = calculateMixedQuote({qty:100},sections,{strict:true});
  assert.ok(Math.abs(result.common_components.dom_mat+result.common_components.imp_mat-5.3)<1e-10);
  assert.ok(Math.abs(result.common_components.injection_labor-.05)<1e-10);
  assert.equal(M.applyCatalog(again,config,100).mixed_shared.injection.length,2);
});
test('已在目录中的球壳复用原ID、价格和工程明确用量，不重复添加', () => {
  const {engineering,molding} = fixture();
  molding.parts_catalog.parts.push({id:'old_ball',name:'球上壳',mold_no:'01M',material:'再生PP+PP',
    weight_g:15,cavity:6,target:2000,material_unit_price:.2});
  engineering.mixed_part_selections.__shared__=[{part_id:'old_ball',usage:3}];
  const catalog=M.engineeringCatalog(molding,engineering).parts_catalog;
  assert.equal(catalog.parts.filter(p=>p.name==='球上壳').length,1);
  assert.equal(catalog.parts.find(p=>p.id==='old_ball').target,2000);
  assert.deepEqual(catalog.selections.__shared__,[{part_id:'old_ball',usage:3}]);
});
test('明确取消选用、删除或完整替换，不会被旧共用模具快照恢复', () => {
  const {engineering,molding} = fixture();
  const merged=M.engineeringCatalog(molding,engineering);
  engineering.mixed_part_selections.__shared__=[];
  assert.deepEqual(M.engineeringCatalog(merged,engineering).parts_catalog.selections.__shared__,[]);
  engineering.mixed_deleted_part_ids.push(merged.parts_catalog.parts.at(-1).id);
  const after=M.engineeringCatalog(merged,engineering);
  assert.equal(after.parts_catalog.parts.some(p=>p.name==='球下壳'),false);
  const replaced=M.prepareMoldImport(engineering,merged.parts_catalog.parts,'replace');
  assert.equal(M.engineeringCatalog(merged,replaced).parts_catalog.parts.length,0);
});
test('工程来源列表缺项不删除已有共有零件，明确删除仍清除对应引用', () => {
  const old={parts_catalog:{version:1,parts:[{id:'upload_ball',name:'球'}],selections:{__shared__:[{part_id:'upload_ball',usage:2}]}}};
  assert.equal(M.engineeringCatalog(old,{mixed_imported_parts:[]}).parts_catalog.parts.length,1);
  const removed=M.engineeringCatalog(old,{mixed_imported_parts:[],mixed_deleted_part_ids:['upload_ball']});
  assert.deepEqual(removed.parts_catalog.parts,[]);
  assert.deepEqual(removed.parts_catalog.selections.__shared__,[]);
});
test('球壳与小产品同为01M时，机型和目标数独立，不能借用另一个模具的参数', () => {
  const {engineering,molding}=fixture();
  engineering.mixed_imported_parts[0].mold_no='01M';
  const merged=M.engineeringCatalog(molding,engineering);
  const shell=merged.parts_catalog.parts.find(p=>p.name==='球上壳');
  const product=merged.parts_catalog.parts[0];
  assert.equal(M.catalogMoldField(merged,shell,'target').value,'');
  assert.throws(()=>M.catalogRows(merged,config,100),/日产啤次/);
  M.updateCatalogMoldField(merged,shell,'target',3000);
  assert.equal(product.target,1000);
  M.updateCatalogMoldField(merged,product,'machine_model','20A');
  assert.equal(shell.machine_model,'10A');
  const again=M.engineeringCatalog(merged,engineering);
  assert.equal(again.parts_catalog.parts.find(p=>p.id===shell.id).target,3000);
});

test('真实保存接口：旧共用模具补入、草稿保存、缺参数拦截及重新打开算价', {timeout:30000}, async t => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
  const {spawn}=require('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shared-molds-api-'));
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.execPath,['backend/server.js'],{cwd:path.join(__dirname,'..'),env:{
    ...process.env,NODE_ENV:'test',DB_DRIVER:'sqlite',DB_FILE:path.join(dir,'test.db'),DATABASE_URL:'',
    PORT:String(port),HOST:'127.0.0.1',SESSION_SECRET:'legacy-shared-test',COOKIE_SECURE:'0',ADMIN_INITIAL_PASSWORD:'shared-test',
  },stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',chunk=>{logs+=chunk;});
  t.after(async()=>{if(child.exitCode==null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(dir,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(logs || 'Server start timed out')),15000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('listening on')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}: ${logs}`));});
  });
  let cookie='';
  async function api(url,method='GET',body,status=200){
    const res=await fetch(`http://127.0.0.1:${port}/api${url}`,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body?JSON.stringify(body):undefined});
    if(res.headers.getSetCookie().length)cookie=res.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;
  }
  await api('/auth/login','POST',{username:'admin',password:'shared-test'});
  const created=await api('/quotes','POST',{quote_no:'LEGACY-SHARED',product_name:'共有球壳回归',customer:'TEST',qty:100,quote_type:'mixed'});
  let data=await api('/quotes/'+created.id);
  await api(`/quotes/${created.id}/mixed`,'PUT',{config,expected_config:data.mixed_quote});
  data=await api('/quotes/'+created.id);
  const id=dept=>data.sections.find(s=>s.dept===dept).id;
  const {engineering,molding}=fixture();
  await api('/sections/'+id('engineering'),'PUT',{payload:engineering});
  await api('/sections/'+id('molding'),'PUT',{payload:molding});
  let saved=JSON.parse((await api('/quotes/'+created.id)).sections.find(s=>s.dept==='molding').payload_json);
  assert.equal(saved.parts_catalog.parts.length,147);
  assert.equal(saved.parts_catalog.selections.__shared__.length,2);
  await api('/sections/'+id('molding'),'PUT',{payload:saved,submit:true},400);
  saved.parts_catalog.parts.slice(-2).forEach(p=>Object.assign(p,{target:1000,machine_price:100,material_unit_price:.1,loss_pct:0}));
  await api('/sections/'+id('molding'),'PUT',{payload:saved});
  const sales={mixed_quote:config,shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}};
  await api('/sections/'+id('sales'),'PUT',{payload:sales});
  data=await api('/quotes/'+created.id);
  saved=JSON.parse(data.sections.find(s=>s.dept==='molding').payload_json);
  assert.equal(saved.mixed_shared.injection.length,2);
  assert.equal(saved.parts_catalog.parts.at(-1).target,1000);
  const result=await api(`/quotes/${created.id}/mixed`);
  assert.equal(result.valid,true);
  assert.ok(Math.abs(result.common_components.dom_mat+result.common_components.imp_mat-3.4)<1e-10);
  assert.ok(Math.abs(result.common_components.injection_labor-1/30)<1e-10);
});
