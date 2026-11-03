const {createHash}=require('node:crypto');
const prefix='/api/production/data-images/';
// The snapshot remains a self-contained backup. This table is only a derived,
// immutable image cache, so saving compact client data must resolve references.
module.exports=function createDataImages(store){
 store.exec('CREATE TABLE IF NOT EXISTS data_images (hash TEXT PRIMARY KEY, uri TEXT NOT NULL)');
 const put=store.prepare('INSERT OR IGNORE INTO data_images(hash,uri) VALUES (?,?)');
 const get=store.prepare('SELECT uri FROM data_images WHERE hash=?');
 function compact(data){
  return JSON.parse(JSON.stringify(data,(key,value)=>{
   if(typeof value!=='string'||!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(value))return value;
   const hash=createHash('sha256').update(value).digest('hex');put.run(hash,value);return prefix+hash;
  }));
 }
 function restore(data){
  // Input comes from the JSON snapshot/request. Copy its containers without
  // serializing all inline images again: a full snapshot can exceed 20 MB.
  function visit(value){
   if(typeof value==='string'){
    if(!value.startsWith(prefix))return value;
    const uri=get.get(value.slice(prefix.length))?.uri;
    if(!uri)throw Error('图片引用已失效，请重新加载后保存');
    return uri;
   }
   if(Array.isArray(value))return value.map(visit);
   if(value===null||typeof value!=='object')return value;
   const restored={};
   for(const key of Object.keys(value))Object.defineProperty(restored,key,{value:visit(value[key]),enumerable:true,writable:true,configurable:true});
   return restored;
  }
  return visit(data);
 }
 function image(hash){
  if(!/^[a-f0-9]{64}$/.test(hash))return null;
  const uri=get.get(hash)?.uri;if(!uri)return null;
  const comma=uri.indexOf(',');return {type:uri.slice(5,uri.indexOf(';')),body:Buffer.from(uri.slice(comma+1),'base64')};
 }
 return {compact,restore,image};
};
