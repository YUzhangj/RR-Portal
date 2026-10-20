const XLSX = require('xlsx');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Excel = require('../../frontend/excel-formulas');
const { readWorkbookBorders } = require('./excelBorders');
const { parseZuruVerificationWorkbook, parseLegacyVerificationWorkbook } = require('./legacyVerificationImport');
const { parseCepiaVerificationWorkbook } = require('./cepiaVerificationImport');
const { parseZanzoonVerificationWorkbook } = require('./zanzoonVerificationImport');
const { parseIndexedVerificationWorkbook } = require('./indexedVerificationImport');
const { parseTokidosVerificationWorkbook } = require('./tokidosVerificationImport');
const { parseSelectedSheetVerificationWorkbook } = require('./selectedSheetVerificationImport');
const { parseTigerheadVerificationWorkbook } = require('./tigerheadVerificationImport');
const clean = value => String(value ?? '').replace(/[\s（）()]/g, '').trim();

// Ignore worksheet dimensions inflated by formatting (e.g. XFD1926), but do not
// discard populated cells. Addresses always remain the original Excel addresses.
function sourceRows(sheet) {
  const rows = [];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith('!') || (cell.v == null && !cell.f)) continue;
    const {r,c} = XLSX.utils.decode_cell(address);
    (rows[r] ||= [])[c] = cell.v ?? null;
  }
  return Array.from({length: rows.length}, (_, r) => rows[r] || []);
}

function productBounds(sheet, legacy, customer) {
  if (!legacy.source_detail_range) return null;
  const rows = sourceRows(sheet), original = XLSX.utils.decode_range(legacy.source_detail_range);
  if (customer !== 'Cepia') return original;
  const analyses = rows.flatMap((row, r) => row.some(v => clean(v) === '货价')
    && row.some(v => clean(v) === '进口料') ? [r] : []);
  const current = analyses.findLast(r => r >= original.s.r && r <= original.e.r);
  if (current == null) throw new Error(`${legacy.source_item} 未找到本货号成本分析表头`);
  function endOf(r) {
    const next = analyses.find(n => n > r) ?? rows.length;
    const label = rows.findIndex((row, n) => n > r && n < Math.min(next, r + 22)
      && row.some(v => clean(v) === '合计减税'));
    if (label < 0) throw new Error(`${legacy.source_detail_sheet}!${r + 1} 缺少减税汇总，不能截断导入`);
    const column = rows[label].findIndex(v => clean(v) === '合计减税');
    const result = rows.findIndex((row, n) => n > label && n <= label + 4 && typeof row[column] === 'number');
    if (result < 0) throw new Error(`${legacy.source_detail_sheet}!${label + 1} 缺少减税结果`);
    return result;
  }
  const previous = analyses.filter(r => r < current).at(-1);
  let start = previous == null ? original.s.r : endOf(previous) + 1;
  while (start < current && !rows[start].some(v => v != null && v !== '')) start++;
  const end = endOf(current);
  const columns = Math.max(original.e.c, ...rows.slice(start, end + 1).map(row => row.length - 1));
  return {s: {r:start,c:0}, e: {r:end,c:columns}};
}

