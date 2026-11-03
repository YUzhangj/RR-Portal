const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../frontend/verification-customers');
const {buildVerificationRow,customerTotals}=require('../backend/services/verificationSummary');
test('customer names follow the supplied spelling; only complete known aliases match',()=>{
  assert.equal(C.names.length,26);
  for(const name of C.names)assert.equal(C.display(name),name);
  assert.equal(C.display('CEPIA'),'Cepia');
  assert.equal(C.display('Tomy'),'TOMY');
  assert.equal(C.display('ZANZOON'),'Zanzoon(嘉苏)');
  assert.equal(C.display('嘉苏A'),'Zanzoon(嘉苏)');
  assert.equal(C.display('Zanzoon（嘉苏）'),'Zanzoon(嘉苏)');
  assert.equal(C.display('CareFocus Tokidos'),'CareFocus Tokidos');
  assert.equal(C.display('ZURU (富格乐)'),'ZURU (富格乐)');
  assert.equal(C.options(['ZANZOON','嘉苏A']).filter(n=>n==='Zanzoon(嘉苏)').length,1);
});
test('normalizing the report name preserves original customer quantity matching and groups aliases',()=>{
  const quotes=[{id:1,customer:'ZANZOON',quote_no:'SKU1',product_name:'a'},{id:2,customer:'嘉苏A',quote_no:'SKU2',product_name:'b'}];
  const quantities=quotes.map((q,i)=>({customer:q.customer,sku:q.quote_no,qty:i+10,source:'test'}));
  const rows=quotes.map(q=>buildVerificationRow(q,{id:q.id},[],quantities));
  assert.deepEqual(rows.map(r=>r.values.D),[10,11]);
  assert.deepEqual(rows.map(r=>r.values.A),['Zanzoon(嘉苏)','Zanzoon(嘉苏)']);
  assert.equal(customerTotals(rows).length,1);
  assert.equal(customerTotals(rows)[0].totals.D,21);
  assert.equal(quotes[1].customer,'嘉苏A');
});
