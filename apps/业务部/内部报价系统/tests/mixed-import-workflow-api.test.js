'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const ExcelJS=require('exceljs');
const {apply,planAssembly}=require('../frontend/mixed-sku');
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);

test('mixed XLSX imports persist full-precision NA and SKU labor, recalculate and export without duplicating common costs',{timeout:30000},async t=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'mixed-import-workflow-'));
 const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
 const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const child=spawn(process.execPath,['backend/server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,NODE_ENV:'test',DB_DRIVER:'sqlite',DB_FILE:path.join(temporary,'test.db'),DATABASE_URL:'',PORT:String(port),HOST:'127.0.0.1',SESSION_SECRET:'local-mixed-import-only',COOKIE_SECURE:'0',ADMIN_INITIAL_PASSWORD:'local-import-only'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',data=>{logs+=data;});
 t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(temporary,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server start timed out: '+logs)),15000);child.stdout.on('data',data=>{if(String(data).includes('listening on')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}: ${logs}`));});});
 let cookie='';
 async function api(url,method='GET',body,status=200){
  const multipart=body instanceof FormData;
  const response=await fetch(`http://127.0.0.1:${port}/api${url}`,{method,headers:{Cookie:cookie,...(multipart?{}:{'Content-Type':'application/json'})},body:body?(multipart?body:JSON.stringify(body)):undefined});
  if(response.headers.getSetCookie().length)cookie=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const result=(response.headers.get('content-type')||'').includes('json')?await response.json():Buffer.from(await response.arrayBuffer());
  assert.equal(response.status,status,`${method} ${url}: ${JSON.stringify(result)}`);return result;
 }
 async function upload(workbook,url){const form=new FormData();form.append('file',new Blob([await workbook.xlsx.writeBuffer()]),'import.xlsx');return api(url,'POST',form);}
 await api('/auth/login','POST',{username:'admin',password:'local-import-only'});
 const created=await api('/quotes','POST',{quote_no:'MIX-IMPORT',product_name:'Local import test',customer:'TEST',qty:1000,quote_type:'mixed'});
 const url='/quotes/'+created.id;
 let data=await api(url);
 const sku=new ExcelJS.Workbook(),skuSheet=sku.addWorksheet('SKU');
 skuSheet.addRow(['NO.','Mini_item no','Discription','Ratio per capsule']);
 skuSheet.addRow([1,'SKU-A','A',{formula:'1/9*1.25',result:.138888888888}]);skuSheet.addRow([2,'SKU-B','B','6.94%']);
 const records=(await upload(sku,'/uploads/mixed-sku-sheet')).records;
 const config=apply({...data.mixed_quote,units_per_pack:6},records).config;
 const [a,b]=config.products.map(p=>p.id);
 await api(url+'/mixed','PUT',{config,expected_config:data.mixed_quote});
 data=await api(url);
 assert.equal(data.mixed_quote.products[0].na_ratio,.138888888888);
 assert.equal(data.mixed_quote.products[1].na_ratio,.0694);
 const assembly=new ExcelJS.Workbook(),labor=assembly.addWorksheet('混装装工');
 labor.addRow(['序号','小产品编号','半成品工序名称','工具','人数','用时','备注',null,'序号','成品包装工序名称','工具','人数',null,'备注']);
 labor.addRow([1,'SKU-A','组装A',null,2,null,'A note',null,1,'入箱',null,1]);
 labor.addRow([2,'SKU-B','组装B',null,3]);
 labor.addRow([null,null,null,null,null,null,null,null,null,null,'目标数',1000]);
 labor.addRow([null,null,null,null,null,null,null,null,null,null,'时间','11H']);
 const parsed=await upload(assembly,'/uploads/assembly-sheet?mixed=1');
 const plan=planAssembly(config,parsed.groups);assert.deepEqual(plan.unmatched,[]);
 const assemblyPayload={mixed_products:{},mixed_shared:{}};
 for(const group of plan.groups){
  const payload=group.product.id==='__shared__'?assemblyPayload.mixed_shared:(assemblyPayload.mixed_products[group.product.id]={});
  payload.assembly_base_rate=10;payload.assembly_std_time=group.items[0].work_hours;
  for(const item of group.items)(payload[item.kind+'_step_groups']||=[]).push({product:item.product,qty:item.qty,team:item.team,steps:item.steps});
 }
 const payloads={
  engineering:{mixed_products:{[a]:{hardware:[{name:'A material',qty:1,unit_price:10}]},[b]:{hardware:[{name:'B material',qty:1,unit_price:20}]}},mixed_shared:{packaging_materials:[{name:'共有包装',qty:1,unit_price:2}]}},
  assembly:assemblyPayload,
  sales:{...JSON.parse(data.sections.find(s=>s.dept==='sales').payload_json),header:{fx_hkd_usd:1,fx_rmb_hkd:1},shipping:{markup_x:1,divisor:1},mixed_pricing:{surtax_pct:0}},
 };
 for(const section of data.sections){await api('/sections/'+section.id,'PUT',{payload:payloads[section.dept]||{},submit:false,base_filled_at:section.filled_at});}
 data=await api(url);
 const savedLabor=JSON.parse(data.sections.find(s=>s.dept==='assembly').payload_json);
 assert.deepEqual(savedLabor,assemblyPayload);
 assert.equal(savedLabor.mixed_products[a].assembly_step_groups[0].steps[0].note,'A note');
 const calculation=await api(url+'/mixed');
 const expected=10.02*.138888888888+20.03*.0694+2.01;
 assert.equal(calculation.valid,true);assert.equal(calculation.cost_units,1);
 near(calculation.final_usd,expected);
 near(calculation.common_usd,2.01);
 near(calculation.components.assembly_labor,.02*.138888888888+.03*.0694+.01);
 const workbook=await require('../backend/services/exportMixedQuotation').buildMixedWorkbook({consolidate:false,quote:data.quote,sections:data.sections});
 const serialized=new ExcelJS.Workbook();await serialized.xlsx.load(await workbook.xlsx.writeBuffer());
 const categories=serialized.getWorksheet('内部分类汇总');
 const finalRow=categories.getColumn(1).values.findIndex(value=>value==='合计');
 const totalCol=categories.getRow(4).values.findIndex(value=>value==='成本合计 HKD');
 near(categories.getCell(finalRow,totalCol).result,expected);
 assert.match(categories.getCell(finalRow,totalCol).formula,/\*1\+/);
 const commonRow=categories.getColumn(1).values.findIndex(value=>value==='共有费用');
 near(categories.getCell(commonRow,totalCol).result,2.01);
 assert.equal(serialized.getWorksheet('混装报价汇总').getCell('B6').value,1);
 // Persisting a very small Excel numeric ratio must also survive the real API.
 skuSheet.getCell('D2').value=1e-7;skuSheet.getCell('D3').value=1e21;
 const tiny=apply(data.mixed_quote,(await upload(sku,'/uploads/mixed-sku-sheet')).records).config;
 await api(url+'/mixed','PUT',{config:tiny,expected_config:data.mixed_quote});
 const saved=await api(url);assert.equal(saved.mixed_quote.products[0].na_ratio,1e-7);
 assert.equal(saved.mixed_quote.products[1].na_ratio,1e21);
 const tinyResult=await api(url+'/mixed');
 assert.equal(tinyResult.valid,true);
 assert.deepEqual(tinyResult.products.map(p=>p.weight),[1e-7,1e21]);
 assert.ok(Number.isFinite(tinyResult.final_usd));
 // Existing optimistic concurrency and invalid-config guards still protect the row.
 await api(url+'/mixed','PUT',{config,expected_config:data.mixed_quote},409);
 const invalid=structuredClone(tiny);invalid.products[0].na_ratio=-1;
 await api(url+'/mixed','PUT',{config:invalid,expected_config:tiny},400);
 assert.deepEqual((await api(url)).mixed_quote,tiny);
 // A finite imported number can still overflow when multiplied by a cost.
 // The real JSON API must report an invalid quote rather than a valid null price.
 const overflowing=structuredClone(tiny);overflowing.products[0].na_ratio=1e308;
 await api(url+'/mixed','PUT',{config:overflowing,expected_config:tiny});
 const overflowResult=await api(url+'/mixed');
 assert.equal(overflowResult.valid,false);
 assert.match(overflowResult.errors.join('；'),/金额超出有效计算范围/);
 assert.equal(overflowResult.final_usd,undefined);
 const overflowData=await api(url);
 assert.throws(()=>require('../backend/services/mixedQuotation').calculateMixedQuote(overflowData.quote,overflowData.sections,{strict:true}),/金额超出有效计算范围/);
});