function buildModel(workbook, sheetName, item, options = {}) {
  const sheet = workbook.Sheets[sheetName];
  const bounds = options.bounds;
  const inBlock = address => { const p = XLSX.utils.decode_cell(address); return !bounds
    || (p.r >= bounds.s.r && p.r <= bounds.e.r && p.c >= bounds.s.c && p.c <= bounds.e.c)
    || p.r < (options.sharedRows || 0); };
  const cells = {}, queue = [];
  const include = id => {
    if (Object.hasOwn(cells, id)) return;
    const [name, address] = Excel.split(id), source = workbook.Sheets[name]?.[address];
    if (!source) { cells[id] = { v: null, ...(workbook.Sheets[name] ? {} : { missing_sheet: true }) }; return; }
    cells[id] = { v: source.v ?? null, t: source.t, ...(source.f ? { f: source.f } : {}), ...(source.z ? { z: source.z } : {}) };
    queue.push(id);
  };
  Object.keys(sheet).filter(a => !a.startsWith('!') && inBlock(a) && (sheet[a].v != null || sheet[a].f)).forEach(a => include(Excel.key(sheetName, a)));
  const parseIssues = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], cell = cells[id];
    if (!cell.f) continue;
    try {
      const refs = Excel.references(cell.f, Excel.split(id)[0]);
      refs.forEach(include);
      const missing = refs.filter(ref => cells[ref]?.missing_sheet);
      if (missing.length) { cell.external_input = true; cell.missing_sources = missing; }
    }
    catch (error) { parseIssues.push({ cell: id, message: error.message }); }
  }
  const rows = sourceRows(sheet);
  const analysisEnd = bounds ? bounds.e.r + 1 : rows.length;
  const analysisStart = rows.findIndex((row, r) => (!bounds || r >= bounds.s.r && r <= bounds.e.r) && row.some(v => clean(v) === '货价')
    && row.some(v => clean(v) === '进口料'));
  if (analysisStart < 0) throw new Error(`${sheetName} 缺少成本与减税分析区`);
  const groups = [];
  for (let r = analysisStart; r < analysisEnd; r++) {
    const row = rows[r];
    if (row.some(v => clean(v) === '货价')) groups.push({ title: '货价与材料', rows: [] });
    else if (row.some(v => /未减税前码数/.test(clean(v)))) groups.push({ title: '包装与外购', rows: [] });
    else if (row.some(v => /ABS料价成本/.test(clean(v)))) groups.push({ title: '人工与成本', rows: [] });
    else if (row.some(v => /人民币外购件成本/.test(clean(v)))) groups.push({ title: '减税与税后结果', rows: [] });
    if (!groups.length || !row.some(v => v != null && v !== '')) continue;
    let end = row.length - 1;
    while (end >= 0 && row[end] == null) end--;
    groups[groups.length - 1].rows.push(Array.from({ length: end + 1 }, (_, c) => Excel.key(sheetName, XLSX.utils.encode_cell({ r, c }))));
  }
  const metricLabels = {
    price: ['货价'], total: ['总成本'], no_labor: ['不含人工成本'],
    deduction: ['合计减税'], after_cost: ['减税后成本'], after_gross: ['减税后毛利'],
    gross_pct: ['减税后毛利率'], after_profit: ['减税后利润'], profit_pct: ['减税后利润率'],
  };
  const metrics = {};
  for (const [metric, labels] of Object.entries(metricLabels)) {
    for (let r = analysisStart; r < analysisEnd; r++) {
      const c = rows[r].findIndex(v => labels.includes(clean(v)));
      if (c < 0) continue;
      for (let next = r + 1; next <= Math.min(analysisEnd - 1, r + 4); next++) {
        if (typeof rows[next]?.[c] === 'number') { metrics[metric] = Excel.key(sheetName, XLSX.utils.encode_cell({ r: next, c })); break; }
      }
      if (metrics[metric]) break;
    }
  }
  const allItems = Object.values(item.departmentPayloads).flatMap(p => p.legacy_items || []);
  const currentColumn = XLSX.utils.decode_cell(allItems.find(i => i.source_cell)?.source_cell || 'C1').c;
  const tail = (item.salesPayload.legacy_import.pricing_tail || []).filter(r => r.source_row <= analysisStart)
    .map(row => ({ label: row.cells.slice(0, currentColumn).filter(v => v != null).join(' '),
      cell: Excel.key(sheetName, XLSX.utils.encode_cell({ r: row.source_row - 1, c: currentColumn })) }))
    .filter(row => cells[row.cell]?.v != null);
  const model = { version: 1, sheet: sheetName, cells, groups, tail, metrics, parse_issues: parseIssues };
  model.layout = sheetLayout(sheet, bounds, options.sharedRows);
  if (bounds) model.source_range = XLSX.utils.encode_range(bounds);
  const evaluator = Excel.createEvaluator(model), uses = new Map();
  for (const [dept, payload] of Object.entries(item.departmentPayloads)) {
    const roots = (payload.legacy_items || []).filter(row => row.source_cell || row.source_row).map(row => {
      row.source_cell ||= `C${row.source_row}`;
      row.excel_cell = Excel.key(sheetName, row.source_cell);
      row.source_formula = cells[row.excel_cell]?.f || '';
      return row.excel_cell;
    });
    for (const row of payload.injection || []) {
      for (const address of Object.values(row.source_excel_cells || {})) roots.push(Excel.key(sheetName, address));
    }
    payload.excel_native = { department: dept, inputs: {} };
    for (const id of roots) {
      let deps = [];
      try { deps = evaluator.dependencies(id, true); } catch {}
      for (const ref of [id, ...deps]) {
        if (!uses.has(ref)) uses.set(ref, new Set());
        uses.get(ref).add(dept);
      }
    }
  }
  for (const [id, cell] of Object.entries(cells)) {
    const owners = [...(uses.get(id) || [])];
    cell.owner = owners.length === 1 ? owners[0] : 'sales';
    const [name, address] = Excel.split(id), position = XLSX.utils.decode_cell(address);
    const sourceSheet = workbook.Sheets[name];
    const left = position.c > 0 ? sourceSheet?.[XLSX.utils.encode_cell({ r: position.r, c: position.c - 1 })] : null;
    const above = position.r > 0 ? sourceSheet?.[XLSX.utils.encode_cell({ r: position.r - 1, c: position.c })] : null;
    cell.label = [left, above].find(c => c?.t === 's' && String(c.v).length < 45)?.v || address;
  }
  const inputs = new Set(uses.keys());
  for (const id of [...tail.map(r => r.cell), ...groups.flatMap(g => g.rows.flat())]) {
    inputs.add(id);
    try { evaluator.dependencies(id, true).forEach(ref => inputs.add(ref)); } catch {}
  }
  for (const id of inputs) if (cells[id]) cells[id].input = true;
  return model;
}

