import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import jsonStream from '../shared/json-stream.cjs';
import core from '../shared/business-sync.cjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const encoded=value=>Array.from(jsonStream.parts(value)).join('');
test('streamed JSON exactly matches the existing serializer for escaping, key ordering and JSON values',()=>{
 const special='"\\\u0000\b\t\n\f\r\u2028\u2029\ud800x\udc00🙂';
 const values=[null,false,true,0,-0,NaN,Infinity,1e-7,1e21,undefined,'',special,
  'x'.repeat(16383)+'🙂'+'y'.repeat(16383)+'\ud800',
  {z:1,'10':'ten','2':'two','01':'one',a:special,omit:undefined},
  [undefined,,null,false,{},[],special],JSON.parse('{"__proto__":{"x":1},"constructor":2}'),
  {date:new Date('2026-10-12T00:00:00Z'),box:new Number(5),string:new String('ok'),bool:new Boolean(false)},
  {toJSON(key){return {key,text:special};}},Object.assign(()=>{},{toJSON(){return special;}}),
 ];
 for(const value of values){
  const original=JSON.stringify(value);
  if(original===undefined)assert.deepEqual(Array.from(jsonStream.parts(value)),[undefined]);
  else assert.equal(encoded(value),original);
 }
 const cycle={};cycle.self=cycle;assert.throws(()=>encoded(cycle),TypeError);
 assert.throws(()=>encoded(1n),TypeError);
 assert.throws(()=>encoded(Object(1n)),TypeError);
});
test('stream equality keeps JSON key order, omitted fields, array nulls and exact stock differences',()=>{
 const values=[undefined,null,NaN,0,-0,'x',true,{},[],{a:1,b:2},{b:2,a:1},
  {a:undefined},[undefined],[null],{stockG:1000},{stockG:999},'A'.repeat(40000)+'🙂',
  {a:[{image:'data:image/png;base64,'+'A'.repeat(100000)}]}];
 for(const left of values)for(const right of values)assert.equal(jsonStream.equal(left,right),JSON.stringify(left)===JSON.stringify(right));
});
test('business fingerprints retain canonical legacy SHA bytes and conflict signatures',()=>{
 const value={z:1,'10':10,'2':2,_updatedAt:123,password:'removed',nested:{a:'🙂',token:'removed',z:[false,null,0]},
  image:'data:image/png;base64,'+'A'.repeat(256*1024)};
 // Golden comparison uses the pre-change canonical projection rules, with
 // numeric property enumeration left to the existing JSON serializer.
 const canonical={'10':10,'2':2,image:value.image,nested:{a:'🙂',z:[false,null,0]},z:1};
 assert.equal(core.fingerprint(value),sha(JSON.stringify(canonical)));
 const base={inventory:{PETG:{stockG:1000}}},cloud={inventory:{PETG:{stockG:999}}},windows={inventory:{PETG:{stockG:999}}};
 const conflict=core.merge(base,cloud,windows).conflicts[0];
 assert.equal(conflict.signature,sha(JSON.stringify({base:[true,1000],cloud:[true,999],windows:[true,999]})));
 assert.equal(core.merge(base,cloud,windows,{[conflict.id]:{signature:conflict.signature,side:'windows'}}).conflicts.length,0);
});
