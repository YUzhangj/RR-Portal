const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../frontend/workbench.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
function setup(send) {
  const requests = [];
  const context = vm.createContext({
    api: async (url, options) => { const body=JSON.parse(options.body); requests.push(body); return send ? send(body,requests.length) : {filled_at:'v'+requests.length}; },
    alert(){}, canEditDepartment: me=>!!me.edit, hasPerm: me=>!!me.edit,
    num:v=>Number(v)||0, sum:(rows,get)=>rows.reduce((a,r)=>a+get(r),0), parseFormulaInput:Number,
    matchFreightByName:()=>null, FREIGHT_TYPES:[], window:{},
  });
  const start=source.indexOf('const sectionSaveQueues');
  vm.runInContext(source.slice(start,source.indexOf('// ====================',start)),context);
  const section={id:7,dept:'sales',status:'empty',filled_at:'v0',payload_json:JSON.stringify({header:{currency:'HKD'},shipping:{scenarios:[],markup_x:1.2,divisor:.98}})};
  const payload=context.sectionDraft(section);
  const element=()=>({innerHTML:'',textContent:'',style:{},disabled:false,nodes:new Map(),querySelector(k){if(!this.nodes.has(k))this.nodes.set(k,element());return this.nodes.get(k);},querySelectorAll(){return [];}});
  const host=element(),states=[];host.onShippingSummaryDirty=dirty=>states.push(dirty);
  const mount=()=>context.mountShippingSummarySave(host,section,payload,{editable:true});
  const save=mount();
  return {context,requests,section,payload,host,states,save,mount,status:()=>host.querySelector('#shipping-summary-save').querySelector('[data-shipping-save-status]'),button:()=>host.querySelector('#shipping-summary-save').querySelector('[data-save-shipping-summary]')};
}

test('修改会等待服务器确认后才显示已保存、更新缓存；快速连续输入携带最新版本',async()=>{
  const gate=deferred();const s=setup(async (_body,n)=>{if(n===1)await gate.promise;return {filled_at:'v'+n};});
  const original=s.section.payload_json;
  s.payload.shipping.markup_x=1.3;const first=s.save();await tick();
  assert.match(s.status().textContent,/正在保存/);assert.equal(s.section.payload_json,original);assert.equal(s.button().disabled,true);
  s.payload.shipping.markup_x=1.4;const second=s.save();await tick();
  assert.equal(s.requests.length,1);assert.equal(s.requests[0].payload.shipping.markup_x,1.3);
  gate.resolve();await first;await second;
  assert.equal(s.requests[1].payload.shipping.markup_x,1.4);assert.equal(s.requests[1].base_filled_at,'v1');
  assert.equal(JSON.parse(s.section.payload_json).shipping.markup_x,1.4);assert.match(s.status().textContent,/已保存/);assert.equal(s.states.at(-1),false);
});

for(const message of ['登录已失效','该部门资料已更新，本次未覆盖','网络连接失败'])test(message+'：显示实际错误，保留输入和原缓存，允许重试',async()=>{
  let fail=true;const s=setup(()=>{if(fail)throw Error(message);return {filled_at:'v1'};});
  const original=s.section.payload_json;s.payload.shipping.divisor=.97;
  assert.equal(await s.save(),false);
  assert.equal(s.section.payload_json,original);assert.equal(s.payload.shipping.divisor,.97);
  assert.match(s.status().textContent,/保存失败/);assert.ok(s.status().textContent.includes(message));assert.match(s.status().textContent,/输入已保留/);
  assert.equal(s.button().disabled,false);assert.match(s.button().textContent,/重试/);assert.equal(s.states.at(-1),true);
  s.mount();assert.ok(s.status().textContent.includes(message),'切换后仍保留错误与草稿');
  fail=false;await s.button().onclick();assert.match(s.status().textContent,/已保存/);assert.equal(s.section.filled_at,'v1');
});

test('真正的跨窗口冲突始终使用旧版本保护，不自动读取新版本强行覆盖',async()=>{
  const s=setup(()=>{throw Error('版本冲突');});const original=s.section.payload_json;
  s.payload.shipping.markup_x=2;await s.save();await s.button().onclick();
  assert.equal(s.requests.length,2);assert.ok(s.requests.every(r=>r.base_filled_at==='v0'));
  assert.equal(s.section.payload_json,original);
  await assert.rejects(()=>s.host.saveShippingSummary(),/版本冲突/);
});

test('业务与汇总共用同一草稿，业务稍后保存不会还原已经保存的算价参数',async()=>{
  const s=setup();const business=s.context.sectionDraft(s.section);
  assert.equal(business,s.payload);s.payload.shipping.markup_x=1.8;await s.save();
  business.header.currency='USD';await s.context.putSection(s.section,business,false);
  assert.equal(s.requests.at(-1).payload.shipping.markup_x,1.8);
  assert.equal(s.requests.at(-1).payload.header.currency,'USD');
});

test('等待或失败的汇总保存可被部门切换、快捷键等待，不把未完成保存报告成功',async()=>{
  const gate=deferred();const s=setup(async()=>{await gate.promise;return {filled_at:'v1'};});
  s.payload.shipping.markup_x=1.5;s.save();let finished=false;
  const flush=s.host.saveShippingSummary().then(()=>{finished=true;});await tick();assert.equal(finished,false);
  gate.resolve();await flush;assert.equal(finished,true);assert.equal(s.states.at(-1),false);
});

test('已审核、已锁定和无权限均不能在汇总编辑；已审核显示解除审核原因',()=>{
  const s=setup();
  for(const [status,locked,edit] of [['approved',false,true],['empty',true,true],['empty',false,false]]) {
    const access=s.context.shippingSummaryEditState({...s.section,status},{edit},locked);
    assert.equal(access.editable,false);
    s.context.mountShippingSummarySave(s.host,s.section,s.payload,access);
    assert.equal(s.host.saveShippingSummary,null);
    if(edit)assert.match(s.host.querySelector('#shipping-summary-save').textContent,locked?/已锁定/:/解除业务部审核/);
  }
  assert.equal(s.requests.length,0);
  assert.equal(s.context.shippingSummaryEditState(s.section,{edit:true},false).editable,true);
});

test('实际算价表码点输入触发保存，保留汇总控制器的成功提示',async()=>{
  const s=setup();
  const start=source.indexOf('function renderShipping('),end=source.indexOf('function renderSales(',start);
  vm.runInContext(source.slice(start,end),s.context);
  const host=s.host.querySelector('#wb-shipping-sum');
  s.context.renderShipping(host,s.payload,{fx_hkd_usd:7.8},true,s.save,{},5.6759,null,{},{});
  const bases=[...host.innerHTML.matchAll(/<input class="sc-base"[^>]*>/g)].map(match=>match[0]);
  assert.ok(bases.length>0);assert.ok(bases.every(tag=>tag.includes('disabled')&&tag.includes('自动取各部门')),'自动成本小计不得显示为可编辑');
  const input=host.querySelector('#sh-markup');input.value='1.6';input.oninput();await tick();
  assert.equal(s.requests.at(-1).payload.shipping.markup_x,1.6);
  assert.match(s.status().textContent,/已保存/);
});
