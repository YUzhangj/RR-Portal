'use strict';

function text(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'result')) return String(value.result ?? '').trim();
  return String(value ?? '').trim();
}

function sourceFieldForOutputCell(workbook, sheetName, address) {
  if (sheetName !== '报价明细') return null;
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

async function syncOutputValueToSource(db, quoteId, workbook, sheetName, address, value, actor) {
  const binding = sourceFieldForOutputCell(workbook, sheetName, address);
  if (!binding) return null;
  const section = await db.prepare('SELECT payload_json, filled_at FROM quote_sections WHERE quote_id = ? AND dept = ?')
    .get(quoteId, binding.dept);
  if (!section) return null;
  let payload;
  try { payload = JSON.parse(section.payload_json || '{}'); }
  catch (_) { payload = {}; }
  setPath(payload, binding.path, value);
  const updatedAt = new Date(Math.max(Date.now(), (Date.parse(section.filled_at) || 0) + 1)).toISOString();
  await db.prepare(`UPDATE quote_sections SET payload_json = ?, filled_by = ?, filled_at = ?,
    status = CASE WHEN status = 'approved' THEN 'filled' ELSE status END,
    reviewed_by = NULL,
    reviewed_at = NULL
    WHERE quote_id = ? AND dept = ?`).run(JSON.stringify(payload), actor, updatedAt, quoteId, binding.dept);
  await db.prepare('DELETE FROM quote_output_overrides WHERE quote_id = ? AND sheet_name = ? AND cell_address = ?')
    .run(quoteId, sheetName, address);
  return binding;
}

module.exports = { sourceFieldForOutputCell, syncOutputValueToSource };
