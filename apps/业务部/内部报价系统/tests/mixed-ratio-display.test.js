const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const MixedMolds=require('../frontend/mixed-molds');
async function setup(values=[.1388888888888889,'1/6',0]) {
 const config={enabled:true,mode:'equal',na_direct:true,units_per_pack:1,products:values.map((value,i)=>({id:'p'+i,code:'SKU'+i,name:'产品'+i,ratio:1,na_ratio:value}))};
 const result={enabled:true,config,errors:[],pricing:null,products:config.products.map(p=>({...p,components:{hardware:1},weight:MixedMolds.ratioValue(p.na_ratio)}))};
 const nodes=new Map(),inputs=[];let html='',saved,reloads=0;
 const host={isConnected:true,get innerHTML(){return html;},set innerHTML(value){html=value;inputs.length=0;for(const match of html.matchAll(/data-na-product="([^"]+)"[^>]*value="([^"]*)"/g))inputs.push({dataset:{naProduct:match[1]},value:match[2]});},querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{textContent:'',disabled:false});return nodes.get(selector);},querySelectorAll(selector){return selector==='[data-na-product]'?inputs:[];}};
 const window={MixedMolds,__data:{sections:[]}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/mixed-quotation.js'),'utf8'),{window,location:{reload(){reloads++;}},fetch:async(url,options)=>{if(options?.method==='PUT')saved=JSON.parse(options.body);return {ok:true,json:async()=>options?.method==='PUT'?{ok:true}:result};}});
 await window.MixedQuotation.summary(host,{id:12,product_name:'测试'},{});
 return {host,inputs,config,get saved(){return saved;},get reloads(){return reloads;},save:()=>host.querySelector('[data-save-na]').onclick()};
}
test('汇总去掉NA字样，比例显示四位小数，直接保存保留全部原精度和算式',async()=>{
 const page=await setup();
 assert.doesNotMatch(page.host.innerHTML,/NA/);
 assert.match(page.host.innerHTML,/<th>比例<\/th>/);
 assert.match(page.host.innerHTML,/保存比例并重新汇总/);
 assert.deepEqual(page.inputs.map(input=>input.value),['0.1389','0.1667','0.0000']);
 page.inputs[0].onblur();
 await page.save();
 assert.deepEqual(page.saved.config.products.map(p=>p.na_ratio),[.1388888888888889,'1/6',0]);
 assert.equal(page.reloads,1);
});
test('只改一款比例时保留其他款精度，算式失焦后显示四位但按原算式保存',async()=>{
 const page=await setup();
 page.inputs[1].value='=(1+2)/7';page.inputs[1].oninput();page.inputs[1].onblur();
 assert.equal(page.inputs[1].value,'0.4286');
 await page.save();
 assert.deepEqual(page.saved.config.products.map(p=>p.na_ratio),[.1388888888888889,'=(1+2)/7',0]);
 assert.equal(MixedMolds.pricingWeights(page.saved.config).p1,3/7);
});
test('手动输入当前四位值表示主动修改，非法算式保留可见且阻止保存',async()=>{
 const page=await setup();
 page.inputs[0].value='0.1389';page.inputs[0].oninput();page.inputs[0].onblur();await page.save();
 assert.equal(page.saved.config.products[0].na_ratio,'0.1389');
 const invalid=await setup();invalid.inputs[1].value='1/0';invalid.inputs[1].oninput();invalid.inputs[1].onblur();
 assert.equal(invalid.inputs[1].value,'1/0');await invalid.save();assert.equal(invalid.saved,undefined);
 assert.ok(invalid.host.querySelector('[data-na-status]').textContent);
});
