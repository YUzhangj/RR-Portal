const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {assemblyGroupsTotal}=require('../backend/services/assemblyMix');
const {calculateMixedQuote}=require('../backend/services/mixedQuotation');
const cfg={enabled:true,mode:'ratio',na_direct:true,units_per_pack:1,products:[{id:'a',code:'A',name:'产品A',ratio:.4,na_ratio:.4},{id:'b',code:'B',name:'产品B',ratio:.6,na_ratio:.6}]};
const stepGroup=count=>({product:'工序组',qty:12000,team:1,steps:[{name:'装配',count}]});
const fixture=()=>({mixed_products:{a:{assembly_base_rate:290,assembly_std_time:11,assembly_step_groups:[stepGroup(14)],assembly_labor:[{name:'手填装工',unit_price:.1,qty:1}]},b:{assembly_base_rate:310,assembly_step_groups:[stepGroup(13)]},removed:{assembly_base_rate:999}},mixed_shared:{assembly_base_rate:310,packaging_step_groups:[stepGroup(27)],packaging_materials:[{name:'原资料'}]}});
function setup(edit=true,configuration=cfg){
 const element=()=>({nodes:{},children:[],_html:'',textContent:'',style:{},dataset:{},value:'',hidden:false,
  get innerHTML(){return this._html;},set innerHTML(value){this._html=value;this.nodes={};this.children=[];},
  appendChild(v){this.children.push(v);},insertBefore(v){this.children.push(v);},
  querySelector(key){return this.nodes[key] ||= element();},
  querySelectorAll(key){if(key==='[data-assembly-product]')return this.nodes.rows ||= [...this._html.matchAll(/data-assembly-product="([^"]+)"/g)].map(match=>({dataset:{assemblyProduct:match[1]},hidden:false}));if(key==='[data-open-assembly-product]')return this.nodes.links ||= [...this._html.matchAll(/data-open-assembly-product="([^"]+)"/g)].map(match=>({dataset:{openAssemblyProduct:match[1]}}));return [];}});
 const root=fixture(),host=element(),rendered=[],session=new Map();let changes=0;
 const window={__data:{quote:{id:12,qty:12000},mixed_quote:configuration,sections:[]}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/mixed-quotation.js'),'utf8'),{window,document:{createElement:element},sessionStorage:{getItem:key=>session.get(key)||null,setItem:(key,value)=>session.set(key,value)},defaultAssemblyBaseRateForFactory:()=>310,assemblyGroupsTotal});
 window.MixedQuotation.wrap((host,payload,editable,onChange)=>rendered.push({host,payload,editable,onChange}),'assembly')(host,root,edit,()=>changes++);
 assert.equal(rendered.length,0,'整体资料不应渲染单款编辑器');
 return {root,host,detail:host.querySelector('.mixed-detail'),api:window.MixedQuotation,rendered,session,changes:()=>changes};
}

test('整体装工可统一修改所有小产品及共用基数，人数目标及工序资料保留',()=>{
 const s=setup(),before=structuredClone(s.root);
 assert.match(s.detail.innerHTML,/统一基数 HKD\/人/);assert.match(s.detail.innerHTML,/value="" placeholder="当前多种基数"/);
 s.detail.querySelector('[data-assembly-bulk-base]').value='300';
 s.detail.querySelector('[data-apply-assembly-base]').onclick();
 for(const id of ['a','b'])assert.equal(s.root.mixed_products[id].assembly_base_rate,300);
 assert.equal(s.root.mixed_shared.assembly_base_rate,300);assert.equal(s.root.mixed_products.removed.assembly_base_rate,999);
 assert.deepEqual(s.root.mixed_products.a.assembly_step_groups,before.mixed_products.a.assembly_step_groups);
 assert.deepEqual(s.root.mixed_shared.packaging_step_groups,before.mixed_shared.packaging_step_groups);
 assert.deepEqual(s.root.mixed_products.a.assembly_labor,before.mixed_products.a.assembly_labor);
 assert.equal(s.changes(),1);assert.match(s.detail.innerHTML,/value="300"/);
 assert.match(s.detail.innerHTML,/0.4500/);assert.match(s.detail.querySelector('[data-assembly-base-status]').textContent,/请保存装配部草稿/);
});

test('搜索仅影响显示，统一基数覆盖未显示小产品；只读无修改入口',()=>{
 const s=setup();s.detail.querySelector('input[type="search"]').oninput({target:{value:'A'}});
 assert.equal(s.detail.querySelectorAll('[data-assembly-product]')[1].hidden,true);
 s.detail.querySelector('[data-assembly-bulk-base]').value='320';s.detail.querySelector('[data-apply-assembly-base]').onclick();
 assert.equal(s.root.mixed_products.b.assembly_base_rate,320);
 const readonly=setup(false);assert.match(readonly.detail.innerHTML,/data-apply-assembly-base disabled/);
 assert.equal(readonly.detail.querySelector('[data-apply-assembly-base]').onclick,undefined);
});

test('装工自然排序、共有费用置底及搜索保持产品绑定，不改变配置顺序',()=>{
 const configuration={...cfg,products:[
  {...cfg.products[0],code:'SKU-2',name:'乙款'},
  {...cfg.products[1],code:'SKU-10',name:'十号'},
  {id:'c',code:'SKU-1',name:'一号',ratio:.2,na_ratio:.2},
 ]};
 const before=JSON.stringify(configuration),s=setup(true,configuration);
 const ids=()=>s.detail.querySelectorAll('[data-assembly-product]').map(row=>row.dataset.assemblyProduct);
 assert.deepEqual(ids(),['c','a','b','__shared__']);
 assert.match(s.detail.innerHTML,/<tr data-assembly-product="c"><td><button[^>]+>SKU-1<\/button><\/td>/);
 assert.match(s.detail.innerHTML,/<tr data-assembly-product="a"><td><button[^>]+>SKU-2<\/button><\/td>/);
 assert.match(s.detail.innerHTML,/<tr data-assembly-product="b"><td><button[^>]+>SKU-10<\/button><\/td>/);
 for(const [query,expected] of [
  ['SKU-2',['a']],['十号',['b']],['  sku-1  ',['c','b']],['Sku-',['c','a','b']],
  ['共有费用',['__shared__']],['不存在',[]],['乙款',['a']],['',['c','a','b','__shared__']],
 ]){
  s.detail.querySelector('input[type="search"]').oninput({target:{value:query}});
  assert.deepEqual(s.detail.querySelectorAll('[data-assembly-product]').filter(row=>!row.hidden).map(row=>row.dataset.assemblyProduct),expected,query);
 }
 s.detail.querySelector('input[type="search"]').oninput({target:{value:'SKU-2'}});
 s.detail.querySelector('[data-assembly-bulk-base]').value='320';
 s.detail.querySelector('[data-apply-assembly-base]').onclick();
 for(const id of ['a','b','c'])assert.equal(s.root.mixed_products[id].assembly_base_rate,320);
 assert.equal(s.root.mixed_shared.assembly_base_rate,320);
 assert.equal(s.root.mixed_products.removed.assembly_base_rate,999);
 assert.deepEqual(ids(),['c','a','b','__shared__']);
 assert.equal(JSON.stringify(configuration),before);
});

test('空白负数及非法值不可批量写入，零基数可明确应用',()=>{
 const s=setup(),before=JSON.stringify(s.root);
 for(const value of ['', '-1', 'Infinity', 'abc']){
  s.detail.querySelector('[data-assembly-bulk-base]').value=value;s.detail.querySelector('[data-apply-assembly-base]').onclick();
  assert.equal(JSON.stringify(s.root),before);assert.equal(s.changes(),0);
 }
 s.api.applyAssemblyBaseRate(s.root,{products:[...cfg.products,{id:'new'}]},'0');
 assert.equal(s.root.mixed_products.new.assembly_base_rate,0);assert.equal(s.root.mixed_shared.assembly_base_rate,0);
});

test('序列化保存后混装汇总使用统一基数，NA配比及共用包装仅计一次',()=>{
 const s=setup();s.api.applyAssemblyBaseRate(s.root,cfg,'310');
 const sections=Object.entries({sales:{mixed_quote:cfg},assembly:s.root,molding:{mixed_molds:[]}}).map(([dept,payload])=>({dept,payload_json:JSON.stringify(payload)}));
 const result=calculateMixedQuote({qty:12000},sections,{strict:true});
 const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
 near(result.products[0].components.assembly_labor,310*14/12000+.1);
 near(result.products[1].components.assembly_labor,310*13/12000);
 near(result.common_components.assembly_labor,310*27/12000);
 near(result.components.assembly_labor,(310*14/12000+.1)*.4+(310*13/12000)*.6+310*27/12000);
});

test('统一目标数更新全部小产品及包装工序，保留搜索筛选及其他装工参数',()=>{
 const s=setup(),before=structuredClone(s.root);
 s.root.mixed_products.a.packaging_step_groups=[stepGroup(2),{...stepGroup(3),qty:8000}];
 s.detail.querySelector('input[type="search"]').value='A';
 s.detail.querySelector('input[type="search"]').oninput({target:{value:'A'}});
 s.detail.querySelector('[data-assembly-bulk-target]').value='6000';
 s.detail.querySelector('[data-apply-assembly-target]').onclick();
 for(const payload of [s.root.mixed_products.a,s.root.mixed_products.b,s.root.mixed_shared]) {
  for(const group of [...(payload.assembly_step_groups||[]),...(payload.packaging_step_groups||[])])assert.equal(group.qty,6000);
 }
 assert.equal(s.root.mixed_products.a.assembly_base_rate,290);
 assert.equal(s.root.mixed_products.a.assembly_std_time,11);
 assert.deepEqual(s.root.mixed_products.a.assembly_step_groups[0].steps,before.mixed_products.a.assembly_step_groups[0].steps);
 assert.deepEqual(s.root.mixed_products.a.assembly_labor,before.mixed_products.a.assembly_labor);
 assert.deepEqual(s.root.mixed_products.removed,before.mixed_products.removed);
 assert.equal(s.detail.querySelector('input[type="search"]').value,'A');
 assert.equal(s.detail.querySelectorAll('[data-assembly-product]')[1].hidden,true);
 assert.equal(s.changes(),1);assert.match(s.detail.innerHTML,/data-assembly-bulk-target[^>]*value="6000"/);
 assert.match(s.detail.querySelector('[data-assembly-target-status]').textContent,/请保存装配部草稿/);
 const readonly=setup(false);assert.match(readonly.detail.innerHTML,/data-apply-assembly-target disabled/);
 assert.equal(readonly.detail.querySelector('[data-apply-assembly-target]').onclick,undefined);
});

test('目标数无效或没有工序时不写入，重新计算保留原比例并只计一次共有包装',()=>{
 const s=setup(),before=JSON.stringify(s.root);
 for(const value of ['', '0', '-1', 'Infinity', 'abc']) {
  s.detail.querySelector('[data-assembly-bulk-target]').value=value;
  s.detail.querySelector('[data-apply-assembly-target]').onclick();
  assert.equal(JSON.stringify(s.root),before);assert.equal(s.changes(),0);
 }
 const empty={mixed_products:{a:{}},mixed_shared:{}};
 assert.throws(()=>s.api.applyAssemblyTarget(empty,cfg,'6000'),/先导入或填写/);
 assert.deepEqual(empty,{mixed_products:{a:{}},mixed_shared:{}});
 s.api.applyAssemblyTarget(s.root,cfg,'6000');
 const restored=JSON.parse(JSON.stringify(s.root));
 const sections=Object.entries({sales:{mixed_quote:cfg},assembly:restored,molding:{mixed_molds:[]}}).map(([dept,payload])=>({dept,payload_json:JSON.stringify(payload)}));
 const result=calculateMixedQuote({qty:12000},sections,{strict:true});
 assert.ok(Math.abs(result.components.assembly_labor-((290*14/6000+.1)*.4+310*13/6000*.6+310*27/6000))<1e-10);
 assert.deepEqual(result.products.map(p=>p.weight),[.4,.6]);
});

test('点击货号按产品标识打开明细，返回保留修改、搜索和滚动位置，共有费用可直接进入',()=>{
 const s=setup(),before=JSON.stringify(s.root);
 const open=id=>s.detail.querySelectorAll('[data-open-assembly-product]').find(button=>button.dataset.openAssemblyProduct===id).onclick();
 s.detail.querySelector('input[type="search"]').value='B';
 s.detail.querySelector('input[type="search"]').oninput({target:{value:'B'}});
 s.detail.querySelector('.mixed-scroll').scrollLeft=180;
 s.detail.querySelector('.mixed-scroll').scrollTop=80;
 open('b');
 assert.equal(s.rendered[0].payload,s.root.mixed_products.b);
 assert.equal(s.rendered[0].editable,true);assert.equal(s.host.querySelector('select').value,'b');
 assert.equal(JSON.stringify(s.root),before);assert.equal(s.changes(),0);
 s.rendered[0].payload.assembly_step_groups[0].steps[0].count=20;s.rendered[0].onChange();
 s.detail.children[0].querySelector('button').onclick();
 assert.equal(s.host.querySelector('select').value,'__overall__');
 assert.equal(s.detail.querySelector('input[type="search"]').value,'B');
 assert.equal(s.detail.querySelector('.mixed-scroll').scrollLeft,180);
 assert.equal(s.detail.querySelector('.mixed-scroll').scrollTop,80);
 assert.equal(s.detail.querySelectorAll('[data-assembly-product]')[0].hidden,true);
 assert.equal(s.root.mixed_products.b.assembly_step_groups[0].steps[0].count,20);
 assert.equal(s.root.mixed_products.a.assembly_step_groups[0].steps[0].count,14);
 assert.equal(s.changes(),1);assert.match(s.detail.innerHTML,/0.5167/);
 open('__shared__');assert.equal(s.rendered[1].payload,s.root.mixed_shared);
});

test('只读货号入口复用已有编辑权限按钮，没有编辑入口时只查看',()=>{
 for(const mayEdit of [true,false]) {
  const s=setup(false);let entered=0;
  s.host.closest=selector=>{assert.equal(selector,'.section-pane');return {querySelector:()=>mayEdit?{click:()=>entered++}:null};};
  s.detail.querySelectorAll('[data-open-assembly-product]')[1].onclick();
  assert.equal(entered,mayEdit?1:0);assert.equal(s.changes(),0);
  assert.equal(s.session.get('mixed:12:assembly:overall-v1'),'b');
  if(mayEdit)assert.equal(s.rendered.length,0,'进入编辑由现有权限流程重新渲染');
  else {assert.equal(s.rendered.length,1);assert.equal(s.rendered[0].editable,false);}
 }
});
