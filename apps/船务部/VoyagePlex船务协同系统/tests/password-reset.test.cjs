const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
const source=ts.transpileModule(fs.readFileSync('lib/backend-proxy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const context={exports:{},require,process,Headers,fetch};
vm.runInNewContext(source,context);
const {proxyResponse}=context.exports;
test('无内容成功响应保持204，其他禁止响应体的状态同样不报错',async()=>{
 for(const status of [204,205,304]){
  const result=await proxyResponse(new Response(null,{status,headers:{'set-cookie':'example=; Max-Age=0'}}));
  assert.equal(result.status,status);assert.equal(result.body,null);assert.equal(await result.text(),'');
  assert.equal(result.headers.get('set-cookie'),'example=; Max-Age=0');
 }
});
test('普通成功、校验错误及文件下载仍保留原内容',async()=>{
 for(const status of [200,400,401,500]){
  const result=await proxyResponse(new Response('{"message":"original"}',{status,headers:{'content-type':'application/json'}}));
  assert.equal(result.status,status);assert.deepEqual(await result.json(),{message:'original'});
 }
 const result=await proxyResponse(new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename=test.xlsx'}}));
 assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[1,2,3]);assert.match(result.headers.get('content-disposition'),/test.xlsx/);
});
const ui=fs.readFileSync('components/app-shell.tsx','utf8');
const start=ui.indexOf('  async function resetPassword(user:CurrentUser)');
const end=ui.indexOf('\n  return <div',start);
const code=ts.transpileModule(ui.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
async function reset({self=false,password='new-password',response=new Response(null,{status:204}),failure}={}){
 const events=[];
 const run=new Function('window','currentUser','fetch','apiFetch','readJsonResponse','setError','setNotice','setSaving',code+';return resetPassword;');
 const fetcher=async()=>{events.push('request');if(failure)throw failure;return response;};
 const handler=run({prompt:()=>password,alert:message=>events.push(['alert',message]),location:{reload:()=>events.push('reload')}},{id:1},fetcher,fetcher,async r=>{const t=await r.text();return t?JSON.parse(t):{};},e=>events.push(['error',e]),n=>events.push(['notice',n]),s=>events.push(['saving',s]));
 await handler({id:self?1:2,displayName:'test'});return events;
}
test('修改自己的密码成功后提示重新登录',async()=>{const events=await reset({self:true});assert.ok(events.includes('reload'));assert.ok(events.some(e=>Array.isArray(e)&&e[0]==='alert'&&e[1].includes('重新登录')));});
test('重置其他用户不退出管理员账号',async()=>{const events=await reset();assert.ok(!events.includes('reload'));assert.ok(events.some(e=>Array.isArray(e)&&e[0]==='notice'&&e[1].includes('已重置')));});
test('密码校验、后台错误与网络错误正常展示',async()=>{
 const invalid=await reset({password:'short'});assert.ok(!invalid.includes('request'));
 for(const options of [{response:new Response('{"error":"校验未通过"}',{status:400})},{failure:new Error('连接失败')}]){
  const events=await reset(options);assert.ok(!events.includes('reload'));assert.ok(events.some(e=>Array.isArray(e)&&e[0]==='error'&&e[1]));assert.deepEqual(events.at(-1),['saving',false]);
 }
});
