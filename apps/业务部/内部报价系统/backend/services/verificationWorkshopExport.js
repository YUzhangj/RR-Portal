'use strict';
const ExcelJS=require('exceljs');
const G=require('../../frontend/verification-report-groups');
const layout=require('./verificationExportLayout.json');
const clone=value=>JSON.parse(JSON.stringify(value));
const quoteSheet=name=>`'${name.replace(/'/g,"''")}'`;
const letter=index=>{let s='';for(let n=index;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
function localFormula(expression,row){
  const refs=[...new Set(expression.match(/\b[A-Z]+1\b/g)||[])].map(ref=>ref.replace(/1$/,row));
  const formula=expression.replace(/([A-Z]+)1\b/g,`$1${row}`);
  return refs.length?`IF(COUNT(${refs.join(',')})=${refs.length},${formula},"")`:formula;
}
function buildWorkbook(rows,columns){
  const wb=new ExcelJS.Workbook();wb.creator='内部报价系统';wb.calcProperties.fullCalcOnLoad=true;
  const plans=[
    ['总表分车间',G.reportRows(rows,'workshop-summary')],
    ['打印',G.reportRows(rows,'workshop-summary')],
    ['截图',G.reportRows(rows,'workshop-summary')],
    ['总表不分车间',G.reportRows(rows,'customer-summary')],
    ['不分车间 打印',G.reportRows(rows,'customer-summary')],
    ['不分车间核价明细',G.reportRows(rows,'all-details')]
  ];
  const used=new Set(plans.map(p=>p[0].toLowerCase()).concat('生成提示'));
  for(const [customer,items] of G.group(rows,r=>r.values.A)){
    const base=String(customer||'未填写客户').replace(/[\\/*?:\[\]]/g,'_').slice(0,26);let name=base,i=1;
    while(used.has(name.toLowerCase()))name=`${base}_${i++}`;
    used.add(name.toLowerCase());plans.push([name,G.reportRows(items,'customer-detail')]);
  }
  const profiles=new Map(plans.map(([name],i)=>[name,layout.profiles[i<6?name:'customer']]));
  const customerRows=new Map(),subtotalRefs=new Map();
  for(const [name,items] of plans.slice(6))items.forEach((r,i)=>{
    if(!r.kind)customerRows.set(r,{name,row:i+4});
    if(r.kind==='total')subtotalRefs.set(`${r.values.A}\u0000${r.workshop}`,{name,row:i+4});
  });
  const reference=(name,key,row,qualified=false)=>{
    const i=profiles.get(name).columns.findIndex(c=>c.key===key);
    if(i<0)throw Error(`导出模板缺少栏目 ${name}: ${key}`);
    return `${qualified?quoteSheet(name)+'!':''}${letter(i+1)}${row}`;
  };
  const mappedFormula=(expression,name,row)=>{
    const mapped=expression.replace(/\b([A-Z]+)1\b/g,(_,key)=>reference(name,key,1));
    return localFormula(mapped,row);
  };
  const year=new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric'}).format(new Date());
  for(const [planIndex,[name,items]] of plans.entries()){
    const profile=profiles.get(name),summary=planIndex<5,isCustomer=planIndex>=6;
    const ws=wb.addWorksheet(name,{properties:{tabColor:profile.tabColor||{argb:isCustomer?'FF4472C4':'FF83D32D'}}});
    const visibleColumns=profile.columns.flatMap((c,i)=>c.hidden?[]:[i+1]);
    const titleEnd=letter(visibleColumns[Math.min(11,visibleColumns.length-1)]||12);
    const headingEnd=letter(visibleColumns[Math.min(2,visibleColumns.length-1)]||3);
    const localRows=new Map(items.flatMap((r,i)=>!r.kind?[[r,i+4]]:[]));
    ws.addRow([`${year}年 各客产品核价汇总表 · ${name}${summary?'（金额单位：万港币；单价：港币）':'（金额及单价：港币）'}`]);ws.mergeCells(`A1:${titleEnd}1`);
    ws.addRow(profile.columns.map((c,i)=>i===0?'负责人':c.owner||null));
    ws.addRow(profile.columns.map(c=>c.label));
    items.forEach((r,i)=>{
      const n=i+4;
      if(r.kind==='heading'){ws.addRow([r.title]);ws.mergeCells(`A${n}:${headingEnd}${n}`);return;}
      ws.addRow(profile.columns.map(c=>{
        const key=c.key,v=r.values[key],scale=c.scale||1;
        if(['A','B','C'].includes(key)||v!=null&&!G.numeric(v))return v??null;
        const result=G.numeric(v)?v/scale:'';
        if(r.kind==='total'){
          // Ratios are recalculated from the corresponding display columns.
          // Both monetary numerator and denominator share the same 10,000 scale.
          if(G.ratios[key])return {formula:mappedFormula(r.formulas[key],name,n),result};
          const subtotal=subtotalRefs.get(`${r.values.A}\u0000${r.workshop}`);
          let refs;
          if(subtotal&&summary)refs=[reference(subtotal.name,key,subtotal.row,true)];
          else if(summary)refs=[...new Set(r.members.map(m=>{const s=subtotalRefs.get(`${m.values.A}\u0000${G.workshop(m)}`);return reference(s.name,key,s.row,true);}))];
          else refs=r.members.map(m=>{if(localRows.has(m))return reference(name,key,localRows.get(m));const s=customerRows.get(m);return reference(s.name,key,s.row,true);});
          const amount=`SUM(${refs.join(',')})`;
          return {formula:`IF(COUNT(${refs.join(',')})=${refs.length},${amount}${scale===1?'':'/'+scale},"")`,result};
        }
        if(!isCustomer){const s=customerRows.get(r),ref=reference(s.name,key,s.row,true);return {formula:`IF(ISNUMBER(${ref}),${ref},"")`,result};}
        if(r.formulas[key])return {formula:mappedFormula(r.formulas[key],name,n),result};
        return v??null;
      }));
    });
    profile.columns.forEach((c,i)=>{const col=ws.getColumn(i+1);col.width=c.width;col.hidden=c.hidden;});
    ws.views=[{state:'frozen',xSplit:summary?5:3,ySplit:3,showGridLines:false}];
    ws.eachRow((row,n)=>{
      const item=items[n-4],heading=item?.kind==='heading',total=item?.kind==='total';
      row.height=n<=3?profile.heights[n-1]:heading?42:profile.heights[3];
      row.eachCell({includeEmpty:true},(cell,c)=>{
        const column=profile.columns[c-1];if(!column)return;
        const styleId=n===1?profile.titleStyle:n===2?column.ownerStyle:n===3?column.header:total?column.total:column.body;
        cell.style=clone(layout.styles[styleId]);
        cell.alignment={...cell.alignment,vertical:'middle',wrapText:true};
        if(n===1){cell.font={...cell.font,size:24};cell.alignment.horizontal='left';cell.alignment.wrapText=false;}
        if(n===3)cell.alignment.horizontal='center';
        if(n>3&&!heading){
          const field=columns.find(f=>f.key===column.key);
          if(field?.percent)cell.numFmt='0.00%';
          if(['A','B','C'].includes(column.key))cell.numFmt='@';
          if(summary&&column.scale===10000)cell.numFmt='#,##0.00;[Red](#,##0.00)';
          if(total){cell.font={...cell.font,bold:true};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE2EFDA'}};}
        }
        if(heading){cell.font={name:'宋体',size:20,bold:true};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFD9EAD3'}};cell.alignment.horizontal='left';}
      });
    });
    ws.autoFilter={from:{row:3,column:1},to:{row:Math.max(3,ws.rowCount),column:135}};
    ws.pageSetup={orientation:'landscape',paperSize:9,scale:profile.printScale,fitToPage:false,printTitlesRow:'1:3',printTitlesColumn:'A:C',printArea:`A1:EE${Math.max(3,ws.rowCount)}`};
    ws.headerFooter.oddFooter='第 &P 页 / 共 &N 页';
  }
  // Keep workflow/source details off the very wide template report.
  const notes=wb.addWorksheet('生成提示');notes.addRow(['客户','货号','车间','核价版本','审核状态','数量来源','车间来源','提示']);
  for(const r of rows)notes.addRow([r.values.A,r.values.B,G.workshop(r),r.version||'',r.status_label||'',r.sources.D||'',r.workshop_source||'',(r.issues||[]).join('；')]);
  [24,28,18,14,14,55,55,100].forEach((w,i)=>notes.getColumn(i+1).width=w);notes.getRow(1).font={bold:true};notes.views=[{state:'frozen',ySplit:1}];
  return wb;
}
module.exports={buildWorkbook,localFormula};
