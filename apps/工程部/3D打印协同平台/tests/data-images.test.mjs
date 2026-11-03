import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import createDataImages from '../production/data-images.cjs';
test('image projection deduplicates, preserves full backups and rejects unknown references',()=>{
 const db=new DatabaseSync(':memory:');try{
  const images=createDataImages(db),uri='data:image/png;base64,aGVsbG8=';
  const full={products:[{id:1,image:uri},{id:2,image:uri}],records:{}};
  const compact=images.compact(full);assert.equal(full.products[0].image,uri);assert.equal(compact.products[0].image,compact.products[1].image);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM data_images').get().n,1);
  assert.deepEqual(images.restore(compact),full);
  assert.equal(images.image(compact.products[0].image.split('/').at(-1)).body.toString(),'hello');
  assert.equal(images.image('../snapshot'),null);
  assert.throws(()=>images.restore({image:'/api/production/data-images/missing'}),/引用已失效/);
  compact.products[0].image='';assert.equal(images.restore(compact).products[0].image,'','explicit image deletion remains supported');
 }finally{db.close();}
});
test('restoring JSON preserves nested data and special keys without changing the snapshot or cache',()=>{
 const db=new DatabaseSync(':memory:');try{
  const images=createDataImages(db),uri='data:image/png;base64,aGVsbG8=';
  const ref=images.compact({image:uri}).image;
  const input=JSON.parse('{"__proto__":{"polluted":true},"constructor":"kept","products":[],"empty":"","nil":null,"values":[0,false,{},[]]}');
  input.products.push({id:'产品一',image:ref,extra:{images:[ref,'data:image/png;base64,aGVsbG8=']}});
  const before=JSON.stringify(input),count=db.prepare('SELECT COUNT(*) n FROM data_images').get().n;
  const restored=images.restore(input);
  const expected=JSON.parse(before.replaceAll(ref,uri));
  assert.deepEqual(restored,expected);assert.equal(Object.getPrototypeOf(restored),Object.prototype);
  assert.equal({}.polluted,undefined);assert.equal(JSON.stringify(input),before);
  restored.products[0].extra.images.push('changed');assert.equal(input.products[0].extra.images.length,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM data_images').get().n,count);
 }finally{db.close();}
});
test('restoring large self-contained images needs no additional JSON serialization',()=>{
 const db=new DatabaseSync(':memory:');try{
  const images=createDataImages(db),uri='data:image/png;base64,'+'A'.repeat(21*1024*1024);
  const input={products:[{id:1,image:uri}],inventory:{resin:{stockG:5000}}};
  const stringify=JSON.stringify;
  let restored;try{JSON.stringify=()=>{throw Error('unexpected full snapshot serialization');};restored=images.restore(input);}finally{JSON.stringify=stringify;}
  assert.deepEqual(restored,input);assert.notEqual(restored,input);assert.notEqual(restored.inventory,input.inventory);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM data_images').get().n,0);
 }finally{db.close();}
});
