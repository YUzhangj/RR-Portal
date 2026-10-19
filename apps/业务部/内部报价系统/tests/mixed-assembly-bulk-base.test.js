const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {assemblyGroupsTotal}=require('../backend/services/assemblyMix');
const {calculateMixedQuote}=require('../backend/services/mixedQuotation');
const cfg={enabled:true,mode:'ratio',na_direct:true,units_per_pack:1,products:[{id:'a',code:'A',name:'产品A',ratio:.4,na_ratio:.4},{id:'b',code:'B',name:'产品B',ratio:.6,na_ratio:.6}]};
const stepGroup=count=>({product:'工序组',qty:12000,team:1,steps:[{name:'装配',count}]});
const fixture=()=>({mixed_products:{a:{assembly_base_rate:290,assembly_std_time:11,assembly_step_groups:[stepGroup(14)],assembly_labor:[{name:'手填装工',unit_price:.1,qty:1}]},b:{assembly_base_rate:310,assembly_step_groups:[stepGroup(13)]},removed:{assembly_base_rate:999}},mixed_shared:{assembly_base_rate:310,packaging_step_groups:[stepGroup(27)],packaging_materials:[{name:'原资料'}]}});
function setup(edit=true){
 const element=()=>({nodes:{},children:[],_html:'',textContent:'',style:{},dataset:{},value:'',hidden:false,
  get innerHTML(){return this._html;},set innerHTML(value){this._html=value;this.nodes={};},
  appendChild(v){this.children.push(v);},insertBefore(v){this.children.push(v);},
  querySelector(key){return this.nodes[key] ||= element();},
  querySelectorAll(key){if(key==='[data-assembly-product]')return this.nodes.rows ||= [...this._html.matchAll(/data-assembly-product="([^"]+)"/g)].map(()=>({hidden:false}));return [];}});
 const root=fixture(),host=element();let changes=0;
 const window={__data:{quote:{id:12,qty:12000},mixed_quote:cfg,sections:[]}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/mixed-quotation.js'),'utf8'),{window,document:{createElement:element},sessionStorage:{getItem:()=>null,setItem(){}},defaultAssemblyBaseRateForFactory:()=>310,assemblyGroupsTotal});
 window.MixedQuotation.wrap(()=>assert.fail('整体资料不应渲染单款编辑器'),'assembly')(host,root,edit,()=>changes++);
 return {root,host,detail:host.querySelector('.mixed-detail'),api:window.MixedQuotation,changes:()=>changes};
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
