'use strict';
const {createHash}=require('node:crypto');

function outputRevision(sections, overrides, lifecycle) {
  return createHash('sha256').update(JSON.stringify([
    lifecycle,
    [...sections].sort((a,b)=>a.dept.localeCompare(b.dept)).map(s=>[
      s.dept,s.payload_json,s.status,s.reviewed_by??null,s.reviewed_at??null,
    ]),
    [...overrides].sort((a,b)=>`${a.sheet_name}!${a.cell_address}`.localeCompare(`${b.sheet_name}!${b.cell_address}`))
      .map(o=>[o.sheet_name,o.cell_address,o.value_json,o.updated_at??null]),
  ])).digest('hex');
}
function assertOutputRevision(req, sections, overrides, lifecycle) {
  if (req.body?.base_revision !== outputRevision(sections, overrides, lifecycle)) {
    return '报价资料或修正值已更新，本次未覆盖。请保留当前输入，重新读取后核对。';
  }
  return null;
}

// The caller holds the quote/version transaction until every operation and
// audit has succeeded. A denied later cell must roll back earlier cells too.
async function runOutputBatch(req, handler) {
  const updates=req.body?.updates || [req.body];
  if (!Array.isArray(updates) || !updates.length || updates.length>100) {
    throw Object.assign(new Error('一次请修改 1 至 100 个单元格'),{status:400});
  }
  let revision=req.body?.base_revision, last;
  for (const update of updates) {
    let status=200, body;
    const pending={status(code){status=code;return pending;},json(value){body=value;return pending;}};
    await handler({...req,body:{...update,base_revision:revision}},pending);
    if(status>=400) throw Object.assign(new Error(body?.error || '保存失败'),{status});
    last=body; revision=body?.revision || revision;
  }
  return last;
}
module.exports={outputRevision,assertOutputRevision,runOutputBatch};
