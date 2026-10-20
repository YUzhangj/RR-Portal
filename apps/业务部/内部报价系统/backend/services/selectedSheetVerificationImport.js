'use strict';
const XLSX = require('xlsx');
const path = require('node:path');
const { detailAnalysisSummary } = require('./legacyVerificationImport');
const departments = ['engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly'];
const clean = value => String(value ?? '').replace(/\s/g, '').trim();
const numeric = value => typeof value === 'number' && Number.isFinite(value);
function department(name) {
  if (/进口料|国内料|啤工/.test(name)) return 'molding';
  if (/喷油|喷印|油漆|移印|炒货|散枪|边模|浸油|抹油|PP水|UV/i.test(name)) return 'painting';
  if (/搪胶|搪工|批工|烤工/.test(name)) return 'slush';
  if (/车缝|车衣|车发|毛发|布料|裁片|电绣/.test(name)) return 'sewing';
  if (/电子|PCB|PCBA|IC\b|线路板|喇叭|马达/i.test(name)) return 'electronic';
  if (/人工|装工|组装|装配|包装[:：]|包装工|混装|拆查货/.test(name)) return 'assembly';
  return 'engineering';
}

// Explicit reviewed selections are required: historical pages and alternate
// packaging in these workbooks must never become additional products by guessing.
function parseSelectedSheetVerificationWorkbook(file, options = {}) {
  if (!options.sourceDate || !options.selections?.length) throw new Error('需要原表日期及已核对的工作表、产品和明细范围');
  const workbook = XLSX.readFile(file, { cellFormula: true, cellNF: true });
  const sourceFile = options.sourceFile || path.basename(file);
  const items = options.selections.map(selection => {
    const { sheet: sheetName, quoteNo, productName, moldRow, detailStart, detailEnd, amountColumn, nameColumn = 'A', quantityColumn } = selection;
    const original = workbook.Sheets[sheetName];
    if (!original || !quoteNo || !productName || !Number.isInteger(detailStart) || detailEnd < detailStart || !amountColumn) throw new Error('导入范围或产品标识不完整');
    const positions = Object.entries(original).filter(([a,c]) => a[0] !== '!' && (c.v != null || c.f)).map(([a]) => XLSX.utils.decode_cell(a));
    const sheet = { ...original, '!ref': XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(...positions.map(p=>p.r)),c:Math.max(...positions.map(p=>p.c))}}) };
    const value = (column, row) => sheet[`${column}${row}`]?.v;
    const payloads = Object.fromEntries(departments.map(d => [d, { legacy_items: [] }]));
    for (let r = detailStart; r <= detailEnd; r++) {
      const name = String(value(nameColumn, r) ?? '').trim(), cell = sheet[`${amountColumn}${r}`];
      if (!name || !cell || (!numeric(cell.v) && !cell.f)) continue;
      payloads[department(name)].legacy_items.push({name, source_row:r, source_cell:`${amountColumn}${r}`,
        current_hkd: numeric(cell.v) ? cell.v : null, previous_hkd:null, difference_hkd:null,
        quantity: quantityColumn ? value(quantityColumn,r) ?? null : null, note:`来源：${sheetName}!${amountColumn}${r}`});
    }
    const header = Object.entries(sheet).filter(([a]) => /^[A-Z]+\d+$/.test(a) && XLSX.utils.decode_cell(a).r === moldRow - 1);
    const column = pattern => header.find(([,c]) => pattern.test(clean(c.v)))?.[0].replace(/\d+$/, '');
    const fields = {weight_g:column(/^(核价)?料重\(G\)$/i), material_unit_price:column(/料价(?:HKD)?\(G\)$/i),
      cavity:column(/件数/),sets:column(/套数/),target:column(/目标数/),shot_price:column(/^啤工$/),material_amount:column(/料金额/)};
    const nameCol=column(/^名称$|^模具名称/), materialCol=column(/^料型$/), machineCol=column(/机型/), moldCol=column(/^模号/);
    const injection=[];
    for(let r=moldRow+1;r<detailStart;r++) {
      const name=String(value(nameCol,r)??'').trim();
      if(!name || !numeric(value(fields.weight_g,r)) || !numeric(value(fields.material_unit_price,r)))continue;
      const sources=Object.fromEntries(Object.entries(fields).filter(([,c])=>c).map(([k,c])=>[k,`${c}${r}`]));
      injection.push({name,mold_no:String(value(moldCol,r)??''),material:String(value(materialCol,r)??''),machine:String(value(machineCol,r)??''),
        ...Object.fromEntries(Object.entries(fields).map(([k,c])=>[k,c?value(c,r)??null:null])),source_excel_cells:sources,note:`来源：${sheetName}!${r}`});
    }
    payloads.molding.injection=injection;
    const analysis=detailAnalysisSummary(sheet);
    if(!analysis || !numeric(analysis.pricingSummary.t1.base_price))throw new Error(`${sheetName} 缺少有效货价分析区`);
    const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null});
    const analysisRow=rows.findIndex(row=>row.some(v=>clean(v)==='货价')&&row.some(v=>clean(v)==='进口料'));
    const notes=selection.reviewNotes||[];
    const qty=selection.orderQuantity??null;
    if(qty!==null && (!numeric(qty)||qty<0))throw new Error('接单数量必须是原表非负数或空值');
    const fx=value(selection.fxColumn,selection.fxRow);
    if(!numeric(fx)||fx<=0)throw new Error(`${sheetName} 缺少有效汇率来源`);
    return {quoteNo,productName,qty,confirmedPrice:analysis.pricingSummary.t1.base_price,verificationStatus:notes.length?'drafting':'completed',departmentPayloads:payloads,
      salesPayload:{header:{currency:'HKD',fx_rmb_hkd:fx,...(selection.fxUsd?{fx_hkd_usd:selection.fxUsd}:{})},pricing_summary:analysis.pricingSummary,
        legacy_import:{detail_imported:true,confirmed_currency:'HKD',source_file:sourceFile,source_date:options.sourceDate,
          source_sheet:sheetName,source_detail_sheet:sheetName,source_detail_range:sheet['!ref'],source_shared_rows:0,source_item:quoteNo,
          source_identity:selection.identitySource,source_order_quantity:qty,source_quantity_label:selection.quantityLabel||'接单数量',
          source_detail_rows:Object.values(payloads).reduce((sum,p)=>sum+p.legacy_items.length,0),source_mold_rows:injection.length,
          pricing_tail:rows.slice(detailEnd,analysisRow).map((cells,r)=>({source_row:detailEnd+r+1,cells})),
          source_cost_including_labor:analysis.totalCost,source_cost_excluding_labor:analysis.costWithoutLabor,import_review_notes:notes}}};
  });
  if(new Set(items.map(i=>i.quoteNo)).size!==items.length)throw new Error('产品标识重复');
  return {customer:options.customer,sourceFile,sourceDate:options.sourceDate,items,withQty:items.filter(i=>i.qty!==null).length,withoutQty:items.filter(i=>i.qty===null).length,totalQty:items.reduce((sum,i)=>sum+(i.qty||0),0)};
}
module.exports={parseSelectedSheetVerificationWorkbook};
