'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('the production listener serves maintenance checks through both localhost address families', { timeout: 20000 }, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qms-listener-'));
  let child;
  t.after(async()=>{
    if(child && child.exitCode===null && child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
    fs.rmSync(root,{recursive:true,force:true});
  });
  const serverDir=path.join(root,'server');fs.mkdirSync(serverDir);
  for(const name of ['server.js','auth.js']) fs.copyFileSync(path.join(__dirname,name),path.join(serverDir,name));
  fs.writeFileSync(path.join(serverDir,'seed.json'),JSON.stringify({users:[],records:[],defectLib:[]}));
  fs.writeFileSync(path.join(serverDir,'ai-config.json'),JSON.stringify({enabled:false}));
  child=spawn(process.execPath,[path.join(serverDir,'server.js')],{
    env:{PATH:process.env.PATH,PORT:'0',DATA_PATH:path.join(root,'data'),NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
  let output='';
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('listener startup timeout: '+output)),10000);
    child.stderr.on('data',chunk=>{output+=chunk;});
    child.stdout.on('data',chunk=>{
      output+=chunk;const m=/http:\/\/localhost:(\d+)\/index.html/.exec(output);
      if(m){clearTimeout(timer);resolve(Number(m[1]));}
    });
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('server exited: '+code+' '+output));});
  });
  for(const host of ['127.0.0.1','localhost']) {
    const r=await fetch(`http://${host}:${port}/api/maintenance`);
    assert.equal(r.status,200);assert.equal((await r.json()).enabled,false);
  }
  // Skip only where the test machine itself has no IPv6 loopback support.
  const probe=net.createServer();
  const ipv6=await new Promise((resolve,reject)=>{
    probe.once('error',e=>['EAFNOSUPPORT','EADDRNOTAVAIL'].includes(e.code)?resolve(false):reject(e));
    probe.listen(0,'::1',()=>probe.close(()=>resolve(true)));
  });
  if(!ipv6){t.diagnostic('IPv6 loopback unavailable on this host');return;}
  for(let i=0;i<5;i++){
    const r=await fetch(`http://[::1]:${port}/api/maintenance`);
    assert.equal(r.status,200);assert.equal((await r.json()).enabled,false);
  }
  fs.writeFileSync(path.join(root,'data','maintenance.lock'),'maintenance');
  for(const host of ['127.0.0.1','[::1]']){
    const r=await fetch(`http://${host}:${port}/api/maintenance`);
    assert.equal((await r.json()).enabled,true);
  }
});
