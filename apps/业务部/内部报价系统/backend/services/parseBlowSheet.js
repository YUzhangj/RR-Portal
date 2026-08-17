// 解析“吹气报价”型 xls/xlsx。
// 常见格式为单货号竖表：A 列是标签，B 列是数值；一个有效工作表对应一条吹气明细。
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

function toStr(value) {
  if (value == null) return '';
  if (typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map(part => part.text).join('').trim();
  }
  if (typeof value === 'object' && value.text != null) return String(value.text).trim();
  if (typeof value === 'object' && value.result != null) return String(value.result).trim();
  return String(value).trim();
}

function toNum(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && value.result != null) return toNum(value.result);
  const match = String(value).replace(/[,，\s]/g, '').match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedLabel(value) {
  return toStr(value).replace(/\s+/g, '').replace(/[：:*＊×]+$/, '');
}

function sheetjsRows(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true }).map(row => {
    const values = [];
    (row || []).forEach((value, index) => { values[index + 1] = value; });
    return values;
  });
}

async function readSheets(buffer) {
  const sheets = [];
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    for (const sheet of workbook.worksheets || []) {
      const rows = [];
      sheet.eachRow({ includeEmpty: true }, row => {
        const values = [];
        row.eachCell({ includeEmpty: true }, (cell, column) => { values[column] = cell.value; });
        rows.push(values);
      });
      sheets.push({ name: sheet.name, rows });
    }
  } catch {}
  if (sheets.length) return sheets;

  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  return workbook.SheetNames.map(name => ({ name, rows: sheetjsRows(workbook.Sheets[name]) }));
}

function findPair(rows, wanted) {
  for (const row of rows) {
    for (let column = 0; column < (row || []).length; column += 1) {
      const raw = toStr(row[column]);
      const inline = /^(.+?)[：:]\s*([-+]?\d[\d,，]*(?:\.\d+)?)\s*$/.exec(raw);
      if (inline && normalizedLabel(inline[1]) === wanted) return inline[2];
      if (normalizedLabel(raw) === wanted) return row[column + 1];
    }
  }
  return null;
}

function capacity22h(value) {
  const text = toStr(value);
  if (!text) return '';
  const matches = text.match(/\d+(?:\.\d+)?/g) || [];
  if (!matches.length) return text;
  // “22/小时3500”中的 22 是工时，最后一个数字才是日产量。
  return Number(matches[matches.length - 1]);
}

function findCavityNote(rows) {
  const labeled = findPair(rows, '出数');
  if (toStr(labeled)) return toStr(labeled);
  for (const row of rows) {
    for (const value of row || []) {
      const text = toStr(value).replace(/\s+/g, '');
      if (/^(?:一|二|三|四|五|六|七|八|九|十|\d+)出(?:一|二|三|四|五|六|七|八|九|十|\d+)$/.test(text)
        || /^一出(?:一|二|三|四|五|六|七|八|九|十|\d+)$/.test(text)) return text;
    }
  }
  return '';
}

function parseSheet(sheet) {
  const rows = sheet.rows || [];
  const labels = rows.flatMap(row => (row || []).map(normalizedLabel)).filter(Boolean);
  const requiredHits = ['货名', '产能', '用料', '预估料重', '料价', '吹工', '披锋', '利润']
    .filter(label => labels.includes(label)).length;
  if (!labels.some(text => /吹气报价/.test(text)) && requiredHits < 6) return null;

  const name = toStr(findPair(rows, '货名'));
  const material = toStr(findPair(rows, '用料'));
  const weight = toNum(findPair(rows, '预估料重'));
  const materialPrice = toNum(findPair(rows, '料价'));
  const labor = toNum(findPair(rows, '吹工'));
  const flash = toNum(findPair(rows, '披锋'));
  if (!name && !material && weight == null && labor == null) return null;

  return {
    name,
    capacity: capacity22h(findPair(rows, '产能')),
    material,
    weight_g: weight ?? 0,
    material_price_lb: materialPrice ?? 0,
    blow_labor: labor ?? 0,
    flash: flash ?? 0,
    profit_x: toNum(findPair(rows, '利润')) || 1,
    usage_qty: toNum(findPair(rows, '用量')) || 1,
    cavity_note: findCavityNote(rows),
    mold_price_note: toStr(findPair(rows, '模价')),
    material_cost_hkd: toNum(findPair(rows, '产品料价')),
    source_subtotal_hkd: toNum(findPair(rows, '小计')),
    source_total_hkd: toNum(findPair(rows, '合计')),
    images: [],
    source_sheet: sheet.name,
  };
}

async function parseWorkbook(buffer) {
  let sheets;
  try {
    sheets = await readSheets(buffer);
  } catch (error) {
    return { error: '解析失败：' + error.message };
  }
  if (!sheets.length) return { error: '工作簿为空' };

  const items = [];
  for (const sheet of sheets) {
    const item = parseSheet(sheet);
    if (item) items.push(item);
  }
  if (!items.length) {
    return { error: '未找到吹气报价格式（需要 货名 / 产能 / 用料 / 预估料重 / 料价 / 吹工 / 披锋 / 利润）' };
  }
  return {
    items,
    count: items.length,
    sheets_used: items.map(item => item.source_sheet),
  };
}

module.exports = { parseWorkbook };
