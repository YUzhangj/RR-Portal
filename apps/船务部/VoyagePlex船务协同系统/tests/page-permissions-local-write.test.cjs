const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const transpile = file => ts.transpileModule(syncFs.readFileSync(path.join(root, file), 'utf8'), {
  compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText;
class NextResponse extends Response {
  static json(value, options) {return new NextResponse(JSON.stringify(value), {...options,headers:{'content-type':'application/json'}});}
}
const original = [{id:1,groupName:'PR1100 synthetic',productCode:'PR1100-KEEP',note:'original'}];
function deferred() {let resolve; const promise = new Promise(yes => {resolve=yes;}); return {promise,resolve};}
async function harness(t, mode, grant = 'edit') {
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'voyageplex-local-permissions-'));
  t.after(() => fs.rm(owned,{recursive:true,force:true}));
  const entered = deferred(), released = deferred();
  let writes = 0, authChecks = 0;
  let actor = {role:'supervisor',companyAccess:'Xingxin',pagePermissions:{'settings.inspection':grant}};
  const fakeProcess = {cwd:()=>owned,env:{VOYAGEPLEX_API_BASE_URL:'http://loopback.synthetic.invalid'}};
  function moduleAt(file, deps = {}, extra = {}) {
    const context = {exports:{},process:fakeProcess,Headers,Request,Response,File,Buffer,URL,Error,
      require:name => {
        if (name==='next/server') return {NextResponse};
        if (Object.hasOwn(deps,name)) return deps[name];
        if (name==='node:fs/promises') return fs;
        if (name==='node:path') return path;
        if (name==='node:util') return util;
        if (name==='node:os') return {tmpdir:()=>owned};
        throw new Error('Unmocked test dependency '+name);
      }, ...extra};
    vm.runInNewContext(transpile(file),context,{filename:file});return context.exports;
  }
  const permissions = moduleAt('lib/page-permissions.ts');
  const backend = moduleAt('lib/backend-proxy.ts',{'@/lib/page-permissions':permissions},{fetch:async()=>{authChecks++;return Response.json(actor);}});
  const store = moduleAt('lib/inspection-mapping-store.ts');
  await store.writeMappings(original);
  const gatedStore = {
    readMappings:async()=> {const rows=await store.readMappings(); if(mode!=='import'&&mode!=='GET'){entered.resolve();await released.promise;} return rows;},
    writeMappings:async rows=> {writes++;return store.writeMappings(rows);},
  };
  const execFile = () => {throw new Error('Real subprocess execution is forbidden');};
  execFile[util.promisify.custom] = async()=>{entered.resolve();await released.promise;return {stdout:JSON.stringify([{id:2,productCode:'PR1100-REPLACE',note:'synthetic replacement'}]),stderr:''};};
  const file = mode==='import'?'app/api/inspection-mappings/import/route.ts':mode==='PUT'||mode==='DELETE'?'app/api/inspection-mappings/[id]/route.ts':'app/api/inspection-mappings/route.ts';
  const route = moduleAt(file,{'@/lib/backend-proxy':backend,'@/lib/inspection-mapping-store':gatedStore,'node:child_process':{execFile}});
  const method = mode==='import'?'POST':mode;
  const req = {method,headers:new Headers(),cookies:{get:()=>({value:'Xingxin'})},nextUrl:new URL('http://synthetic.invalid/api/inspection-mappings'+(mode==='import'?'/import':'')),
    json:async()=>({productCode:'PR1100-UPDATED',note:'synthetic mutation'}),formData:async()=>{const form=new FormData();form.set('file',new File(['synthetic parser fixture'],'synthetic.xlsx'));return form;}};
  return {entered,released,store,run:()=>route[method](req,{params:Promise.resolve({id:'1'})}),setActor:next=>{actor=next;},get writes(){return writes;},get authChecks(){return authChecks;}};
}
for (const mode of ['import','POST','PUT','DELETE']) {
  test(`${mode} local mapping mutation rechecks revoked grant after awaited work and preserves the actual temp file`,async t=>{
    const h=await harness(t,mode);const pending=h.run();await h.entered.promise;
    h.setActor({role:'supervisor',companyAccess:'Xingxin',pagePermissions:{'settings.inspection':'view'}});h.released.resolve();
    const response=await pending;assert.equal(response.status,403);assert.equal(h.writes,0);assert.ok(h.authChecks>=2);
    assert.deepEqual(JSON.parse(JSON.stringify(await h.store.readMappings())),original);
  });
  test(`${mode} local mapping mutation still persists with an unchanged authorized identity`,async t=>{
    const h=await harness(t,mode);h.released.resolve();const response=await h.run();assert.equal(response.status,mode==='POST'?201:mode==='DELETE'?204:200);assert.equal(h.writes,1);assert.ok(h.authChecks>=2);
    const rows=await h.store.readMappings();assert.equal(rows.length,mode==='POST'?2:mode==='DELETE'?0:1);
    if(mode==='PUT')assert.equal(rows[0].productCode,'PR1100-UPDATED');
    if(mode==='import')assert.equal(rows[0].productCode,'PR1100-REPLACE');
  });
}
test('only-view mapping GET reads original records and every mutation is blocked before awaiting or writing',async t=>{
  const get=await harness(t,'GET','view');const response=await get.run();assert.equal(response.status,200);assert.deepEqual(await response.json(),original);assert.equal(get.writes,0);
  for(const mode of ['import','POST','PUT','DELETE']){const h=await harness(t,mode,'view');const result=await h.run();assert.equal(result.status,403);assert.equal(h.writes,0);assert.equal(h.authChecks,1);}
});
test('company access revoked during parsing prevents local replacement',async t=>{
  const h=await harness(t,'import');const pending=h.run();await h.entered.promise;
  h.setActor({role:'supervisor',companyAccess:'Huadeng',pagePermissions:{'settings.inspection':'edit'}});h.released.resolve();
  assert.equal((await pending).status,403);assert.equal(h.writes,0);assert.deepEqual(JSON.parse(JSON.stringify(await h.store.readMappings())),original);
});
