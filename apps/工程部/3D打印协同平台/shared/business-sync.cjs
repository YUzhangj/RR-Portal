const {createHash}=require('node:crypto');
const arrays=['products','materials','schedules','maintenance','miscExpenses','stockInLogs'];
const ignored=new Set(['_updatedAt','_mergedAt','_sourceFacts','sourceStation','sourceRecordId','platformMachine','inventorySync','inventoryReview','inventoryReason','inventoryDeduction','qualitySettled','cloudJobId','cloudAttempt','orderId','orderNumber','cloudManaged','printerOutcome']);
const settingKeys=['machines','elecPerMachine','laborPerDay','resinQuotePerGram','resinElecPerDay','resinLaborPerDay','lossRate','profitRate'];
const safeKey=k=>!['__proto__','constructor','prototype'].includes(String(k));
const localMetadata=row=>Object.fromEntries(Object.entries(row||{}).filter(([k])=>ignored.has(k)));
const blocked=/password|token|secret|accesscode|checkcode|credential/i;
function clean(x){if(Array.isArray(x))return x.map(clean);if(x&&typeof x==='object'){const y={};for(const k of Object.keys(x).sort()){if(['__proto__','constructor','prototype'].includes(k)||ignored.has(k)||blocked.test(k))continue;y[k]=clean(x[k]);}return y;}return x;}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function project(data){
 const out={};
 for(const name of arrays){out[name]={};for(const row of data[name]||[]){if(row.id===undefined)throw Error(name+' 存在缺少 ID 的数据，请先修复');const key=String(row.id);if(!safeKey(key))throw Error('无效 ID');if(Object.hasOwn(out[name],key))throw Error(name+' ID 重复：'+key);out[name][key]=clean(row);}}
 out.records={};out.days={};
 for(const [date,day]of Object.entries(data.records||{})){out.days[date]={off:!!day.off};for(const item of day.items||[]){const id=item.sourceRecordId||item._id;if(!id||!safeKey(id))throw Error('生产记录缺少 ID');if(out.records[id])throw Error('生产记录 ID 重复：'+id);out.records[id]={...clean(item),_id:id,date};}}
 out.inventory=clean(data.inventory||{});
 out.settings={};for(const k of settingKeys)if(data.settings?.[k]!==undefined)out.settings[k]=data.settings[k];
 return clean(out);
}
function fingerprint(data){return createHash('sha256').update(JSON.stringify(clean(data))).digest('hex');}
// Three-way merge: simultaneous changes to a field never silently win.
function merge(base,cloud,windows,choices={}){
 const conflicts=[];const absent=undefined;
 function walk(b,c,w,path){
  const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
  // New entities with a colliding ID and delete-vs-edit conflicts stay atomic.
  if(object(c)&&object(w)&&object(b)){
   const out={};for(const key of new Set([...Object.keys(b),...Object.keys(c),...Object.keys(w)])){const val=walk(b[key],c[key],w[key],[...path,key]);if(val!==absent)out[key]=val;}return out;
  }
  const concurrentStock=!!base&&path[0]==='inventory'&&path.at(-1)==='stockG'&&!equal(c,b)&&!equal(w,b);
  if(equal(c,w)&&!concurrentStock)return c;
  if(base){if(equal(c,b))return w;if(equal(w,b))return c;}
  const id=JSON.stringify(path),signature=fingerprint({base:[b!==undefined,b??null],cloud:[c!==undefined,c??null],windows:[w!==undefined,w??null]});
  if(choices[id]?.signature===signature&&['cloud','windows'].includes(choices[id].side))return choices[id].side==='cloud'?c:w;
  conflicts.push({id,path,signature,base:b??null,cloud:c??null,windows:w??null,baseMissing:b===undefined,cloudMissing:c===undefined,windowsMissing:w===undefined});return c;
 }
 // First connection has no trustworthy common baseline. Existing differences require review.
 const initial=base||Object.fromEntries(Object.keys(cloud).map(k=>[k,{}]));
 const result=walk(initial,cloud,windows,[]);return {data:result,conflicts};
}
function validateKeys(value){if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(!safeKey(key)||ignored.has(key)||blocked.test(key))throw Error('同步文档含有保留字段：'+key);validateKeys(child);}}
function apply(original,doc){
 validateKeys(doc);
 if(!doc||typeof doc!=='object'||Array.isArray(doc))throw Error('无效同步文档');
 // Validate the document by round-tripping its business model before storing it.
 const result=structuredClone(original),stamp=Date.now();
 for(const name of arrays){const old=new Map((original[name]||[]).map(x=>[String(x.id),x]));result[name]=Object.values(doc[name]||{}).map(row=>({...localMetadata(old.get(String(row.id))),...row,_updatedAt:stamp}));}
 result.records={};
 const previous=new Map(Object.values(original.records||{}).flatMap(d=>d.items||[]).map(i=>[i.sourceRecordId||i._id,i]));
 for(const [date,day]of Object.entries(doc.days||{}))result.records[date]={off:!!day.off,items:[]};
 for(const [id,entry]of Object.entries(doc.records||{})){const {date,...item}=entry;if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||id!==item._id)throw Error('生产记录格式无效');const old=previous.get(id);result.records[date]||={off:false,items:[]};result.records[date].items.push({...localMetadata(old),...item,_id:old?._id||id,_updatedAt:stamp,_mergedAt:stamp});}
 result.inventory=structuredClone(doc.inventory||{});for(const row of Object.values(result.inventory)){if(!Number.isFinite(row.stockG)||row.stockG<0)throw Error('库存数量无效');row._updatedAt=stamp;}
 result.settings={...original.settings};for(const k of settingKeys)delete result.settings[k];Object.assign(result.settings,doc.settings);result._snapshotUpdatedAt=stamp;
 if(!equal(project(result),clean(doc)))throw Error('同步文档含有不支持的字段或格式');return result;
}
module.exports={project,apply,merge,fingerprint};
