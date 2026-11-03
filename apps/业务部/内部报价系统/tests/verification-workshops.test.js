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
  assert.match(summary.getCell('DG4').formula,/'A'!DI/);assert.equal(summary.getCell('DG4').result,0.03);
  const detail=wb.getWorksheet('不分车间核价明细');
  assert.equal(detail.getCell('DI4').formula,`IF(ISNUMBER('A'!DI4),'A'!DI4,"")`);
  assert.equal(detail.getCell('DI5').formula,`IF(ISNUMBER('A'!DI8),'A'!DI8,"")`);
  const customer=wb.getWorksheet('A');assert.ok(customer.getColumn(1).values.some(v=>typeof v==='string'&&v.includes(G.pending)));
  const sums=wb.getWorksheet('总表分车间');assert.equal(sums.getCell(`DG${sums.rowCount}`).result,0.03);
  assert.ok((await wb.xlsx.writeBuffer()).length>1000);
});
test('workshop summary, print and screenshot use the same sectioned export format',()=>{
  const rs=[row(1,'B','兴信B',1,10,10),row(2,'A','华登',1,10,10),row(3,'C','兴信A',1,10,10)];
  const wb=buildWorkbook(rs,columns,{now:new Date('2026-11-03T04:00:00Z')});
  for(const sheetName of ['总表分车间','打印','截图']){
    const ws=wb.getWorksheet(sheetName);
    assert.equal(ws.getCell('A1').value,'2026年11月份华登各客实际生意核价总表（ABS 6.5；汇率 0.87）');
    assert.equal(ws.getCell('A6').value,'2026年11月份兴信A各客实际生意核价总表（ABS 6.5；汇率 0.87）');
    assert.equal(ws.getCell('A11').value,'2026年11月份兴信B各客实际生意核价总表（ABS 6.5；汇率 0.87）');
    for(const rowNumber of [2,7,12])assert.equal(ws.getCell(`A${rowNumber}`).value,'负责人');
    for(const rowNumber of [3,8,13])assert.equal(ws.getCell(`A${rowNumber}`).value,'客名');
    assert.ok(ws.model.merges.includes('A1:EE1'));assert.ok(ws.model.merges.includes('A6:EE6'));assert.ok(ws.model.merges.includes('A11:EE11'));
    assert.equal(ws.getCell('A4').value,'A');assert.equal(ws.getCell('C4').value,'客户小计');
    for(const rowNumber of [5,10,15])assert.equal(ws.getCell(`A${rowNumber}`).value,'合计：');
    assert.equal(ws.getCell('A16').value,null);assert.equal(ws.getCell('A17').value,'总合计：');assert.equal(ws.getCell('C17').value,'总合计');
    for(const rowNumber of [5,10,15,17])assert.equal(ws.getCell(`A${rowNumber}`).fill.fgColor.argb,'FFDAE3F3');
    for(const address of ['A2','A3','A4','A5','DG3','DG4'])assert.equal(ws.getCell(address).font.size,16,`${sheetName} ${address}`);
    assert.equal(ws.autoFilter,null);assert.equal(ws.getCell('A1').alignment.horizontal,'center');
    assert.equal(ws.getCell('A4').fill?.pattern,undefined);
  }
});
test('customer summary uses the active factory, export month and one final total label',()=>{
  const rs=[row(1,'A','华登',1,10,10),row(2,'B','兴信A',1,20,20)];
  const wb=buildWorkbook(rs,columns,{now:new Date('2026-11-03T04:00:00Z'),factoryName:'清溪'});
  for(const sheetName of ['总表不分车间','不分车间 打印']){
    const ws=wb.getWorksheet(sheetName);
    assert.equal(ws.getCell('A1').value,'清溪厂区---2026年11月份各客实际生意核价总表（ABS 6.5；汇率 0.87）');
    assert.ok(ws.model.merges.includes('A1:EE1'));
    assert.equal(ws.getCell('A1').alignment.horizontal,'center');
    assert.equal(ws.getCell(`A${ws.rowCount}`).value,'合计：');
    assert.equal(ws.getCell(`C${ws.rowCount}`).value,'总合计');
    assert.equal(ws.getCell(`A${ws.rowCount}`).fill.fgColor.argb,'FFDAE3F3');
    for(const address of ['A2','A3','A4',`A${ws.rowCount}`,'DG3','DG4'])assert.equal(ws.getCell(address).font.size,16,`${sheetName} ${address}`);
  }
});
test('every exported worksheet uses 16 point table text',()=>{
  const wb=buildWorkbook([row(1,'A','华登',1,10,10)],columns);
  const checks={
    '总表分车间':['A2','A3','A4','A5'],
    '打印':['A2','A3','A4','A5'],
    '截图':['A2','A3','A4','A5'],
    '总表不分车间':['A2','A3','A4','A5'],
    '不分车间 打印':['A2','A3','A4','A5'],
    '不分车间核价明细':['A2','A3','A4','A5'],
    'A':['A2','A3','A4','A5'],
    '生成提示':['A1','A2']
  };
  for(const [sheetName,addresses] of Object.entries(checks))for(const address of addresses){
    assert.equal(wb.getWorksheet(sheetName).getCell(address).font.size,16,`${sheetName} ${address}`);
  }
});
test('all-customer detail repeats headers and adds a blue customer total',()=>{
  const rs=[row(1,'A','兴信A',10,20,200),row(2,'A','兴信B',1,100,100),row(3,'B','华登',2,50,100)];
  const ws=buildWorkbook(rs,columns,{now:new Date('2026-11-03T04:00:00Z')}).getWorksheet('不分车间核价明细');
  assert.equal(ws.getCell('A1').value,'2026年');
  for(const rowNumber of [2,7])assert.equal(ws.getCell(`A${rowNumber}`).value,'负责人');
  for(const rowNumber of [3,8])assert.equal(ws.getCell(`A${rowNumber}`).value,'客名');
  assert.equal(ws.getCell('B4').value,'sku1');assert.equal(ws.getCell('B5').value,'sku2');assert.equal(ws.getCell('B9').value,'sku3');
  for(const rowNumber of [6,10]){
    assert.equal(ws.getCell(`C${rowNumber}`).value,'合计');
    assert.equal(ws.getCell(`A${rowNumber}`).fill.fgColor.argb,'FF9DC3E6');
    assert.equal(ws.getCell(`A${rowNumber}`).font.size,16);
  }
  assert.equal(ws.getCell('D6').formula,'IF(COUNT(D4,D5)=2,SUM(D4,D5),"")');
  assert.equal(ws.getCell('D10').formula,'IF(COUNT(D9)=1,SUM(D9),"")');
  assert.equal(ws.autoFilter,null);
  assert.deepEqual(ws.model.merges,['A1:U1']);
});
test('individual customer sheets repeat each workshop header and use blue totals',()=>{
  const rs=[row(1,'A','兴信A',10,20,200),row(2,'A','兴信B',1,100,100)];
  const ws=buildWorkbook(rs,columns,{now:new Date('2026-11-03T04:00:00Z')}).getWorksheet('A');
  assert.equal(ws.getCell('A1').value,'2026年 兴信A各客产品核价总表（ABS 6.5；汇率 0.87）');
  assert.equal(ws.getCell('A2').value,'A');assert.equal(ws.getCell('A3').value,'客名');
  assert.equal(ws.getCell('A6').value,'B');assert.equal(ws.getCell('A7').value,'客名');
  assert.equal(ws.getCell('B4').value,'sku1');assert.equal(ws.getCell('B8').value,'sku2');
  assert.equal(ws.getCell('C5').value,'合计');assert.equal(ws.getCell('C9').value,'合计');assert.equal(ws.getCell('C10').value,'总合计');
  for(const rowNumber of [5,9,10]){
    assert.equal(ws.getCell(`A${rowNumber}`).fill.fgColor.argb,'FF9DC3E6');
    assert.equal(ws.getCell(`A${rowNumber}`).font.size,16);
  }
  assert.equal(ws.getCell('D5').formula,'IF(COUNT(D4)=1,SUM(D4),"")');
  assert.equal(ws.getCell('D9').formula,'IF(COUNT(D8)=1,SUM(D8),"")');
  assert.equal(ws.getCell('D10').formula,'IF(COUNT(D4,D8)=2,SUM(D4,D8),"")');
  assert.equal(ws.autoFilter,null);
});
test('customer export calculations use local rows and local detail subtotals',async()=>{
  const rs=[row(1,'Sky Castle','华登',100,10,1000),row(2,'Sky Castle','河源',20,10,200)];
  for(const r of rs){
    Object.assign(r.values,{H:0.5,I:0.5,J:r.values.D*0.5,K:0.05,L:1,M:1,N:r.values.D,O:0.1,P:0,Q:0,R:0,S:0,AN:2,AO:2-2/1.1*0.115,AP:(2-2/1.1*0.115)*r.values.D,AQ:(2-2/1.1*0.115)/10});
    Object.assign(r.formulas,{I:'H1',J:'I1*D1',K:'IF(DI1=0,"",J1/DI1)',M:'L1',N:'M1*D1',O:'IF(DI1=0,"",N1/DI1)',Q:'P1',R:'Q1*D1',S:'IF(DI1=0,"",R1/DI1)',AO:'AN1-AN1/1.1*11.5%',AP:'AO1*D1',AQ:'IF(DI1=0,"",AP1/DI1)'});
  }
  const wb=buildWorkbook(rs,columns),ws=wb.getWorksheet('Sky Castle');
  for(const n of [4,8]){
    for(const [c,f] of Object.entries(rs[0].formulas))assert.equal(ws.getCell(`${c}${n}`).formula,localFormula(f,n));
  }
  assert.equal(ws.getCell('J5').formula,'IF(COUNT(J4)=1,SUM(J4),"")');
  assert.equal(ws.getCell('J10').formula,'IF(COUNT(J4,J8)=2,SUM(J4,J8),"")');
  assert.equal(ws.getCell('J4').formula,'IF(COUNT(I4,D4)=2,I4*D4,"")');
  assert.equal(ws.getCell('K4').formula,'IF(COUNT(DI4,J4)=2,IF(DI4=0,"",J4/DI4),"")');
  const summary=wb.getWorksheet('总表分车间');
  assert.match(summary.getCell(`J${summary.rowCount}`).formula,/'Sky Castle'!J5.*'Sky Castle'!J9/);
  const saved=new (require('exceljs').Workbook)();await saved.xlsx.load(await wb.xlsx.writeBuffer());
  assert.equal(saved.getWorksheet('Sky Castle').getCell('J4').formula,localFormula('I1*D1',4));
  assert.equal(saved.getWorksheet('Sky Castle').getCell('D4').value,100);
  // Source row 8 is not green detail row 6 (customer workshop headings differ).
  assert.equal(saved.getWorksheet('不分车间核价明细').getCell('J5').formula,`IF(ISNUMBER('Sky Castle'!J8),'Sky Castle'!J8,"")`);
  saved.getWorksheet('Sky Castle').eachRow(r=>r.eachCell(c=>{if(c.formula)assert.ok(!c.formula.includes('!'),c.formula);}));
});
test('missing and zero results retain formulas for later input edits',()=>{
  const r=row(1,'A','华登',null,10,null);
  r.values.J=null;r.values.K=null;
  r.formulas.J='I1*D1';r.formulas.K='IF(DI1=0,"",J1/DI1)';
  const ws=buildWorkbook([r],columns).getWorksheet('A');
  assert.equal(ws.getCell('J4').formula,localFormula('I1*D1',4));
  assert.equal(ws.getCell('J5').formula,'IF(COUNT(J4)=1,SUM(J4),"")');
  assert.equal(ws.getCell('K4').formula,localFormula(r.formulas.K,4));
});
test('reference layout maps unit costs, amounts and ratios without column collisions',async()=>{
  const r=row(1,'A','华登',10,20,200);
  Object.assign(r.values,{DD:12,DV:120,DW:0.6,CD:0.04,AD:20});
  const wb=buildWorkbook([r],columns),ws=wb.getWorksheet('总表不分车间');
  assert.equal(ws.columnCount,135);
  const print=wb.getWorksheet('不分车间 打印');
  assert.equal(print.getCell('V3').value,'彩盒金额');
  assert.match(print.getCell('V4').formula,/'A'!AD/);
  assert.equal(print.getCell('V4').result,0.002);
  assert.equal(print.getCell('W4').result,0.1);
  assert.equal(ws.getCell('DB4').result,12); // unit cost, not the similarly named total amount
  assert.equal(ws.getCell('DU4').result,0.012);
  assert.match(ws.getCell('DB4').formula,/'A'!DD/);
  assert.match(ws.getCell('DU4').formula,/'A'!DV.*\/10000/);
  assert.equal(ws.getCell('DV4').formula,'IF(COUNT(DG4,DU4)=2,IF(DG4=0,0,DU4/DG4),"")');
  assert.equal(ws.getCell('CD4').result,0.04);
  assert.equal(ws.getCell('DG3').value,'总生产金额');
  assert.match(ws.getCell('A1').value,/各客实际生意核价总表/);
  const customer=wb.getWorksheet('A');
  assert.equal(customer.getCell('CK3').fill.fgColor.argb,'FFFFFF00');
  assert.equal(customer.getCell('DE3').fill.fgColor.argb,'FF00B0F0');
  assert.equal(customer.getCell('H2').value,'张副总');
  assert.equal(customer.pageSetup.printTitlesRow,'1:3');
  const ratioKeys=require('../frontend/verification-report-groups').ratios;
  const layout=require('../backend/services/verificationExportLayout.json');
  for(const name of ['总表分车间','打印','截图','总表不分车间','不分车间 打印']){
    const cs=layout.profiles[name].columns;
    for(const c of cs)if(ratioKeys[c.key]){
      const [a,b]=ratioKeys[c.key];
      assert.equal(cs.find(c=>c.key===a).scale,cs.find(c=>c.key===b).scale,`${name} ${c.key} units`);
    }
  }
});
