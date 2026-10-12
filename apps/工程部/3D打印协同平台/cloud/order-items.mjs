import {randomUUID} from 'node:crypto';
export const orderItems = p => Array.isArray(p.items) && p.items.length ? p.items : [{...p,id:'legacy'}];
export function parseItems(d,{field,date,fail},previous){
 if(d.items===undefined && previous?.items?.length>1)fail(400,'多产品订单请提交完整产品明细');
 const rows=d.items===undefined?[d]:d.items;
 if(!Array.isArray(rows)||!rows.length||rows.length>50)fail(400,'请填写 1–50 条产品明细');
 const ids=new Set();
 return rows.map((r,i)=>{
  if(!r||typeof r!=='object'||Array.isArray(r))fail(400,'产品明细格式无效');
  const item={id:r.id|| (rows.length===1?previous?.items?.[0]?.id:undefined)||randomUUID()};
  if(typeof item.id!=='string'||! /^[a-zA-Z0-9-]{1,80}$/.test(item.id)||ids.has(item.id))fail(400,'产品明细编号无效或重复');
  ids.add(item.id);
  for(const k of ['product','sku','material','color'])item[k]=field(r,k,true);
  item.printerType=field(r,'printerType');
  if(item.printerType&&!['光固化','FDM'].includes(item.printerType))fail(400,'打印机器只能选择光固化或 FDM');
  item.quantity=Number(r.quantity);
  if(!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>100000)fail(400,`第 ${i+1} 条数量需为 1–100000 的整数`);
  item.dueDate=date(field(r,'dueDate'),true);item.notes=field(r,'notes',false,2000);
  return item;
 });
}
export function itemSummary(items){
 const p={items,quantity:items.reduce((n,i)=>n+i.quantity,0),dueDate:items.map(i=>i.dueDate).sort()[0]};
 for(const k of ['product','sku','material','color','printerType','notes'])p[k]=[...new Set(items.map(i=>i[k]).filter(Boolean))].join(' / ');
 return p;
}
export function aggregateStage(items,jobs){
 const active=jobs.filter(j=>j.status!=='已取消');
 if(items.every(i=>active.some(j=>j.item_id===i.id&&j.status==='待交付')))return '待交付';
 if(active.some(j=>['打印中','异常','待质检','待交付'].includes(j.status)))return '打印中';
 return '待排产';
}