function sheetLayout(sheet, bounds, sharedRows = 0) {
  const inside = p => !bounds || p.r < sharedRows || p.r >= bounds.s.r && p.r <= bounds.e.r;
  const positions = Object.keys(sheet).filter(a => !a.startsWith('!') && (sheet[a].v != null || sheet[a].f))
    .filter(a => {const p=XLSX.utils.decode_cell(a);return inside(p)&&(!bounds||p.c>=bounds.s.c&&p.c<=bounds.e.c);})
    .map(a => XLSX.utils.decode_cell(a));
  const rows = Math.max(1, ...positions.map(p => p.r + 1));
  const columns = Math.max(1, ...positions.map(p => p.c + 1));
  const rowIndices = bounds ? [...new Set([...Array.from({length:sharedRows},(_,r)=>r),
    ...Array.from({length:bounds.e.r-bounds.s.r+1},(_,r)=>r+bounds.s.r)])].sort((a,b)=>a-b) : undefined;
  return { rows, columns, ...(rowIndices ? {rowIndices} : {}),
    ...(sheet['!sourceBorders'] ? { borders: Object.fromEntries(Object.entries(sheet['!sourceBorders']).filter(([address]) => {
      const cell = XLSX.utils.decode_cell(address); return inside(cell) && cell.r < rows && cell.c < columns;
    })) } : {}),
    widths: Array.from({ length: columns }, (_, c) => Math.max(75, Math.min(340, sheet['!cols']?.[c]?.wpx || (c < 2 ? 230 : 112)))),
    merges: (sheet['!merges'] || []).filter(m => inside(m.s) && inside(m.e) && (!bounds || m.e.r < sharedRows || m.s.r >= bounds.s.r)
      && m.s.r < rows && m.e.r < rows && m.s.c < columns && m.e.c < columns),
  };
}

