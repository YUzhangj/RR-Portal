'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,server,PASSWORD}=require('./helpers/startup-retention-fixture.cjs');

for(const driver of ['sqlite','postgres'])test(`${driver} real adapter initialization retains expired trash and every associated snapshot twice`,
  {timeout:60000,skip:driver==='postgres'&&!process.env.TEST_DATABASE_URL},async t=>{
    const f=await fixture(t,driver==='postgres'?process.env.TEST_DATABASE_URL:undefined);
    const before=await f.snapshot();let sequence=await f.sequence();
    if(!f.pg)t.diagnostic('Reference fixture uses authored rows; pre-existing SQLite stock-seed updated_at refresh is outside the no-content-change assertion.');
    assert.equal(before.quotes.length,3);assert.equal(before.quote_sections.length,24);
    assert.equal(before.quote_customer_confirmations.length,3);assert.equal(before.quote_verifications.length,3);
    assert.equal(before.quote_verification_versions.length,6);assert.equal(before.quote_verification_sections.length,48);
    assert.equal(before.audit_log.length,9);
    const expired=await f.query('SELECT * FROM quotes WHERE id=1001',[],'get');
    assert.equal(expired.deleted_by,'Original deleter');assert.ok(String(expired.deleted_at).startsWith('2000-01-02'));
    const normal=await f.query('SELECT * FROM quotes WHERE id=1003',[],'get');assert.equal(normal.deleted_at,null);
    if(f.pg)assert.equal((await f.query('SELECT confirmed_price::text AS value FROM quote_customer_confirmations WHERE quote_id=1001',[],'get')).value,'12.12345678901234567890123456789');
    for(let pass=1;pass<=2;pass++){
      f.initialize();
      assert.deepEqual(await f.snapshot(),before,`all original fields retained after real initialization ${pass}`);
      const after=await f.sequence();
      if(f.pg){
        const attempts=3*f.departments.length;
        const expected=BigInt(sequence.value)+BigInt(attempts)-(sequence.called?0n:1n);
        assert.deepEqual(after,{value:String(expected),called:true},'existing INSERT ON CONFLICT attempts consume only their exact sequence values');
        t.diagnostic(`PostgreSQL initialization ${pass}: business rows identical; quote_sections sequence attempts=${attempts}`);
      }else assert.deepEqual(after,sequence,'SQLite missing-section loop does not insert when all eight departments exist');
      sequence=after;
    }
    assert.deepEqual(await f.query('SELECT * FROM quotes WHERE id=1003',[],'get'),normal);
  });

test('SQLite default factory seeds retain contents and only refresh their pre-existing update timestamps', {timeout:60000},async t=>{
  const f=await fixture(t,undefined,{authoredReferences:false});
  const sentinel='2001-02-03 04:05:06';
  await f.query("UPDATE factory_ref_tables SET updated_at=? WHERE updated_by='[factory-seed]' AND key IN ('material_prices','machine_prices')",[sentinel],'run');
  const before=await f.snapshot(),sequence=await f.sequence();
  const original=before.factory_ref_tables.map(row=>JSON.parse(row));
  const isRefreshed=row=>row.updated_by==='[factory-seed]'&&['material_prices','machine_prices'].includes(row.key);
  const stock=original.filter(isRefreshed);assert.equal(stock.length,3);
  f.initialize();const after=await f.snapshot();
  for(const table of Object.keys(before))if(table!=='factory_ref_tables')assert.deepEqual(after[table],before[table],table);
  const actual=after.factory_ref_tables.map(row=>JSON.parse(row));assert.equal(actual.length,original.length);
  let refreshed=0;
  for(const row of actual){
    const old=original.find(item=>item.factory_code===row.factory_code&&item.key===row.key);assert.ok(old);
    if(isRefreshed(old)){
      assert.equal(old.updated_at,sentinel);assert.notEqual(row.updated_at,sentinel);assert.match(row.updated_at,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.deepEqual({...row,updated_at:old.updated_at},old,'only existing stock seed timestamp changes');refreshed++;
    }else assert.deepEqual(row,old);
  }
  assert.equal(refreshed,3);assert.deepEqual(await f.sequence(),sequence);
  t.diagnostic('Unchanged legacy SQLite behavior: exactly three stock-reference updated_at fields refresh; prices, quantities, authors and all business/audit rows retain original content.');
});

test('real trash/restore endpoints keep permissions, full snapshots and normal soft-delete behavior', {timeout:60000},async t=>{
  const f=await fixture(t);const before=await f.snapshot();const running=await server(t,f);
  assert.deepEqual(await f.snapshot(),before,'server startup itself must not purge or rewrite seeded business data');
  const anonymous=running.session();assert.equal((await anonymous('/quotes/trash')).status,401);
  const api=running.session();assert.equal((await api('/auth/login','POST',{username:'admin',password:PASSWORD})).status,200);
  const trash=await api('/quotes/trash');assert.equal(trash.status,200);
  assert.deepEqual(trash.body.map(row=>row.id).sort(),[1001,1002]);
  await f.query("UPDATE users SET role='staff',dept='molding' WHERE username='admin'",[],'run');
  assert.equal((await api('/quotes/trash')).status,403);
  assert.equal((await api('/quotes/1001/restore','POST',{})).status,403);
  assert.equal((await api('/quotes/1003','DELETE')).status,403);
  await f.query("UPDATE users SET role='admin',dept='sales' WHERE username='admin'",[],'run');
  const beforeExplicit=await f.snapshot();
  assert.equal((await api('/quotes/1001/restore','POST',{})).status,200);
  const restored=await f.query('SELECT * FROM quotes WHERE id=1001',[],'get');
  const original=JSON.parse(beforeExplicit.quotes.find(row=>JSON.parse(row).id===1001));
  assert.deepEqual({...restored,deleted_at:original.deleted_at,deleted_by:original.deleted_by},original);
  assert.equal(restored.deleted_at,null);assert.equal(restored.deleted_by,null);
  const afterRestore=await f.snapshot();
  for(const table of ['quote_sections','quote_customer_confirmations','quote_verifications','quote_verification_versions','quote_verification_sections'])assert.deepEqual(afterRestore[table],beforeExplicit[table],table);
  assert.equal(afterRestore.audit_log.length,beforeExplicit.audit_log.length+1);
  assert.equal((await f.query("SELECT COUNT(*) AS n FROM audit_log WHERE quote_id=1001 AND action='restore'",[],'get')).n,1);
  const normal=await f.query('SELECT * FROM quotes WHERE id=1003',[],'get');
  assert.equal((await api('/quotes/1003','DELETE')).status,200);
  const removed=await f.query('SELECT * FROM quotes WHERE id=1003',[],'get');
  assert.ok(removed.deleted_at);assert.deepEqual({...removed,deleted_at:normal.deleted_at,deleted_by:normal.deleted_by},{...normal});
  const afterDelete=await f.snapshot();assert.equal(afterDelete.quotes.length,3);
  for(const table of ['quote_sections','quote_customer_confirmations','quote_verifications','quote_verification_versions','quote_verification_sections'])assert.deepEqual(afterDelete[table],beforeExplicit[table],table);
  assert.equal((await f.query("SELECT COUNT(*) AS n FROM audit_log WHERE quote_id=1003 AND action='trash'",[],'get')).n,2);
});
