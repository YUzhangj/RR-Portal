'use strict';

function text(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'result')) return String(value.result ?? '').trim();
  return String(value ?? '').trim();
}

function sourceFieldForOutputCell(workbook, sheetName, address) {
  if (sheetName !== '报价明细') return null;
  if (address === 'O7') return { dept: 'sales', path: ['indo_pct'], unifiedIndonesia: true };
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) return null;
  const cell = worksheet.getCell(address);
  const label = text(worksheet.getCell(cell.row, 2).value);
  if (cell.col >= 4 && /^×\s*码点/.test(label)) return { dept: 'sales', path: ['shipping', 'markup_x'] };
  if (cell.col >= 4 && /^÷\s*找数/.test(label)) return { dept: 'sales', path: ['shipping', 'divisor'] };
  const freightFields = new Map([
    ['10吨车：', 'cap_10t'], ['5吨车：', 'cap_5t'], ["40'：", 'cap_40'], ["20'：", 'cap_20'],
    ['HK 40柜运费+吊柜费', 'hk40'], ['HK 20柜运费+吊柜费', 'hk20'],
    ['YT 40柜运费+吊柜费', 'yt40'], ['YT 20柜运费+吊柜费', 'yt20'],
    ['HK10吨运费', 'hk10t'], ['YT10吨运费', 'yt10t'],
    ['HK5吨运费', 'hk5t'], ['YT5吨运费', 'yt5t'],
  ]);
  const freightField = freightFields.get(label);
  if (freightField && cell.col === 3) return { dept: 'sales', path: ['freight_calc', freightField] };
  return null;
}

function setPath(target, path, value) {
  let cursor = target;
  path.slice(0, -1).forEach(key => {
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  });
  cursor[path[path.length - 1]] = value;
}

async function syncOutputValueToSource(db, quoteId, workbook, sheetName, address, value, actor, verification = false) {
  const binding = sourceFieldForOutputCell(workbook, sheetName, address);
  if (!binding || (verification && !binding.materialReference && !binding.unifiedIndonesia)) return null;
  const table = verification ? 'quote_verification_sections' : 'quote_sections';
  const key = verification ? 'version_id' : 'quote_id';
  const overrides = verification ? 'quote_verification_output_overrides' : 'quote_output_overrides';
  if (binding.unifiedIndonesia) {
    await syncUnifiedIndonesiaRate(db, quoteId, value, verification, actor);
    await db.prepare(`DELETE FROM ${overrides} WHERE ${key}=? AND sheet_name=? AND cell_address=?`).run(quoteId, sheetName, address);
    return binding;
  }
  const section = await db.prepare(`SELECT payload_json, filled_at FROM ${table} WHERE ${key} = ? AND dept = ?`)
    .get(quoteId, binding.dept);
  if (!section) return null;
  let payload;
  try { payload = JSON.parse(section.payload_json || '{}'); }
  catch (_) { throw Object.assign(new Error('部门来源数据损坏，不能保存'), { status: 409 }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('部门来源数据无效'), { status: 409 });
  setPath(payload, binding.path, value);
  const updatedAt = new Date(Math.max(Date.now(), (Date.parse(section.filled_at) || 0) + 1)).toISOString();
  await db.prepare(`UPDATE ${table} SET payload_json = ?, filled_by = ?, filled_at = ?,
    status = CASE WHEN status = 'approved' THEN 'filled' ELSE status END,
    reviewed_by = NULL,
    reviewed_at = NULL
    WHERE ${key} = ? AND dept = ?`).run(JSON.stringify(payload), actor, updatedAt, quoteId, binding.dept);
  await db.prepare(`DELETE FROM ${overrides} WHERE ${key} = ? AND sheet_name = ? AND cell_address = ?`)
    .run(quoteId, sheetName, address);
  return binding;
}

async function syncUnifiedIndonesiaRate(db, id, percentage, verification = false, actor = null) {
  if (!Number.isFinite(percentage) || percentage < 0) {
    throw Object.assign(new Error('请输入有效的非负印尼运费比例'), { status: 400 });
  }
  const table = verification ? 'quote_verification_sections' : 'quote_sections';
  const key = verification ? 'version_id' : 'quote_id';
  const sections = await db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).all(id);
  const policy = require('../../frontend/indonesia-freight');
  const quoteId = verification ? (await db.prepare('SELECT quote_id FROM quote_verification_versions WHERE id=?').get(id))?.quote_id : id;
  for (const section of sections) {
    if (!policy.departments.includes(section.dept)) continue;
    let payload;
    try { payload = JSON.parse(section.payload_json || '{}'); } catch {
      throw Object.assign(new Error('部门来源数据损坏，不能统一运费'), { status: 409 });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw Object.assign(new Error('部门来源数据格式无效，不能统一运费'), { status: 409 });
    }
    policy.apply(payload, percentage);
    if (section.dept === 'sales') payload.output_unified_indonesia = true;
    const filledAt = require('./verificationSectionSave').nextSectionTime(section);
    await db.prepare(`UPDATE ${table} SET payload_json=?, filled_at=?, filled_by=COALESCE(?, filled_by),
      status=CASE WHEN status='approved' THEN 'filled' ELSE status END,
      reviewed_by=NULL, reviewed_at=NULL${verification ? ', review_comment=NULL' : ''} WHERE id=?`)
      .run(JSON.stringify(payload), filledAt, actor, section.id);
    await db.prepare('INSERT INTO audit_log (quote_id, dept, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
      .run(quoteId, section.dept, actor, 'unified_indonesia_rate', JSON.stringify({
        version_id: verification ? id : null, percentage, previous_payload_json: section.payload_json,
        previous_status: section.status, previous_reviewed_by: section.reviewed_by, previous_reviewed_at: section.reviewed_at,
      }));
  }
}

module.exports = { sourceFieldForOutputCell, syncOutputValueToSource, syncUnifiedIndonesiaRate };
