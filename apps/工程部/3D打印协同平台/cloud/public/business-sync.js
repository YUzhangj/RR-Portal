let csrf='',conflicts=[];
const status=document.querySelector('#status'),container=document.querySelector('#conflicts');
async function api(method='GET',body){const r=await fetch('/api/platform/business-sync',{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
function value(x){return JSON.stringify(x,(k,v)=>typeof v==='string'&&v.startsWith('data:image/')?'[图片数据]':v,2)??'不存在';}
async function reload(){try{const d=await api();conflicts=d.conflicts;container.replaceChildren();status.textContent=d.active?`已启用站点：${d.active}；${conflicts.length} 项待核对。最近云端合并：${d.lastSuccess||'尚无'}。两边同步完成时间请查看 Windows 采集控制台。`:'尚未启用双向同步，请先完成服务端及 Windows 配置。';for(const [index,c]of conflicts.entries()){
 const card=document.createElement('section');card.style.cssText='padding:20px;margin:20px 0;background:white;border:1px solid #ccd;border-radius:12px';
 const title=document.createElement('h3');title.textContent=c.path.join(' / ');card.append(title);
 for(const [label,key]of [['上次一致值','base'],['新平台','cloud'],['原 3d-server','windows']]){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=label;pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';pre.textContent=c[key+'Missing']?'此方不存在；选择此方将移除另一方的对应记录或字段。':value(c[key]);details.append(summary,pre);card.append(details);}
 const select=document.createElement('select');select.dataset.index=index;for(const [v,t]of [['','暂不处理'],['cloud','使用新平台值'],['windows','使用原 3d-server 值']]){const option=document.createElement('option');option.value=v;option.textContent=t;select.append(option);}card.append(select);container.append(card);
 }}catch(e){status.textContent=e.message||'请先登录管理员账号';}}
document.querySelector('#reload').onclick=reload;
document.querySelector('#save').onclick=async()=>{try{const choices=[...container.querySelectorAll('select')].filter(s=>s.value).map(s=>{const c=conflicts[Number(s.dataset.index)];return {id:c.id,signature:c.signature,side:s.value};});await api('POST',{choices});status.textContent='处理方式已保存。Windows 桥接下一轮会再次校验；若数据又被修改，需要重新核对。';}catch(e){status.textContent=e.message;}};
try{const r=await fetch('/api/me');if(!r.ok)throw Error('请先登录管理员账号，再打开本页');csrf=(await r.json()).csrf;await reload();}catch(e){status.textContent=e.message;}
