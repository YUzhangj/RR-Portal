const test=require('node:test');
const assert=require('node:assert/strict');
const {quoteWriteRoute}=require('../backend/services/quoteFreeze');
function fixture(commitFailure=false){
 const calls=[];
 const db={prepare(){return{get:async()=>{calls.push('quote-lock');return{id:1};}};},transaction(fn){return async()=>{calls.push('begin');try{await fn();if(commitFailure)throw Error('fixture commit failure');calls.push('commit');}catch(e){calls.push('rollback');throw e;}};}};
 const res={statusCode:200,status(n){calls.push(`status:${n}`);return this;},json(value){calls.push(`json:${value.ok??value.error}`);return this;}};
 return{db,res,calls};
}
test('quote write success is sent only after COMMIT and never after a failed COMMIT',async()=>{
 for(const failure of [false,true]){
  const f=fixture(failure),route=quoteWriteRoute(f.db,()=>1,async(_req,res)=>res.json({ok:true}));
  if(failure){await assert.rejects(route({},f.res),/fixture commit failure/);assert.deepEqual(f.calls,['begin','quote-lock','rollback']);}
  else{await route({},f.res);assert.deepEqual(f.calls,['begin','quote-lock','commit','status:200','json:true']);}
 }
});
test('an early frozen response preserves 409 and also waits for its read transaction to commit',async()=>{
 const f=fixture();await quoteWriteRoute(f.db,()=>1,async(_req,res)=>res.status(409).json({error:'locked'}))({},f.res);
 assert.deepEqual(f.calls,['begin','quote-lock','commit','status:409','json:locked']);
});
