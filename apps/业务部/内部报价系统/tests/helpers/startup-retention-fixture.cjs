'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync, spawn} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const APP = path.join(__dirname, '../..');
const PASSWORD = 'startup-retention-synthetic-only';
const TABLES = ['factories','departments','users','user_factories','user_customers','user_perms',
  'factory_material_price_control','factory_material_price_managers','ref_tables','app_migrations','factory_ref_tables',
  'quotes','quote_sections','quote_customer_confirmations','audit_log','quote_verifications','quote_verification_versions','quote_verification_sections'];
const INIT = `(async()=>{const db=require('./backend/db');await db.ready;await db.close();process.stdout.write('OWNED_STARTUP_DONE\\n');})().catch(()=>{process.exitCode=1;});`;
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function environment(database, schema, pgUrl) {
  // Deliberately do not inherit application private settings or outbound URLs.
  return {PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',NODE_ENV:'test',
    NODE_OPTIONS:'',NODE_PATH:'',DB_DRIVER:pgUrl?'postgres':'sqlite',DB_FILE:pgUrl?'':database,
    DATABASE_URL:pgUrl||'',DB_SCHEMA:schema,LEGACY_SQLITE_FILE:'',APPLY_CONFIGURED_ACCOUNT_SEED:'',
    ADMIN_INITIAL_PASSWORD:PASSWORD,SESSION_SECRET:'startup-retention-local-only',COOKIE_SECURE:'0'};
}
function initialize(env) {
  const result=spawnSync(process.execPath,['-e',INIT],{cwd:APP,env,encoding:'utf8',timeout:30000,maxBuffer:1024**2});
  assert.equal(result.status,0,`isolated adapter init failed; stderrSHA256=${sha(result.stderr||'')}`);
  assert.ok(result.stdout.includes('OWNED_STARTUP_DONE'),'real adapter initializer completed');
}
async function fixture(t, pgUrl, {authoredReferences=true}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quote-retention-owned-'));
  const database=path.join(directory,'synthetic.db');
  const schema=`retention_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  const env=environment(database,schema,pgUrl);
  let native,pool,admin,schemaCreated=false;
  const cleanup=[];
  t.after(async()=>{
    for(const task of cleanup.reverse())await task();
    if(native)native.close();
    if(pool)await pool.end();
    if(admin){try{if(schemaCreated)await admin.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await admin.end();}}
    fs.rmSync(directory,{recursive:true,force:true});
  });
  if(pgUrl){
    const parsed=new URL(pgUrl);
    assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'startup regression PG must use explicit loopback test connection');
    const {Pool,types}=require('pg');types.setTypeParser(1184,value=>value);
    admin=new Pool({connectionString:pgUrl,connectionTimeoutMillis:5000});
    await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;
    pool=new Pool({connectionString:pgUrl,options:`-c search_path=${schema},public`,connectionTimeoutMillis:5000});
  }
  initialize(env);
  if(!pgUrl)native=new DatabaseSync(database);
  async function query(sql,args=[],method='all') {
    if(native)return native.prepare(sql)[method](...args);
    let index=0;const result=await pool.query(sql.replace(/\?/g,()=>`$${++index}`),args);
    return method==='get'?result.rows[0]:method==='run'?{changes:result.rowCount}:result.rows;
  }
  const insert=async(table,record)=>{
    assert.ok(TABLES.includes(table));const keys=Object.keys(record);
    return query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,Object.values(record),'run');
  };
  const old='2000-01-02T03:04:05.123456Z',recent=new Date(Date.now()-5*24*60*60*1000).toISOString(),stamp='2026-01-02T03:04:05.123456Z';
  // Existing SQLite stock seeds refresh their own updated_at on startup. These
  // owned rows represent already-authored references, not untouched stock seeds;
  // retain exact timestamps instead of hiding a known update in the assertion.
  if(authoredReferences)await query("UPDATE factory_ref_tables SET updated_by=?,updated_at=? WHERE updated_by='[factory-seed]'",['Fixture original reference author',stamp],'run');
  const departments=(await query('SELECT code FROM departments ORDER BY code')).map(row=>row.code);
  assert.equal(departments.length,8);
  for(const [offset,deletedAt] of [old,recent,null].entries()){
    const id=1001+offset;
    await insert('quotes',{id,quote_no:`RETENTION-${id}`,product_name:`Synthetic ${id}`,customer:'SYNTHETIC',qty:123,
      created_by_dept:'sales',created_by_name:'Fixture',created_at:stamp,status:'fully_approved',version:'R-original',factory_code:'qingxi',deleted_at:deletedAt,deleted_by:deletedAt?'Original deleter':null});
    for(const [index,dept] of departments.entries())await insert('quote_sections',{id:20000+offset*8+index,quote_id:id,dept,
      payload_json:` { "source":"${id}/${dept}", "exact":900719925474099312345, "formula":"=A1", "text":"保留原文与空格", "zero":0, "nullable":null } `,
      status:'approved',filled_by:'Original author',filled_at:stamp,reviewed_by:'Original reviewer',reviewed_at:stamp,review_comment:'original approval'});
    await insert('quote_customer_confirmations',{quote_id:id,status:'confirmed',workshops_json:'["原车间"]',confirmed_price:'12.12345678901234567890123456789',confirmed_qty:123,note:'original confirmation',confirmed_by:'Original confirmer',confirmed_at:stamp,updated_at:stamp});
    await insert('quote_verifications',{quote_id:id,origin:'quote',baseline_json:' { "baseline": "原始", "precision": 900719925474099312345 } ',verified_values_json:' {"amount":12.30} ',verified_sections_json:' {"sales":"原审核快照"} ',status:'completed',note:'original baseline',created_by:'Original creator',created_at:stamp,updated_by:'Original updater',updated_at:stamp});
    for(const version of [1,2]){
      const versionId=30000+offset*2+version;
      await insert('quote_verification_versions',{id:versionId,quote_id:id,version_no:version,label:`V${version}`,category:'原分类',parent_version_id:version===1?null:versionId-1,source_type:'quote',status:version===1?'completed':'cancelled',note:'original version',created_by:'Original creator',created_at:stamp,completed_by:'Original reviewer',completed_at:stamp,updated_at:stamp});
      for(const [index,dept] of departments.entries())await insert('quote_verification_sections',{id:40000+offset*16+(version-1)*8+index,version_id:versionId,dept,
        payload_json:` { "quote":${id}, "version":${version}, "dept":"${dept}", "snapshot":"原始审核内容", "price":0.1862 } `,
        status:'approved',filled_by:'Original author',filled_at:stamp,reviewed_by:'Original reviewer',reviewed_at:stamp,review_comment:'original frozen approval'});
    }
    for(const action of ['fill','approve','trash'])await insert('audit_log',{id:50000+offset*3+['fill','approve','trash'].indexOf(action),quote_id:id,dept:'sales',actor:'Original actor',action,detail:'完整原始审计 '+id+' '+action,at:stamp});
  }
  const snapshot=async()=>{
    const result={};
    for(const table of TABLES){
      const rows=await query(`SELECT * FROM ${table}`);
      result[table]=rows.map(row=>JSON.stringify(row)).sort();
    }
    return result;
  };
  const sequence=async()=>pgUrl?query(`SELECT last_value::text AS value,is_called AS called FROM quote_sections_id_seq`,[],'get'):query("SELECT seq AS value FROM sqlite_sequence WHERE name='quote_sections'",[],'get');
  return {directory,database,schema,env,query,snapshot,sequence,initialize:()=>initialize(env),pg:!!pgUrl,departments,addCleanup:task=>cleanup.push(task)};
}
async function server(t, f) {
  let logs='';let origin;
  const net=require('node:net');const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const running=spawn(process.execPath,['backend/server.js'],{cwd:APP,env:{...f.env,HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
  running.stdout.on('data',data=>{logs+=data;if(logs.length>1024**2)running.kill();});
  running.stderr.on('data',()=>{});
  f.addCleanup(async()=>{if(running.exitCode===null){const done=new Promise(resolve=>running.once('exit',resolve));running.kill();await done;}});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('isolated retention server startup timed out')),15000);
    running.stdout.on('data',()=>{if(logs.includes('listening on')){clearTimeout(timer);resolve();}});
    running.once('exit',()=>{clearTimeout(timer);reject(Error('isolated retention server exited'));});
  });
  origin=`http://127.0.0.1:${port}`;
  function session(){let cookie='';return async(url,method='GET',body)=>{
    const response=await fetch(origin+'/api'+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const next=response.headers.getSetCookie();if(next.length)cookie=next.map(row=>row.split(';')[0]).join('; ');
    return {status:response.status,body:await response.json()};
  };}
  return {session};
}
module.exports={fixture,server,PASSWORD,TABLES};
