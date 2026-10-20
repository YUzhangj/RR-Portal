'use strict';
const XLSX=require('xlsx');
const path=require('node:path');
const Excel=require('../../frontend/excel-formulas');
const {parseLegacyDetailSheet,buildPricingSummary}=require('./legacyVerificationImport');
const text=v=>String(v??'').trim();
const numeric=v=>typeof v==='number'&&Number.isFinite(v);
// Resolve the detail sheet through the index formula: sheet names often contain
// remarks and cannot safely be guessed from the SKU.
function parseIndexedVerificationWorkbook(file,options={}){
  const workbook=XLSX.readFile(file,{cellFormula:true,cellNF:true});
  const index=workbook.Sheets['货号分表'],summary=workbook.Sheets['总表'];
  if(!index||!summary)throw new Error('工作簿缺少货号分表或总表');
  const sourceFile=options.sourceFile||path.basename(file),sourceDate=options.sourceDate;
  if(!sourceDate)throw new Error('请指定原表日期');
  const orders=XLSX.utils.sheet_to_json(summary,{header:1,defval:null}).slice(1);
  const items=[];
  for(const [offset,row] of XLSX.utils.sheet_to_json(index,{header:1,defval:null}).entries()){
    if(!offset||!text(row[0]))continue;
    const quoteNo=text(row[0]),sourceRow=offset+1;
    const formula=index[`B${sourceRow}`]?.f;
    if(!formula)throw new Error(`${quoteNo} 缺少明细链接公式`);
    const refs=Excel.references(formula,'货号分表');
    const sheets=[...new Set(refs.map(ref=>Excel.split(ref)[0]))];
    if(sheets.length!==1||!workbook.Sheets[sheets[0]])throw new Error(`${quoteNo} 明细链接不是唯一有效工作表`);
    const sheetName=sheets[0],sheet={...workbook.Sheets[sheetName]};
    // WPS files can have formatting out to XFD. Keep populated cells intact.
    const points=Object.entries(sheet).filter(([a,c])=>!a.startsWith('!')&&(c.v!=null||c.f)).map(([a])=>XLSX.utils.decode_cell(a));
    sheet['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(...points.map(p=>p.r)),c:28}});
    const detailRows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null});
    const header=detailRows.findIndex(r=>r.some((v,c)=>c>=2&&/^(?:[0-9/年月日.\s-]+)?核价$/.test(text(v))));
    const molds=detailRows.flatMap((r,i)=>i<header&&text(r[0])==='模号'?[i]:[]);
    const detail=parseLegacyDetailSheet(sheet,sheetName,{chineseTotal:true,...(header>=0?{detailHeaderIndex:header,moldHeaderIndex:molds.at(-1)}:{})});
    const matches=orders.flatMap((r,i)=>text(r[1])===quoteNo?[{row:r,number:i+2}]:[]);
    if(matches.length>1)throw new Error(`${quoteNo} 在总表有多条接单数量，请明确分行`);
    const order=matches[0],qty=numeric(order?.row[3])?order.row[3]:null;
    if(!numeric(row[1])||row[1]<0)throw new Error(`${quoteNo} 缺少有效货价`);
    const fx=sheet.C9?.v,usd=sheet.C10?.v;
    items.push({quoteNo,productName:text(order?.row[2])||quoteNo,qty,confirmedPrice:row[1],
      verificationStatus:/未核价|未上线/.test(quoteNo+' '+sheetName)?'drafting':'completed',
      departmentPayloads:detail.departmentPayloads,
      salesPayload:{header:{currency:'HKD',fx_rmb_hkd:numeric(fx)?fx:0.87,fx_hkd_usd:numeric(usd)&&usd>0?(usd<1?1/usd:usd):7.8},pricing_summary:buildPricingSummary(row),
        legacy_import:{summary_only:true,detail_imported:true,confirmed_currency:'HKD',source_file:sourceFile,source_date:sourceDate,
          source_sheet:'货号分表',source_item:quoteNo,source_item_row:sourceRow,source_detail_sheet:sheetName,
          source_detail_range:sheet['!ref'],source_detail_rows:detail.detailCount,source_mold_rows:detail.moldCount,pricing_tail:detail.pricingTail,
          source_order_quantity:qty,source_summary_row:order?.number??null,
          source_cost_including_labor:row[2]??null,source_cost_excluding_labor:row[3]??null}}});
  }
  if(!items.length||new Set(items.map(i=>i.quoteNo)).size!==items.length)throw new Error('货号分表为空或存在重复货号');
  return {customer:options.customer,sourceFile,sourceDate,items,withQty:items.filter(i=>i.qty!==null).length,withoutQty:items.filter(i=>i.qty===null).length,totalQty:items.reduce((s,i)=>s+(i.qty||0),0)};
}
module.exports={parseIndexedVerificationWorkbook};
