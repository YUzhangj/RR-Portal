// Emit the same JSON bytes as JSON.stringify without allocating a complete
// document string. Business snapshots are JSON data, including large images.
const unsupported=value=>value===undefined||typeof value==='function'||typeof value==='symbol';
function prepare(value,key){
 if(value!==null&&(typeof value==='object'||typeof value==='function'||typeof value==='bigint')&&typeof value.toJSON==='function')value=value.toJSON(key);
 if(value instanceof Number||value instanceof String||value instanceof Boolean)value=value.valueOf();
 if(value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===BigInt.prototype)value=value.valueOf();
 return value;
}
function* quoted(value){
 yield '"';
 for(let start=0;start<value.length;){
  let end=Math.min(start+16384,value.length);
  // Keep a surrogate pair together so escaping and UTF-8 encoding match the
  // whole-string serializer, including well-formed escaping of lone surrogates.
  if(end<value.length&&value.charCodeAt(end-1)>=0xd800&&value.charCodeAt(end-1)<=0xdbff&&value.charCodeAt(end)>=0xdc00&&value.charCodeAt(end)<=0xdfff)end--;
  yield JSON.stringify(value.slice(start,end)).slice(1,-1);start=end;
 }
 yield '"';
}
function* encode(value,ancestors){
 if(typeof value==='string'){yield* quoted(value);return;}
 if(value===null||typeof value!=='object'){yield JSON.stringify(value);return;}
 if(ancestors.has(value))throw TypeError('Converting circular structure to JSON');
 ancestors.add(value);
 try{
  if(Array.isArray(value)){
   yield '[';
   for(let index=0;index<value.length;index++){
    if(index)yield ',';
    const child=prepare(value[index],String(index));
    if(unsupported(child))yield 'null';else yield* encode(child,ancestors);
   }
   yield ']';
  }else{
   yield '{';let first=true;
   // Object.keys preserves JSON.stringify's integer-key ordering as well as
   // the insertion order established by the canonical business projection.
   for(const key of Object.keys(value)){
    const child=prepare(value[key],key);if(unsupported(child))continue;
    if(!first)yield ',';first=false;yield* quoted(key);yield ':';yield* encode(child,ancestors);
   }
   yield '}';
  }
 }finally{ancestors.delete(value);}
}
function parts(value){return encode(prepare(value,''),new Set());}
function equal(a,b){
 const left=parts(a),right=parts(b);
 for(;;){const l=left.next(),r=right.next();if(l.done||r.done)return l.done===r.done;if(l.value!==r.value)return false;}
}
module.exports={parts,equal};
