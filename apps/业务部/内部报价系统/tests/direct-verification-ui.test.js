const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../frontend/verification.js'),'utf8');
const outputSource=fs.readFileSync(require.resolve('../frontend/quote-output.js'),'utf8');
const verificationRoutes=fs.readFileSync(require.resolve('../backend/routes/verifications.js'),'utf8');
const quoteOutputRoutes=fs.readFileSync(require.resolve('../backend/routes/export.js'),'utf8');
const sqliteSchema=fs.readFileSync(require.resolve('../backend/db/schema.sql'),'utf8');
test('核价明细在全部部门审核后提供报价明细版导出',()=>{
 assert.match(source,/导出核价明细 \(\$\{approvedCount\}\/\$\{totalCount\}\)/);
 assert.match(source,/\/api\/verifications\/versions\/\$\{version\.id\}\/export/);
 assert.match(source,/const canExportDetail = totalCount > 0 && approvedCount === totalCount/);
});
test('核价保留汇总与减税，并新增当前版本的报价明细表格预览',()=>{
 assert.match(source,/quote-output\.html\?verification_version_id=\$\{encodeURIComponent\(version\.id\)\}&embed=1&ui=/);
 assert.match(source,/汇总与减税<small>自动汇总<\/small>/);
 assert.match(source,/核价明细表<small>表格预览<\/small>/);
 assert.match(source.slice(source.indexOf('function renderVersionSummary'),source.indexOf('function renderVersionOutput')),/renderSummaryPane/);
 assert.match(source,/activeDepartment === '__output__'/);
 assert.match(outputSource,/\/verifications\/versions\/\$\{encodeURIComponent\(verificationVersionId\)\}\/output-layout/);
 assert.match(outputSource,/output-embedded/);
});
test('未锁定核价版本可修改明细原始值并独立重算',()=>{
 assert.match(outputSource,/function outputCellApiPath\(\)/);
 assert.match(outputSource,/\/verifications\/versions\/\$\{encodeURIComponent\(verificationVersionId\)\}\/output-cell/);
 assert.match(outputSource,/修改来源参数/);
 assert.match(verificationRoutes,/router\.put\('\/versions\/:versionId\/output-cell'/);
 assert.match(verificationRoutes,/router\.delete\('\/versions\/:versionId\/output-cell'/);
 assert.match(verificationRoutes,/editableCells: editableCells|editableCells,/);
 assert.match(verificationRoutes,/overrides,/);
 assert.match(sqliteSchema,/CREATE TABLE IF NOT EXISTS quote_verification_output_overrides/);
 assert.match(outputSource,/function unitQuantityCalculationModel\(cell\)/);
 assert.match(outputSource,/用量 × 换算后单价/);
 assert.match(outputSource,/calculation: \{ quantity, unit_price: unitPrice \}/);
 assert.match(verificationRoutes,/outputCellUpdate\(req\.body/);
 assert.match(quoteOutputRoutes,/outputCellUpdate\(req\.body/);
});
test('已进入核价的报价仍可修改报价明细，但不会反向改写原部门审核数据',()=>{
 assert.match(quoteOutputRoutes,/can_edit_output: hasMenuPermission\(req\.user, '报价单详情', 'edit'\)/);
 assert.doesNotMatch(quoteOutputRoutes,/can_edit_output:[^\n]*quoteFrozen/);
 assert.doesNotMatch(quoteOutputRoutes,/if \(await quoteFrozen\(db, id\)\) return res\.status\(409\)/);
 assert.match(quoteOutputRoutes,/const synchronized = isFrozen\s*\? null\s*: await syncOutputValueToSource/);
 assert.match(quoteOutputRoutes,/output_only: isFrozen/);
});
function fixture({failCreate=false,failReload=false}={}){
 let overlay,creates=0,load=0,opened=0;
 const nodes=new Map(),node=k=>{if(!nodes.has(k))nodes.set(k,{disabled:false,textContent:'',focus(){}});return nodes.get(k);};
 const form={reportValidity:()=>true,querySelector:node};
 const context={$:node,esc:v=>String(v).replace(/</g,'&lt;'),document:{createElement(){return overlay={removed:false,querySelector:s=>s==='form'?form:node(s),remove(){this.removed=true;}};},body:{appendChild(){}}},
  api:async(url)=>{if(url==='/quotes/customers')return {customers:['<客户>']};creates++;if(failCreate)throw Error('创建失败');return{id:9};},
  FormData:class{*[Symbol.iterator](){yield ['quote_no','TEST'];yield ['customer','<客户>'];}},versionCache:new Map(),selectedQuoteId:null,
  loadList:async()=>{load++;if(failReload)throw Error('列表失败');},selectTask:async()=>{},openDetail:()=>opened++,alert(){},window:{location:{href:''}}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function openCreateVerification()'),source.indexOf('const VERSION_STATUS')),context);
 return {context,node,open:()=>context.openCreateVerification(),submit:()=>form.onsubmit({preventDefault(){}}),overlay:()=>overlay,counts:()=>({creates,load,opened})};
}
test('新建表单转义客户名称、拒绝重复提交并直接进入核价',async()=>{
 const f=fixture();await f.open();assert.match(f.overlay().innerHTML,/&lt;客户>/);
 await Promise.all([f.submit(),f.submit()]);assert.deepEqual(f.counts(),{creates:1,load:1,opened:1});assert.equal(f.context.selectedQuoteId,9);
});
test('创建失败保留输入可重试；已创建后列表失败只导航现有任务，不再次创建',async()=>{
 const failed=fixture({failCreate:true});await failed.open();await failed.submit();assert.equal(failed.overlay().removed,false);assert.equal(failed.node('[type="submit"]').disabled,false);assert.equal(failed.node('[data-create-error]').textContent,'创建失败');
 const reload=fixture({failReload:true});await reload.open();await reload.submit();assert.equal(reload.counts().creates,1);assert.equal(reload.context.window.location.href,'./verification.html?quote_id=9');
});
