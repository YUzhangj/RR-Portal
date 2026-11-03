const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../frontend/verification.js'),'utf8');
function fixture(){
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:''});return nodes.get(id);};
  const listState=[
    {id:1,quote_no:'AB-001',product_name:'咖啡杯',customer:'A',current_version_label:'V1',approved_count:0,total_depts:8,verification_status:'drafting',workshop:'华登'},
    {id:2,quote_no:'AB-002',product_name:'杯盖',customer:'A',current_version_label:'V2',approved_count:4,total_depts:8,verification_status:'in_review',workshop:'兴信B'},
    {id:3,quote_no:'CD-003',product_name:'咖啡杯',customer:'B',current_version_label:'V1',approved_count:8,total_depts:8,verification_status:'completed',workshop:'河源'},
    {id:4,quote_no:'NEW-004',product_name:'待创建',customer:'C',total_depts:8},
  ];
  const context=vm.createContext({$,listState,num:v=>Number(v)||0,window:{VerificationCustomers:{display:value=>value}}});
  vm.runInContext(source.slice(source.indexOf('function filteredList('),source.indexOf('function renderList(')),context);
  return {$,listState,context,ids:()=>Array.from(context.filteredList(),r=>r.id)};
}
test('seven column filters combine, accept case-insensitive text and exact progress',()=>{
  const f=fixture();f.$('verification-no-filter').value=' ab- ';assert.deepEqual(f.ids(),[1,2]);
  f.$('verification-table-customer-filter').value='A';f.$('verification-progress-filter').value='ratio:4/8';assert.deepEqual(f.ids(),[2]);
  f.$('verification-version-filter').value='V2';f.$('verification-table-status-filter').value='in_review';f.$('workshop-filter').value='兴信B';assert.deepEqual(f.ids(),[2]);
  f.$('verification-product-filter').value='咖啡';assert.deepEqual(f.ids(),[]);
});
test('uncreated versions, missing workshops and category progress remain filterable',()=>{
  const pending=fixture();pending.$('verification-status-filter').value='unfinished';assert.deepEqual(pending.ids(),[1,2,4]);
  const f=fixture();f.$('verification-version-filter').value='not_started';f.$('verification-status-filter').value='not_started';f.$('workshop-filter').value='待分配车间';assert.deepEqual(f.ids(),[4]);
  f.$('verification-version-filter').value='';f.$('verification-status-filter').value='';f.$('workshop-filter').value='';f.$('verification-progress-filter').value='in_progress';assert.deepEqual(f.ids(),[2]);
  f.$('verification-progress-filter').value='completed';assert.deepEqual(f.ids(),[3]);
});
test('paired filters synchronize; clearing resets all conditions and workshop selection',()=>{
  const f=fixture(),selected=new Set([1]),revisions=new Map([[1,'r1']]),count={renders:0};
  const listFilterIds=['verification-search','verification-status-filter','verification-customer-filter','verification-no-filter','verification-product-filter','verification-table-customer-filter','verification-version-filter','verification-progress-filter','verification-table-status-filter','workshop-filter','verification-table-workshop-filter'];
  Object.assign(f.context,{listFilterIds,workshopSelected:selected,workshopRevisions:revisions,renderList:()=>count.renders++});
  vm.runInContext(source.slice(source.indexOf('const pairedListFilters='),source.indexOf("$('workshop-select-visible').onchange")),f.context);
  const previewBinding=source.indexOf("$('verification-preview').addEventListener");
  const filterBinding=source.indexOf("for (const id of listFilterIds) {\n  const eventName");
  vm.runInContext(source.slice(filterBinding,previewBinding),f.context);
  f.$('verification-table-customer-filter').value='A';f.$('verification-table-customer-filter').onchange();
  assert.equal(f.$('verification-customer-filter').value,'A');assert.equal(selected.size,0);assert.equal(revisions.size,0);
  f.$('verification-table-workshop-filter').value='兴信B';f.$('verification-table-workshop-filter').onchange();
  assert.equal(f.$('workshop-filter').value,'兴信B');
  f.$('verification-no-filter').value='AB';f.$('verification-progress-filter').value='ratio:4/8';selected.add(2);
  f.$('verification-clear-filters').onclick();
  assert.ok(listFilterIds.every(id=>f.$(id).value===''));assert.equal(selected.size,0);assert.equal(revisions.size,0);assert.equal(count.renders,3);assert.deepEqual(f.ids(),[1,2,3,4]);
});
