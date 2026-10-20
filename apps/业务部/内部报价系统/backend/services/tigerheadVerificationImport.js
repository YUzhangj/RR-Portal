'use strict';
const XLSX=require('xlsx'),path=require('node:path');
const {parseLegacyDetailSheet,detailAnalysisSummary}=require('./legacyVerificationImport');
const text=v=>String(v??'').trim();
function parseTigerheadVerificationWorkbook(file,options={}) {
  const workbook=XLSX.readFile(file,{cellFormula:true,cellNF:true});
  const summary=workbook.Sheets['总表'],source=workbook.Sheets['Tigerhead核价'];
  if(!summary||!source)throw Error('缺少 Tigerhead 总表或核价明细');
  const rows=XLSX.utils.sheet_to_json(summary,{header:1,defval:null});
  const records=rows.flatMap((r,i)=>text(r[0])==='Tigerhead'&&text(r[1])?[{r,row:i+1}]:[]);
  const refRow=(cell)=>{
    const m=cell?.f?.match(/^'?Tigerhead核价'?!\$?[A-Z]+\$?(\d+)$/);
    if(!m)throw Error('总表明细引用不明确');return Number(m[1]);
  };
  const starts=records.map(({r,row})=>{
    if(summary[`B${row}`]?.f)return refRow(summary[`B${row}`]);
    const matches=Object.entries(source).filter(([a,c])=>/^A\d+$/.test(a)&&text(c.v)===text(r[1]));
    if(matches.length!==1)throw Error(`${r[1]} 无法唯一定位明细标题`);
    return XLSX.utils.decode_cell(matches[0][0]).r+1;
  });
  const lastRow=Math.max(...Object.entries(source).filter(([a,c])=>!a.startsWith('!')&&(c.v!=null||c.f)).map(([a])=>XLSX.utils.decode_cell(a).r+1));
  const sourceFile=options.sourceFile||path.basename(file),sourceDate=options.sourceDate;
  if(!sourceDate)throw Error('请指定原表日期');
  const items=records.map(({r,row},index)=>{
    const start=starts[index],end=(starts[index+1]||lastRow+1)-1;
    const sheet={'!ref':`A1:AB${end}`};
    for(const [a,c] of Object.entries(source)){
      if(a.startsWith('!'))continue;const p=XLSX.utils.decode_cell(a);
      if(p.c<28&&(p.r<11||p.r>=start-1&&p.r<end))sheet[a]=c;
    }
    const priceRow=refRow(summary[`F${row}`]);
    if(priceRow<start||priceRow>end)throw Error(`${r[1]} 的货价引用跨货号`);
    const detail=parseLegacyDetailSheet(sheet,'Tigerhead核价');
    const analysis=detailAnalysisSummary(sheet);
    if(!analysis||!Number.isFinite(r[5]))throw Error(`${r[1]} 缺少有效的成本分析`);
    // Mold names are in column C in this template (column B is merged/blank).
    detail.departmentPayloads.molding.injection.forEach(m=>{
      const n=Number(m.note.match(/!(\d+)/)?.[1]);if(n&&sheet[`C${n}`])m.name=text(sheet[`C${n}`].v);
    });
    return {quoteNo:text(r[1]),productName:text(r[2]),qty:typeof r[3]==='number'?r[3]:null,
      confirmedPrice:r[5],verificationStatus:'completed',departmentPayloads:detail.departmentPayloads,
      salesPayload:{header:{currency:'HKD',fx_rmb_hkd:source.I9.v,fx_hkd_usd:source.I10.v},pricing_summary:analysis.pricingSummary,
        legacy_import:{detail_imported:true,confirmed_currency:'HKD',source_file:sourceFile,source_date:sourceDate,
          source_sheet:'总表',source_summary_row:row,source_item:text(r[1]),source_detail_sheet:'Tigerhead核价',
          source_detail_range:`A${start}:AB${end}`,source_shared_rows:11,source_price_formula:summary[`F${row}`].f,
          source_detail_rows:detail.detailCount,source_mold_rows:detail.moldCount,pricing_tail:detail.pricingTail,
          source_order_quantity:typeof r[3]==='number'?r[3]:null,source_quantity_label:'预计接单数量',
          source_cost_including_labor:analysis.totalCost,source_cost_excluding_labor:analysis.costWithoutLabor}}};
  });
  if(!items.length||new Set(items.map(i=>i.quoteNo)).size!==items.length)throw Error('Tigerhead 货号为空或重复');
  return {customer:'Tigerhead',sourceFile,sourceDate,items,withQty:items.filter(i=>i.qty!==null).length,withoutQty:items.filter(i=>i.qty===null).length,totalQty:items.reduce((s,i)=>s+(i.qty||0),0)};
}
module.exports={parseTigerheadVerificationWorkbook};
