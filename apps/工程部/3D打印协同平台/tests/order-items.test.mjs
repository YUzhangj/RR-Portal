import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {integration} from '../cloud/integration.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('multiple product lines persist, edit, schedule independently and complete as one order',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'printlink-items-')),port=await freePort(),productionPort=await freePort(),base=`http://127.0.0.1:${port}`;let child,auth,logs='';
 const request=async(route,data,method='POST',token)=>{const res=await fetch(base+route,{method:data?method:'GET',headers:{'Content-Type':'application/json',...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:data?JSON.stringify(data):undefined});return {status:res.status,data:await res.json()};};
 const launch=async()=>{child=spawn(process.execPath,['start.mjs','--cloud-only'],{env:{...process.env,APP_MODE:'production',PLATFORM_DATA_DIR:dir,PORT:String(port),PRODUCTION_PORT:String(productionPort),ADMIN_PASSWORD:'items-secret-123',COOKIE_SECURE:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await delay(100);}throw Error(logs);};
 const stop=async()=>{if(child&&child.exitCode===null){child.kill();await once(child,'exit');}};
 const login=async()=>{const res=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'items-secret-123'})});const d=await res.json();auth={cookie:res.headers.get('set-cookie').split(';')[0],csrf:d.csrf};};
 try{
  await writeFile(path.join(dir,'production-source.json'),JSON.stringify({products:[],materials:[{id:'pla',name:'PLA'},{id:'resin',name:'光敏树脂'}],inventory:{PLA:{stockG:5000},光敏树脂:{stockG:5000}},records:{},schedules:[],maintenance:[],stockInLogs:[],miscExpenses:[]}));
  await launch();await login();
  const upload=await fetch(base+'/api/uploads',{method:'POST',headers:{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,'X-File-Name':'parts.stl'},body:'solid parts'});const file=await upload.json();
  const input={factory:'清溪',workshop:'A',customer:'测试',engineer:'工程师',fileIds:[file.id],items:[{product:'外壳',sku:'A1',quantity:2,material:'PLA',color:'白',printerType:'FDM',dueDate:'2026-12-01',notes:'打磨'},{product:'按钮',sku:'B2',quantity:7,material:'光敏树脂',color:'黑',printerType:'光固化',dueDate:'2026-12-02'}]};
  for(const items of [[],Array(51).fill(input.items[0]),[input.items[0],{...input.items[1],quantity:0}],[{...input.items[0],id:'same'},{...input.items[1],id:'same'}]])assert.equal((await request('/api/orders',{...input,items})).status,400);
  const created=await request('/api/orders',input);assert.equal(created.status,201,JSON.stringify(created));let order=created.data;const id=order.id;
  assert.equal(order.items.length,2);assert.equal(order.quantity,9);assert.match(order.sku,/B2/);
  const edit=await request(`/api/orders/${id}/application`,{...input,items:order.items.map((i,n)=>({...i,quantity:n?8:2})),updated:order.updated},'PATCH');assert.equal(edit.status,200);order=edit.data;
  assert.equal(order.items[1].quantity,8);assert.equal(order.items[0].id,created.data.items[0].id);
  assert.equal((await request(`/api/orders/${id}/application`,{...input,updated:'stale'},'PATCH')).status,409);
  await stop();await launch();await login();
  const orders=()=>request('/api/orders');const overview=()=>request('/api/platform/overview');
  assert.deepEqual((await orders()).data[0].items,order.items);
  const jobInput={orderId:id,machineNumber:1,date:'2026-11-30',weight:12,materialId:'pla'};
  assert.equal((await request('/api/platform/jobs',jobInput)).status,400,'multi order must select a line');
  const first=await request('/api/platform/jobs',{...jobInput,itemId:order.items[0].id});assert.equal(first.status,201,JSON.stringify(first));
  assert.equal((await request('/api/platform/jobs',{...jobInput,itemId:order.items[0].id,machineNumber:2})).status,409);
  assert.equal((await overview()).data.orders[0].items.length,1);
  let seq=0;const token=JSON.parse(await readFile(path.join(dir,'secrets.json'))).collector;
  const emit=async(jobId,machine,state)=>{const r=await request('/api/collector/events',{id:randomUUID(),jobId,machine,attempt:1,sequence:++seq,state,progress:state==='FINISH'?100:10,observedAt:new Date().toISOString()},'POST',token);assert.equal(r.status,200,JSON.stringify(r));};
  await emit(first.data.id,'1','RUNNING');await emit(first.data.id,'1','FINISH');
  assert.equal((await orders()).data[0].status,'打印中','unscheduled line prevents early completion');
  assert.equal((await request('/api/platform/jobs/'+first.data.id,{action:'deliver',notes:'提前交付'},'PATCH')).status,409);
  const second=await request('/api/platform/jobs',{...jobInput,itemId:order.items[1].id,machineNumber:2,materialId:'resin'});assert.equal(second.status,201);
  assert.equal((await overview()).data.jobs.find(j=>j.id===second.data.id).status,'待打印','second line does not inherit running status');
  const schedules=(await request('/api/production/data')).data.schedules;
  assert.equal(schedules.find(s=>s.cloudJobId===first.data.id).qty,2);assert.equal(schedules.find(s=>s.cloudJobId===second.data.id).qty,8);assert.equal(schedules.find(s=>s.cloudJobId===second.data.id).material,'光敏树脂');
  assert.equal((await overview()).data.orders.length,0);
  await emit(second.data.id,'2','RUNNING');
  assert.equal((await request('/api/platform/jobs/'+second.data.id,{action:'confirm-finish',attempt:1,notes:'现场确认按钮 8 件完成'},'PATCH')).status,200);
  assert.equal((await orders()).data[0].status,'待交付');
  assert.equal((await request('/api/platform/jobs/'+second.data.id,{action:'retry'},'PATCH')).status,200);
  assert.equal((await orders()).data[0].status,'打印中');
  assert.equal((await request('/api/platform/jobs/'+second.data.id,{action:'cancel'},'PATCH')).status,200);
  assert.equal((await orders()).data[0].status,'打印中','cancelled line cannot cancel other completed lines');
  assert.equal((await overview()).data.orders[0].items[0].id,order.items[1].id);
  const replacement=await request('/api/platform/jobs',{...jobInput,itemId:order.items[1].id,machineNumber:2,materialId:'resin'});assert.equal(replacement.status,201);
  await emit(replacement.data.id,'2','RUNNING');await emit(replacement.data.id,'2','FINISH');assert.equal((await orders()).data[0].status,'待交付');
  assert.equal((await request('/api/platform/jobs/'+replacement.data.id,{action:'deliver',notes:'全部 10 件已交付'},'PATCH')).status,200);
  await stop();await launch();await login();assert.equal((await orders()).data[0].status,'已完成');
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
test('legacy job schema migrates transactionally and preserves identities and machine exclusivity',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE orders(id TEXT PRIMARY KEY,status TEXT,updated TEXT,payload TEXT);CREATE TABLE production_jobs(id TEXT PRIMARY KEY,order_id TEXT UNIQUE NOT NULL,station TEXT NOT NULL,machine TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,telemetry TEXT,sequence INTEGER DEFAULT 0,synced INTEGER DEFAULT 0,created TEXT NOT NULL);INSERT INTO production_jobs VALUES ('old-job','old-order','station','1','{}','打印中','{"progress":45}',12,1,'original');`);
 const old=process.env.COLLECTOR_TOKEN;process.env.COLLECTOR_TOKEN='test-token-at-least-32-characters-long';
 try{integration({db,recordEvent:()=>{},DEMO:true});const job=db.prepare('SELECT * FROM production_jobs').get();assert.equal(job.id,'old-job');assert.equal(job.item_id,'legacy');assert.equal(job.sequence,12);assert.equal(job.synced,1);assert.equal(job.telemetry,'{"progress":45}');assert.throws(()=>db.exec(`INSERT INTO production_jobs(id,order_id,item_id,station,machine,payload,status,created) VALUES ('new','different','item','station','1','{}','待打印','now')`),/UNIQUE/);integration({db,recordEvent:()=>{},DEMO:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM production_jobs').get().n,1);}finally{if(old===undefined)delete process.env.COLLECTOR_TOKEN;else process.env.COLLECTOR_TOKEN=old;db.close();}
});
