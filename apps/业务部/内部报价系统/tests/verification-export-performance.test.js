const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../backend/routes/verificationSummary.js'),'utf8');
function route(db,buildWorkbook){
  const handlers=new Map(),router={use(){},put(){},get(p,fn){handlers.set(p,fn);}},module={exports:{}};
  vm.runInNewContext(source,{module,Buffer,Date,Promise,Map,JSON,setImmediate,require:id=>id==='express'?{Router:()=>router}:id==='../db'?db:id==='../middleware/auth'?{requireAuth(){}}:id==='../services/sourceSummary'?{sourceQuantity:()=>null}:id==='../services/verificationSummary'?{
    columns:[],buildVerificationRow:(q,v,ss)=>({id:q.id,version:v.label,workshop:ss[0]?.dept}),buildVerificationWorkbook:buildWorkbook,
  }:id==='../../frontend/verification-customers'?{display:x=>x}:require(id)});
  return {load:module.exports.loadRows,handlers};
}
const user={id:1,active_factory_code:'qingxi',perms:{'账号管理':{can_admin:true}}};
const response=()=>({headers:{},code:200,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;},send(v){this.body=v;return this;}});
test('sections are read in bounded batches after customer filtering, preserving version associations',async()=>{
  const quotes=Array.from({length:65},(_,i)=>({id:i+1,customer:i<60?'A':'B',verification_version_id:i+100,verification_label:'V2'}));
  const queries=[];
  const db={prepare:sql=>({all:async(...params)=>{
    if(sql.includes('FROM quotes q'))return quotes;
    queries.push(params);return params.slice().reverse().map(id=>({version_id:id,dept:'shop'+id,payload_json:'{}'}));
  }})};
  const r=route(db);const rows=await r.load(user,{customer:'A'});
  assert.deepEqual(queries.map(p=>p.length),[25,25,10]);assert.equal(rows.length,60);
  for(let i=0;i<rows.length;i++){assert.equal(rows[i].id,i+1);assert.equal(rows[i].workshop,'shop'+(100+i));}
  queries.length=0;await r.load(user,{customer:'missing'});assert.equal(queries.length,0);
});
test('concurrent identical exports share work; status is private and later exports rebuild fresh data',async()=>{
  let release,builds=0,reads=0;
  const gate=new Promise(r=>release=r),db={prepare:()=>({all:async()=>{reads++;return [];}})};
  const r=route(db,()=>{builds++;return {xlsx:{writeBuffer:async()=>{await gate;return Buffer.from('xlsx');}}};});
  const exportFn=r.handlers.get('/export'),statusFn=r.handlers.get('/export-status/:id');
  const a='export-request-0001',b='export-request-0002';
  const first=response(),second=response();
  const requests=[exportFn({user,query:{export_id:a}},first),exportFn({user,query:{export_id:b}},second)];
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);assert.equal(builds,1);
  const status=response();statusFn({user,params:{id:a}},status);assert.equal(status.body.state,'generating');
  for(const other of [{...user,id:2},{...user,active_factory_code:'heyuan'}]){const denied=response();statusFn({user:other,params:{id:a}},denied);assert.equal(denied.code,404);}
  release();await Promise.all(requests);assert.equal(first.body.toString(),'xlsx');assert.equal(second.body.toString(),'xlsx');
  const ready=response();statusFn({user,params:{id:a}},ready);assert.equal(ready.body.state,'ready');assert.equal(ready.headers['Cache-Control'],'no-store');
  await exportFn({user,query:{export_id:'export-request-0003'}},response());assert.equal(builds,2,'completed data must not be reused after edits');
});
test('failed exports report failure and can be retried',async()=>{
  let builds=0;const r=route({prepare:()=>({all:async()=>[]})},()=>{builds++;return {xlsx:{writeBuffer:async()=>{throw new Error('generation failed');}}};});
  const id='export-request-failed';await assert.rejects(r.handlers.get('/export')({user,query:{export_id:id}},response()),/generation failed/);
  const status=response();r.handlers.get('/export-status/:id')({user,params:{id}},status);assert.equal(status.body.state,'error');
  await assert.rejects(r.handlers.get('/export')({user,query:{export_id:id}},response()));assert.equal(builds,2);
});
