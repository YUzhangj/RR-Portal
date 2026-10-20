const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewState, prepareWorkbookReview } = require('../backend/services/workbookReview');
const version = {id:140,status:'in_review'};
const fixture = () => ['sales','engineering','electronic','molding','painting','slush','sewing','assembly'].map((dept,i) => ({
  id:i+1,dept,status:i<2?'approved':'filled',payload_json:JSON.stringify(dept==='sales'?{legacy_import:{excel_model:{cells:{}}}}:{}),
  reviewed_at:i<2?'2026-09-17':null,
}));
test('one-click review plans only remaining pending imported sections, preserving approved ones', () => {
  const sections=fixture(), before=JSON.stringify(sections),state=reviewState(version,sections,()=>true);
  assert.ok(state.allowed&&state.ready);
  assert.deepEqual(prepareWorkbookReview(version,sections,()=>true,state.token).map(s=>s.id),[3,4,5,6,7,8]);
  assert.equal(JSON.stringify(sections),before);
});
test('one-click review excludes ordinary quote workflow, locked versions and partial reviewer permissions', () => {
  const ordinary=fixture();ordinary[0].payload_json='{}';
  assert.equal(reviewState(version,ordinary,()=>true).allowed,false);
  assert.throws(()=>prepareWorkbookReview(version,ordinary,()=>true,''),e=>e.status===409);
  for(const status of ['completed','cancelled'])assert.throws(()=>prepareWorkbookReview({...version,status},fixture(),()=>true,''),e=>e.status===409);
  assert.throws(()=>prepareWorkbookReview(version,fixture(),s=>s.dept==='painting',''),e=>e.status===403);
});
test('stale versions and draft/rejected sections cannot be approved silently', () => {
  const sections=fixture(),token=reviewState(version,sections,()=>true).token;
  const changed=structuredClone(sections);changed[2].payload_json='{"amount":99}';
  assert.throws(()=>prepareWorkbookReview(version,changed,()=>true,token),e=>e.status===409);
  for(const status of ['empty','rejected']){
    const rows=fixture();rows[2].status=status;const state=reviewState(version,rows,()=>true);
    assert.equal(state.ready,false);assert.throws(()=>prepareWorkbookReview(version,rows,()=>true,state.token),e=>e.status===409);
  }
  assert.throws(()=>prepareWorkbookReview(version,sections,()=>true,undefined),e=>e.status===409);
});
