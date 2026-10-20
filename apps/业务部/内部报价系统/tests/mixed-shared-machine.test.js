const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = require('../frontend/mixed-molds');
const config = {enabled:true,mode:'equal',units_per_pack:1,products:[{id:'p',code:'P',name:'产品'}]};
function fixture() {
  return {machine_prices:[{model:'14A',normal:'150T',price:1200}],parts_catalog:{version:1,parts:[
    {id:'a',mold_no:'M1',name:'瓶盖',cavity:2,production_demand:4000,machine_model:'14A',target:3000},
    {id:'b',mold_no:' M1 ',name:'瓶身',cavity:4,production_demand:4000},
    {id:'c',mold_no:'M2',name:'其他模',cavity:1,production_demand:100,machine_model:'14A',target:1000},
    {id:'d',mold_no:'',name:'无模号一',cavity:1,production_demand:100,machine_model:'14A',target:1000},
    {id:'e',mold_no:'',name:'无模号二',cavity:1,production_demand:100,machine_model:'14A',target:1000},
  ],selections:{p:[{part_id:'a',usage:1},{part_id:'b',usage:1}]}}};
}

test('同模号填写一次，后端重算和序列化使用相同参数，保留独立出模数及需求',()=>{
  const root=fixture(),before=structuredClone(root),[a,b,c,d,e]=root.parts_catalog.parts;
  assert.equal(M.catalogRows(root,config,100).resolved.get('b').shot_cost,.4);
  M.updateCatalogMoldField(root,b,'target',4000);
  M.updateCatalogMoldField(root,a,'machine_model','14A');
  assert.equal(a.target,4000);assert.equal(b.target,4000);
  assert.equal(a.machine,'150T');assert.equal(b.machine,'150T');
  assert.deepEqual([a.cavity,b.cavity,a.production_demand,b.production_demand],[2,4,4000,4000]);
  assert.deepEqual([c,d,e],before.parts_catalog.parts.slice(2));
  const reloaded=JSON.parse(JSON.stringify(root));
  assert.equal(M.catalogRows(reloaded,config,100).resolved.get('a').shot_cost,.3);
  assert.equal(M.catalogRows(reloaded,config,100).resolved.get('b').shot_cost,.3);
  M.updateCatalogMoldField(root,d,'target',5000);
  assert.equal(d.target,5000);assert.equal(e.target,1000);
  assert.throws(()=>M.updateCatalogMoldField(root,a,'production_demand',999),/不支持/);
});

test('同模旧参数冲突不取任意一行，统一填写后解除冲突',()=>{
  const root=fixture(),[a,b]=root.parts_catalog.parts;
  b.target=2000;
  assert.equal(M.catalogMoldField(root,a,'target').conflict,true);
  assert.throws(()=>M.catalogRows(root,config,100),/同模具.*必须一致/);
  M.updateCatalogMoldField(root,a,'target',3000);
  assert.equal(M.catalogRows(root,config,100).resolved.get('b').shot_cost,.4);
  b.machine_model='20A';
  assert.throws(()=>M.catalogRows(root,config,100),/同模具.*必须一致/);
});

test('旧表数字格式及机型大小写不产生假冲突，目录外机型价表照常匹配',()=>{
  const root=fixture(),[a,b]=root.parts_catalog.parts;
  b.target='3000.0';b.machine_model='14a';
  assert.equal(M.catalogMoldField(root,a,'target').conflict,false);
  assert.equal(M.catalogMoldField(root,a,'machine_model').conflict,false);
  assert.equal(M.catalogRows(root,config,100).resolved.get('b').shot_cost,.4);
  assert.equal(M.catalogMachinePrice({machine_prices:root.machine_prices},{mold_no:'Outside',machine_model:'14A'}),1200);
});

// Minimal DOM that retains the actual rendered rows, fields and callbacks.
function element(html='') {
  const node={_html:html,nodes:{},children:[],dataset:{},style:{},value:'',textContent:'',hidden:false,
    get innerHTML(){return this._html;},set innerHTML(value){this._html=value;this.nodes={};},
    append(...nodes){this.children.push(...nodes);},appendChild(node){this.children.push(node);},
    addEventListener(){},remove(){},
    querySelector(selector){
      const cell=/^\[data-catalog-cell="([^"]+)"\]$/.exec(selector);
      if(cell){const match=this._html.match(new RegExp(`<td data-catalog-cell="${cell[1]}"[^>]*>([\\s\\S]*?)<\\/td>`));return match ? (this.nodes[selector] ||= element(match[1])) : null;}
      if(['span','input','small'].includes(selector) && !this._html.includes('<'+selector))return null;
      return this.nodes[selector] ||= element();
    },
    querySelectorAll(selector){
      if(this.nodes[selector])return this.nodes[selector];
      if(selector==='[data-part-id]' || selector==='[data-mold-heading]') {
        const attr=selector.slice(1,-1),key=attr==='data-part-id'?'partId':'moldHeading';
        return this.nodes[selector]=[...this._html.matchAll(new RegExp(`<tr ${attr}="([^"]*)">([\\s\\S]*?)<\\/tr>`,'g'))].map(match=>{const row=element(match[2]);row.dataset[key]=match[1];return row;});
      }
      if(selector==='[data-field]')return this.nodes[selector]=[...this._html.matchAll(/<(input|select)\b([^>]*data-field="([^"]+)"[^>]*)>/g)].map(match=>({
        dataset:{field:match[3]},tagName:match[1].toUpperCase(),type:/type="([^"]+)"/.exec(match[2])?.[1] || 'text',
        value:/value="([^"]*)"/.exec(match[2])?.[1] || '',parentElement:element(),
      }));
      return [];
    },
  };return node;
}
function render(edit=true) {
  const root=fixture(),host=element();let changes=0;
  const window={MixedMolds:M,__data:{quote:{id:12,qty:100},mixed_quote:config,sections:[]},renderImageCell(){},renderTable(){}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/mixed-quotation.js'),'utf8'),{
    window,document:{createElement:()=>element()},sessionStorage:{getItem:()=>null,setItem(){}},
  });
  window.MixedQuotation.wrap(()=>assert.fail('统一目录不应进入单品编辑器'),'molding')(host,root,edit,()=>changes++);
  return {root,host:host.querySelector('.mixed-detail').children[0],changes:()=>changes};
}

test('页面将同模三列合并，输入一次同步整模，搜索保留合并单元格和同模零件',()=>{
  const view=render(),rows=view.host.querySelectorAll('[data-part-id]');
  for(const field of ['machine_model','machine','target']) {
    assert.match(rows[0].innerHTML,new RegExp(`data-catalog-cell="${field}" rowspan="2"`));
    assert.doesNotMatch(rows[1].innerHTML,new RegExp(`data-catalog-cell="${field}"`));
    assert.doesNotMatch(rows[3].innerHTML,new RegExp(`data-catalog-cell="${field}" rowspan`));
  }
  const target=rows[0].querySelectorAll('[data-field]').find(field=>field.dataset.field==='target');
  target.value='5000';target.oninput();
  assert.equal(view.root.parts_catalog.parts[0].target,5000);
  assert.equal(view.root.parts_catalog.parts[1].target,5000);
  assert.equal(view.changes(),1);
  view.host.querySelector('[data-part-search]').oninput({target:{value:'瓶身'}});
  assert.equal(rows[0].hidden,false);assert.equal(rows[1].hidden,false);assert.equal(rows[2].hidden,true);
  assert.match(render(false).host.innerHTML,/data-field="target"[^>]*disabled/);
});