function auditModel(model) {
  const evaluator = Excel.createEvaluator(model), differences = [], errors = [];
  let formulas = 0;
  for (const [id, cell] of Object.entries(model.cells)) {
    if (!cell.f || cell.external_input) continue;
    formulas++;
    try {
      const actual = evaluator.value(id);
      if (typeof cell.v === 'number' && Math.abs(actual - cell.v) > Math.max(1e-8, Math.abs(cell.v) * 1e-9))
        differences.push({ cell: id, original: cell.v, recalculated: actual });
    } catch (error) { errors.push({ cell: id, message: error.message }); }
  }
  return { formulas, differences, errors };
}

function parseExcelVerificationWorkbook(file, options = {}) {
  const customer = options.customer || 'ZURU';
  const parsers = { ZURU: parseZuruVerificationWorkbook, 'Sky Castle': parseLegacyVerificationWorkbook,
    Cepia: parseCepiaVerificationWorkbook, ZANZOON: parseZanzoonVerificationWorkbook,
    '嘉苏A': parseZanzoonVerificationWorkbook, JAZWARES: parseIndexedVerificationWorkbook, 'PWP（多美）': parseIndexedVerificationWorkbook,
    Tokidos: parseTokidosVerificationWorkbook, Tigerhead: parseTigerheadVerificationWorkbook, ToyMonster: parseSelectedSheetVerificationWorkbook, 'John Adams': parseSelectedSheetVerificationWorkbook };
  if (!Object.hasOwn(parsers, customer)) throw new Error(`不支持客户：${customer}`);
  const parsed = parsers[customer](file, {...options, sourceCustomer: customer});
  parsed.customer = customer;
  const workbook = XLSX.readFile(file, { cellFormula: true, cellNF: true, cellStyles: true });
  const borders = readWorkbookBorders(file);
  for (const [name, sheet] of Object.entries(workbook.Sheets)) sheet['!sourceBorders'] = borders[name] || {};
  const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const item of parsed.items) {
    const legacy = item.salesPayload.legacy_import;
    const sheet = workbook.Sheets[legacy.source_detail_sheet];
    const bounds = productBounds(sheet, legacy, customer);
    const model = buildModel(workbook, legacy.source_detail_sheet, item, {bounds, sharedRows: legacy.source_shared_rows ?? (bounds ? (customer === 'Cepia' ? 11 : 9) : 0)});
    if (bounds) legacy.source_detail_range = model.source_range;
    const audit = auditModel(model);
    legacy.summary_only = false;
    legacy.formula_mode = 'excel_native_v1';
    legacy.excel_model = model;
    legacy.source_fingerprint = fingerprint;
    legacy.excel_audit = audit;
    if (['JAZWARES','PWP（多美）','Tokidos','Tigerhead','ToyMonster','John Adams'].includes(customer)) {
      const evaluator=Excel.createEvaluator(model), issues=[];
      for(const key of ['price','total','no_labor','deduction','after_cost','after_gross','after_profit']) {
        // Some source templates omit tax-after profit. Audit optional metrics
        // only when supplied; price and total cost are required for every item.
        if(!model.metrics[key]&&!['price','total'].includes(key))continue;
        try {if(!model.metrics[key]||!Number.isFinite(evaluator.value(model.metrics[key])))throw Error('缺少有效结果');}
        catch(error){issues.push(`${key}: ${error.message}`);}
      }
      if(issues.length)item.verificationStatus='drafting';
      legacy.import_review_issues=issues;
    }
    item.salesPayload.excel_native = { department: 'sales', inputs: {} };
    if (model.metrics.price) item.confirmedPrice = model.cells[model.metrics.price].v;
  }
  return parsed;
}

module.exports = { buildModel, auditModel, parseExcelVerificationWorkbook, sheetLayout, sourceRows, productBounds };
