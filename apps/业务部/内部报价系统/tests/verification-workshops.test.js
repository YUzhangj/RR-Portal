const test=require('node:test'),assert=require('node:assert/strict');
const {resolveWorkshop}=require('../backend/services/verificationWorkshops');
const G=require('../frontend/verification-report-groups');
const {buildWorkbook,localFormula}=require('../backend/services/verificationWorkshopExport');
const {columns}=require('../backend/services/verificationSummary');
test('historical customer + SKU mappings, FX variants and unknowns',()=>{
  const w=(customer,quote_no)=>resolveWorkshop({customer,quote_no},[]).workshop;
  assert.equal(w('ZURU','92125'),'兴信B');assert.equal(w('Cepia','G1002'),'兴信B');
  assert.equal(w('Cepia','Z1000'),'兴信A');assert.equal(w('Cepia','D1026'),G.pending);
  assert.equal(w('Sky Castle','JC100'),'华登');assert.equal(w('Sky Castle','JS100CDU-12'),'华登');
  assert.equal(w('ZANZOON','1125155（新款五角星）'),'兴信B');
  assert.equal(w('ZURU','not-in-file'),G.pending);
});
test('new explicit assignment wins; conflicting source mappings are not guessed',()=>{
  const q={customer:'ZURU',quote_no:'92125'},sections=[{dept:'sales',payload_json:JSON.stringify({header:{workshop:'A'}})}];
  assert.equal(resolveWorkshop(q,sections).workshop,'兴信A');
  assert.equal(resolveWorkshop(q,[],[{customer:'ZURU',sku:'92125',workshop:'兴信A'},{customer:'ZURU',sku:'92125',workshop:'兴信B'}]).workshop,G.pending);
});
function row(id,customer,workshop,qty,price,amount){return {id,workshop,values:{A:customer,B:'sku'+id,C:'product',D:qty,E:price,F:price/2,DI:amount,DX:amount/4,DZ:amount/10,J:amount/5},sources:{},formulas:{DI:'D1*E1'},issues:[],missing:[]};}
function findRow(ws,predicate,label){
  const matches=[];ws.eachRow(r=>{if(predicate(r))matches.push(r.number);});
  assert.equal(matches.length,1,`${ws.name}: ${label}`);return matches[0];
}
const detailRow=(ws,source)=>findRow(ws,r=>r.getCell('B').value===source.values.B&&r.getCell('C').value===source.values.C,source.values.B);
const grandRow=ws=>findRow(ws,r=>r.getCell('C').value==='总合计','总合计');
function subtotalAfter(ws,detail){
  let number;ws.eachRow(r=>{if(!number&&r.number>detail&&r.getCell('C').value==='合计')number=r.number;});
  assert.ok(number,`${ws.name}: detail ${detail} has a local workshop subtotal`);return number;
}
test('one detail row per quote; subtotals and ratios reflect underlying amounts',()=>{
  const rs=[row(1,'A','兴信A',10,20,200),row(2,'A','兴信B',1,100,100),row(3,'B',null,2,50,100)];
  const detail=G.reportRows(rs,'customer-detail');assert.equal(detail.filter(r=>!r.kind).length,3);
  const total=G.reportRows(rs,'workshop-summary').at(-1);
  assert.equal(total.values.DI,400);assert.equal(total.values.K,0.2);assert.equal(total.members.length,3);
  rs[0].values.DI=400;rs[0].values.J=80;assert.equal(G.reportRows(rs,'customer-summary').at(-1).values.DI,600);
  rs[0].values.DI=null;assert.equal(G.aggregate(rs,'','').values.DI,null);assert.equal(G.aggregate(rs,'','').values.K,null);
});
test('export links customer subtotals and includes pending groups without duplicates',async()=>{
  const rs=[row(1,'A','兴信A',10,20,200),row(2,'A',null,1,100,100)];
  const wb=buildWorkbook(rs,columns),summary=wb.getWorksheet('总表不分车间');
  const summaryCustomer=findRow(summary,r=>r.getCell('A').value==='A'&&r.getCell('C').value==='客户合计','A客户合计');
  assert.match(summary.getCell(`DG${summaryCustomer}`).formula,/'A'!DI/);assert.equal(summary.getCell(`DG${summaryCustomer}`).result,.03);
  const detail=wb.getWorksheet('不分车间核价明细'),customer=wb.getWorksheet('A');
  for(const source of rs){
    const n=detailRow(detail,source),target=detailRow(customer,source);
    assert.equal(detail.getCell(`DI${n}`).formula,`IF(ISNUMBER('A'!DI${target}),'A'!DI${target},"")`);
  }
  assert.ok(customer.getColumn(1).values.some(v=>typeof v==='string'&&v.includes(G.pending)));
  const sums=wb.getWorksheet('总表分车间');assert.equal(sums.getCell(`DG${grandRow(sums)}`).result,.03);
  assert.ok((await wb.xlsx.writeBuffer()).length>1000);
});
test('customer export calculations use local rows and local detail subtotals',async()=>{
  const rs=[row(1,'Sky Castle','华登',100,10,1000),row(2,'Sky Castle','河源',20,10,200)];
  for(const r of rs){
    Object.assign(r.values,{H:0.5,I:0.5,J:r.values.D*0.5,K:0.05,L:1,M:1,N:r.values.D,O:0.1,P:0,Q:0,R:0,S:0,AN:2,AO:2-2/1.1*0.115,AP:(2-2/1.1*0.115)*r.values.D,AQ:(2-2/1.1*0.115)/10});
    Object.assign(r.formulas,{I:'H1',J:'I1*D1',K:'IF(DI1=0,"",J1/DI1)',M:'L1',N:'M1*D1',O:'IF(DI1=0,"",N1/DI1)',Q:'P1',R:'Q1*D1',S:'IF(DI1=0,"",R1/DI1)',AO:'AN1-AN1/1.1*11.5%',AP:'AO1*D1',AQ:'IF(DI1=0,"",AP1/DI1)'});
  }
  const wb=buildWorkbook(rs,columns),ws=wb.getWorksheet('Sky Castle');
  const [first,second]=rs.map(source=>detailRow(ws,source)),subtotals=[first,second].map(n=>subtotalAfter(ws,n));
  for(const source of rs){
    const n=detailRow(ws,source);
    for(const [c,f] of Object.entries(source.formulas))assert.equal(ws.getCell(`${c}${n}`).formula,localFormula(f,n));
  }
  assert.equal(ws.getCell(`J${subtotals[0]}`).formula,`IF(COUNT(J${first})=1,SUM(J${first}),"")`);
  assert.equal(ws.getCell(`J${grandRow(ws)}`).formula,`IF(COUNT(J${first},J${second})=2,SUM(J${first},J${second}),"")`);
  assert.equal(ws.getCell(`J${first}`).formula,`IF(COUNT(I${first},D${first})=2,I${first}*D${first},"")`);
  assert.equal(ws.getCell(`K${first}`).formula,`IF(COUNT(DI${first},J${first})=2,IF(DI${first}=0,"",J${first}/DI${first}),"")`);
  const summary=wb.getWorksheet('总表分车间');
  const formula=summary.getCell(`J${grandRow(summary)}`).formula;
  assert.ok(formula.includes(`'Sky Castle'!J${subtotals[0]}`));assert.ok(formula.includes(`'Sky Castle'!J${subtotals[1]}`));
  const saved=new (require('exceljs').Workbook)();await saved.xlsx.load(await wb.xlsx.writeBuffer());
  const reopened=saved.getWorksheet('Sky Castle'),n=detailRow(reopened,rs[0]);
  assert.equal(reopened.getCell(`J${n}`).formula,localFormula('I1*D1',n));
  assert.equal(reopened.getCell(`D${n}`).value,100);
  // Repeated workshop headers differ from consolidated detail rows. Link by the exact SKU.
  const detail=saved.getWorksheet('不分车间核价明细'),m=detailRow(detail,rs[1]),target=detailRow(reopened,rs[1]);
  assert.equal(detail.getCell(`J${m}`).formula,`IF(ISNUMBER('Sky Castle'!J${target}),'Sky Castle'!J${target},"")`);
  saved.getWorksheet('Sky Castle').eachRow(r=>r.eachCell(c=>{if(c.formula)assert.ok(!c.formula.includes('!'),c.formula);}));
});
test('missing and zero results retain formulas for later input edits',()=>{
  const r=row(1,'A','华登',null,10,null);
  r.values.J=null;r.values.K=null;
  r.formulas.J='I1*D1';r.formulas.K='IF(DI1=0,"",J1/DI1)';
  const ws=buildWorkbook([r],columns).getWorksheet('A'),n=detailRow(ws,r);
  assert.equal(ws.getCell(`J${n}`).formula,localFormula('I1*D1',n));
  assert.equal(ws.getCell(`J${subtotalAfter(ws,n)}`).formula,`IF(COUNT(J${n})=1,SUM(J${n}),"")`);
  assert.equal(ws.getCell(`K${n}`).formula,localFormula(r.formulas.K,n));
});
