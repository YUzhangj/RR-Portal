import {fileURLToPath} from 'node:url';import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import core from '../shared/business-sync.cjs';
const root=fileURLToPath(new URL('..',import.meta.url)),delay=ms=>new Promise(r=>setTimeout(r,ms));
test('cloud two-way API enforces station, administrator and CSRF; resolves first reconciliation and retries without stock changes',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'printlink-business-api-')),port=35000+Math.floor(Math.random()*2000),base=`http://127.0.0.1:${port}`;
 const source={products:[{id:1,name:'眼睛'}],inventory:{PETG:{stockG:1000}},records:{}};
 writeFileSync(path.join(dir,'production-source.json'),JSON.stringify(source));
 const token='a'.repeat(40),other='b'.repeat(40);let logs='';
 const child=spawn(process.execPath,['start.mjs','--cloud-only'],{cwd:root,env:{...process.env,APP_MODE:'production',PLATFORM_DATA_DIR:dir,PORT:String(port),PRODUCTION_PORT:String(port+2500),ADMIN_PASSWORD:'sync-test-password',COOKIE_SECURE:'false',BUSINESS_SYNC_STATION:'qingxi',COLLECTOR_STATIONS:JSON.stringify([{id:'qingxi',name:'清溪',factories:['清溪'],machines:['101'],token},{id:'other',name:'其他站',factories:['湖南'],machines:['201'],token:other}])},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 async function request(route,{data,headers={},method}={}){const r=await fetch(base+route,{method:method||(data?'POST':'GET'),headers:{'Content-Type':'application/json',...headers},body:data?JSON.stringify(data):undefined});return {status:r.status,data:await r.json(),headers:r.headers};}
 try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,logs);
  const remote=core.project(source);remote.products['1'].name='原系统修改';remote.inventory.PETG.stockG=990;
  assert.equal((await request('/api/collector/business-sync',{data:{clientId:'11111111-1111-1111-1111-111111111111',remote}})).status,401);
  assert.equal((await request('/api/collector/business-sync',{headers:{Authorization:'Bearer '+other},data:{clientId:'11111111-1111-1111-1111-111111111111',remote}})).status,403);
  const exchange=()=>request('/api/collector/business-sync',{headers:{Authorization:'Bearer '+token},data:{clientId:'11111111-1111-1111-1111-111111111111',remote}});
  assert.equal((await exchange()).data.ok,false);
  assert.equal((await request('/api/platform/business-sync')).status,401);
  const login=await request('/api/login',{data:{username:'admin',password:'sync-test-password'}});assert.equal(login.status,200);
  const headers={Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':login.data.csrf};
  const state=await request('/api/platform/business-sync',{headers});assert.equal(state.status,200);assert.equal(state.data.conflicts.length,2);
  const choices=state.data.conflicts.map(c=>({id:c.id,signature:c.signature,side:'windows'}));
  assert.equal((await request('/api/platform/business-sync',{headers:{Cookie:headers.Cookie},data:{choices}})).status,403);
  assert.equal((await request('/api/platform/business-sync',{headers,data:{choices}})).status,200);
  assert.equal((await exchange()).data.ok,true);assert.equal((await exchange()).data.ok,true);
  const stored=(await request('/api/production/data',{headers})).data;assert.equal(stored.inventory.PETG.stockG,990);assert.equal(stored.products[0].name,'原系统修改');
  const hash=core.fingerprint(core.project(stored));assert.equal((await request('/api/collector/business-sync',{headers:{Authorization:'Bearer '+token},data:{clientId:'11111111-1111-1111-1111-111111111111',probe:true,baseHash:hash,remoteHash:hash}})).data.unchanged,true);
 }finally{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));rmSync(dir,{recursive:true,force:true});}
});
