const express=require('express');
const db=require('../db');
const {requireAuth,quoteAccess}=require('../middleware/auth');
const {columns,template,buildVerificationRow,customerTotals,buildVerificationWorkbook}=require('../services/verificationSummary');
const {sourceQuantity}=require('../services/sourceSummary');
const verificationCustomers=require('../../frontend/verification-customers');
const router=express.Router();router.use(requireAuth);
const canEditQuantity=u=>Boolean(u.perms?.['账号管理']?.can_admin)||u.role==='admin'||['sales','engineering'].includes(u.dept);
router.put('/quantity',async(req,res)=>{
  if(!canEditQuantity(req.user))return res.status(403).json({error:'只有业务、工程或管理员可以填写接单数量'});
  const {version_id:id,quantity}=req.body||{};
  if(!Number.isSafeInteger(id)||id<=0||!(quantity===null||(Number.isSafeInteger(quantity)&&quantity>=0)))return res.status(400).json({error:'数量须为非负整数，或留空'});
  try{
    await db.transaction(async()=>{
      const v=await db.prepare(`SELECT v.*,q.deleted_at FROM quote_verification_versions v JOIN quotes q ON q.id=v.quote_id WHERE v.id=?`).get(id);
      if(!v||v.deleted_at||v.status==='cancelled')throw Object.assign(new Error('核价版本不可用'),{status:409});
      const access=await quoteAccess(req.user,v.quote_id);
      if(access.status!==200)throw Object.assign(new Error('无权修改此核价数量'),{status:access.status});
      const latest=await db.prepare("SELECT id FROM quote_verification_versions WHERE quote_id=? AND status<>'cancelled' ORDER BY version_no DESC,id DESC LIMIT 1").get(v.quote_id);
      if(latest.id!==id)throw Object.assign(new Error('核价版本已更新，请刷新后填写'),{status:409});
      const s=await db.prepare("SELECT * FROM quote_verification_sections WHERE version_id=? AND dept='sales'").get(id);
      if(!s)throw Object.assign(new Error('缺少业务核价信息'),{status:409});
      const p=JSON.parse(s.payload_json||'{}'),actor=req.user.name||req.user.username;
      p.summary_order_quantity={value:quantity,updated_by:actor,updated_at:new Date().toISOString()};
      await db.prepare('UPDATE quote_verification_sections SET payload_json=? WHERE id=?').run(JSON.stringify(p),s.id);
      await db.prepare(`INSERT INTO audit_log(quote_id,dept,actor,action,detail) VALUES(?,?,?,'verification_order_quantity',?)`).run(v.quote_id,req.user.dept,actor,`${v.label} 汇总接单数量设为 ${quantity===null?'空白':quantity}；核价单价与完成状态不变`);
    })();
    res.json({ok:true});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});throw e;}
});

async function loadRows(user,filters={}) {
  const admin=Boolean(user.perms?.['账号管理']?.can_admin);
  const params=[user.active_factory_code];
  let scope='';
  if(!admin){scope=' AND q.customer IN (SELECT customer FROM user_customers WHERE user_id=?)';params.push(user.id);}
  const rows=await db.prepare(`SELECT q.*,v.id AS verification_version_id,v.label AS verification_label,v.status AS verification_status,v.version_no AS verification_version_no
    FROM quotes q JOIN quote_verification_versions v ON v.id=(SELECT vx.id FROM quote_verification_versions vx
    WHERE vx.quote_id=q.id AND vx.status<>'cancelled' ORDER BY vx.version_no DESC,vx.id DESC LIMIT 1)
    WHERE q.deleted_at IS NULL AND q.factory_code=?${scope} ORDER BY q.customer,q.quote_no,q.id`).all(...params);
  const selected=rows.filter(q=>(!filters.customer||verificationCustomers.display(q.customer)===verificationCustomers.display(filters.customer))
    &&(!filters.status||q.verification_status===filters.status)
    &&(!filters.search||`${verificationCustomers.display(q.customer)} ${q.customer} ${q.quote_no} ${q.product_name}`.toLowerCase().includes(String(filters.search).toLowerCase())));
  const result=[];
  // Bound model payload memory and replace one database round trip per quote.
  for(let offset=0;offset<selected.length;offset+=25){
    const batch=selected.slice(offset,offset+25),ids=batch.map(q=>q.verification_version_id);
    const records=await db.prepare(`SELECT version_id,dept,payload_json FROM quote_verification_sections WHERE version_id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
    const byVersion=new Map(ids.map(id=>[id,[]]));
    for(const section of records)byVersion.get(section.version_id)?.push(section);
    for(const q of batch){
      const sections=byVersion.get(q.verification_version_id);
      // Every cost comes from the current verification detail. The original
      // summary supplies order quantity only, never cost overrides or comparisons.
      const report=buildVerificationRow(q,{id:q.verification_version_id,label:q.verification_label,status:q.verification_status,version_no:q.verification_version_no},sections,sourceQuantity(q,sections)??undefined);
      if(filters.workshop&&report.workshop!==filters.workshop)continue;
      result.push(report);
    }
    // Let status polling and other requests run between calculation batches.
    if(offset+25<selected.length)await new Promise(resolve=>setImmediate(resolve));
  }
  return result;
}
router.get('/',async(req,res)=>{
  const rows=await loadRows(req.user,req.query);
  res.json({columns,rows,customers:customerTotals(rows),can_edit_quantity:canEditQuantity(req.user),quantity_period:'手填数量优先；未手填时沿用原文件数量'});
});
const runningExports=new Map(),exportStatus=new Map();
function pruneExportStatus(){
  const now=Date.now();
  for(const [id,status] of exportStatus)if(status.expires<now)exportStatus.delete(id);
}
function exportBuffer(user,filters){
  const key=JSON.stringify([user.id,user.active_factory_code,...['customer','status','search','workshop'].map(k=>String(filters[k]||''))]);
  if(runningExports.has(key))return runningExports.get(key);
  const pending=(async()=>{
    const rows=await loadRows(user,filters),wb=buildVerificationWorkbook(rows,{factoryName:user.active_factory_name});
    return Buffer.from(await wb.xlsx.writeBuffer());
  })();
  runningExports.set(key,pending);
  const done=()=>runningExports.delete(key);
  pending.then(done,done);
  return pending;
}
router.get('/export-status/:id',(req,res)=>{
  pruneExportStatus();res.setHeader('Cache-Control','no-store');
  const status=exportStatus.get(req.params.id);
  if(!status||status.userId!==req.user.id||status.factory!==req.user.active_factory_code)return res.status(404).json({error:'导出任务不存在'});
  res.json({state:status.state});
});
router.get('/export',async(req,res)=>{
  pruneExportStatus();
  const id=String(req.query.export_id||''),tracked=/^[a-zA-Z0-9-]{12,80}$/.test(id);
  const status={userId:req.user.id,factory:req.user.active_factory_code,state:'generating',expires:Date.now()+300000};
  if(tracked)exportStatus.set(id,status);
  res.setHeader('Cache-Control','no-store');
  try{
    const buffer=await exportBuffer(req.user,req.query);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent('各客核价汇总.xlsx')}`);
    res.send(buffer);
    status.state='ready';status.expires=Date.now()+120000;
  }catch(error){status.state='error';status.expires=Date.now()+120000;throw error;}
});
module.exports=router;
module.exports.loadRows=loadRows;
