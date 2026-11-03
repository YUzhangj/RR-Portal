'use strict';
const ExcelJS=require('exceljs');
const G=require('../../frontend/verification-report-groups');
const layout=require('./verificationExportLayout.json');
const clone=value=>JSON.parse(JSON.stringify(value));
const quoteSheet=name=>`'${name.replace(/'/g,"''")}'`;
const letter=index=>{let s='';for(let n=index;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
const sectionedWorkshopSheets=new Set(['总表分车间','打印','截图']);
const consolidatedSheets=new Set(['总表不分车间','不分车间 打印']);
const customerDetailSheet='不分车间核价明细';
const workshopOrder=['华登','兴信A','兴信B','河源',G.pending];
function reportBasis(now=new Date()){
  const source=String(layout.source||'');
  const dateParts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric',month:'numeric'}).formatToParts(now).map(part=>[part.type,part.value]));
  return {
    year:dateParts.year,
    month:dateParts.month,
    fx:source.match(/汇率\s*([\d.]+)/)?.[1]||'',
    abs:source.match(/ABS\s*([\d.]+)/i)?.[1]||''
  };
}
function workshopSections(items){
  const sections=[];let current=null,grandTotal=null;
  for(const item of items){
    if(item.kind==='heading'){
      current={workshop:item.title,items:[]};sections.push(current);continue;
    }
    if(item.kind==='total'&&item.values.C==='总合计'){grandTotal=item;continue;}
    current?.items.push(item);
  }
  const rank=name=>{const i=workshopOrder.indexOf(name);return i<0?workshopOrder.length:i;};
  sections.sort((a,b)=>rank(a.workshop)-rank(b.workshop)||a.workshop.localeCompare(b.workshop,'zh-CN'));
  return {sections,grandTotal};
}
function customerDetailSections(items){
  const sections=[];let current=null;
  for(const item of items){
    if(item.kind==='heading'){
      current={customer:item.title,items:[]};sections.push(current);continue;
    }
    current?.items.push(item);
  }
  return sections;
}
function customerWorkshopSections(items){
  const sections=[];let current=null,grandTotal=null;
  for(const item of items){
    if(item.kind==='heading'){
      current={workshop:String(item.title||'').split(' · ').at(-1),items:[]};sections.push(current);continue;
    }
    if(item.kind==='total'&&item.values.C==='客户合计'){grandTotal=item;continue;}
    current?.items.push(item);
  }
  return {sections,grandTotal};
}
function localFormula(expression,row){
  const refs=[...new Set(expression.match(/\b[A-Z]+1\b/g)||[])].map(ref=>ref.replace(/1$/,row));
  const formula=expression.replace(/([A-Z]+)1\b/g,`$1${row}`);
  return refs.length?`IF(COUNT(${refs.join(',')})=${refs.length},${formula},"")`:formula;
}
function buildWorkbook(rows,columns,{now=new Date(),factoryName=''}={}){
  const wb=new ExcelJS.Workbook();wb.creator='内部报价系统';wb.calcProperties.fullCalcOnLoad=true;
  const workshopSummary=G.reportRows(rows,'workshop-summary'),customerSummary=G.reportRows(rows,'customer-summary');
  const plans=[
    ['总表分车间',workshopSummary],
    ['打印',workshopSummary],
    ['截图',workshopSummary],
    ['总表不分车间',customerSummary],
    ['不分车间 打印',customerSummary],
    ['不分车间核价明细',G.reportRows(rows,'all-details')]
  ];
  const used=new Set(plans.map(p=>p[0].toLowerCase()).concat('生成提示'));
  for(const [customer,items] of G.group(rows,r=>r.values.A)){
    const base=String(customer||'未填写客户').replace(/[\\/*?:\[\]]/g,'_').slice(0,26);let name=base,i=1;
    while(used.has(name.toLowerCase()))name=`${base}_${i++}`;
    used.add(name.toLowerCase());plans.push([name,G.reportRows(items,'customer-detail')]);
  }
  const profiles=new Map(plans.map(([name],i)=>[name,layout.profiles[i<6?name:'customer']]));
  const workshopTotalStyles=new Map(layout.profiles['总表分车间'].columns.map(column=>[column.key,column.total]));
  const columnRefs=new Map([...profiles].map(([name,p])=>[name,new Map(p.columns.map((c,i)=>[c.key,letter(i+1)]))]));
  const percentKeys=new Set(columns.filter(c=>c.percent).map(c=>c.key));
  const styles=new Map();
  function cellStyle(styleId,{title,centerTitle,header,total,detailTotal,heading,percent,text,scaled,uniform16}){
    const key=[styleId,title,centerTitle,header,total,detailTotal,heading,percent,text,scaled,uniform16].join('|');
    if(styles.has(key))return styles.get(key);
    const style=clone(layout.styles[styleId]);
    style.alignment={...style.alignment,vertical:'middle',wrapText:true};
    if(title){style.font={...style.font,size:24};style.alignment.horizontal=centerTitle?'center':'left';style.alignment.wrapText=false;}
    else if(uniform16)style.font={...style.font,size:16};
    if(header)style.alignment.horizontal='center';
    if(percent)style.numFmt='0.00%';
    if(text)style.numFmt='@';
    if(scaled)style.numFmt='#,##0.00;[Red](#,##0.00)';
    if(total)style.font={...style.font,bold:true};
    if(detailTotal){style.font={...style.font,size:16,bold:true};style.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF9DC3E6'}};}
    if(heading){style.font={name:'宋体',size:uniform16?16:20,bold:true};style.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFD9EAD3'}};style.alignment.horizontal='left';}
    styles.set(key,style);return style;
  }
  const customerRows=new Map(),subtotalRefs=new Map();
  for(const [name,items] of plans.slice(6)){
    let physicalRow=1;
    for(const r of items){
      if(r.kind==='heading'){physicalRow+=2;continue;}
      physicalRow+=1;
      if(!r.kind)customerRows.set(r,{name,row:physicalRow});
      if(r.kind==='total')subtotalRefs.set(`${r.values.A}\u0000${r.workshop}`,{name,row:physicalRow});
    }
  }
  const reference=(name,key,row,qualified=false)=>{
    const column=columnRefs.get(name).get(key);
    if(!column)throw Error(`导出模板缺少栏目 ${name}: ${key}`);
    return `${qualified?quoteSheet(name)+'!':''}${column}${row}`;
  };
  const mappedFormula=(expression,name,row)=>{
    const mapped=expression.replace(/\b([A-Z]+)1\b/g,(_,key)=>reference(name,key,1));
    return localFormula(mapped,row);
  };
  const basis=reportBasis(now),year=basis.year;
  for(const [planIndex,[name,items]] of plans.entries()){
    const profile=profiles.get(name),summary=planIndex<5,isCustomer=planIndex>=6,sectioned=sectionedWorkshopSheets.has(name),consolidated=consolidatedSheets.has(name),detailed=name===customerDetailSheet;
    const ws=wb.addWorksheet(name,{properties:{tabColor:profile.tabColor||{argb:isCustomer?'FF4472C4':'FF83D32D'}}});
    const visibleColumns=profile.columns.flatMap((c,i)=>c.hidden?[]:[i+1]);
    const titleEnd=letter(visibleColumns[Math.min(11,visibleColumns.length-1)]||12);
    const headingEnd=letter(visibleColumns[Math.min(2,visibleColumns.length-1)]||3);
    const localRows=new Map(detailed||isCustomer?[]:items.flatMap((r,i)=>!r.kind?[[r,i+4]]:[])),rowMeta=new Map();
    const addTitle=(title,mergeEnd=titleEnd)=>{const row=ws.addRow([title]);ws.mergeCells(`A${row.number}:${mergeEnd}${row.number}`);rowMeta.set(row.number,{kind:'title',centerTitle:sectioned||consolidated});};
    const addOwners=()=>{const row=ws.addRow(profile.columns.map((c,i)=>i===0?'负责人':c.owner||null));rowMeta.set(row.number,{kind:'owner'});};
    const addSectionOwners=label=>{const row=ws.addRow(profile.columns.map((c,i)=>i===0?label:c.owner||null));rowMeta.set(row.number,{kind:'owner'});};
    const addHeaders=()=>{const row=ws.addRow(profile.columns.map(c=>c.label));rowMeta.set(row.number,{kind:'header'});};
    const addItem=r=>{
      const n=ws.rowCount+1;
      if(r.kind==='heading'){const row=ws.addRow([r.title]);ws.mergeCells(`A${n}:${headingEnd}${n}`);rowMeta.set(n,{kind:'heading',item:r});return;}
      if((detailed||isCustomer)&&!r.kind)localRows.set(r,n);
      const row=ws.addRow(profile.columns.map(c=>{
        const key=c.key,v=r.values[key],scale=c.scale||1;
        if(sectioned&&key==='A'&&r.kind==='total'&&r.values.C==='车间合计')return '合计：';
        if(sectioned&&key==='A'&&r.kind==='total'&&r.values.C==='总合计')return '总合计：';
        if(consolidated&&key==='A'&&r.kind==='total'&&r.values.C==='总合计')return '合计：';
        if(detailed&&r.kind==='total'&&r.values.C==='客户合计'){
          if(key==='A'||key==='B')return null;
          if(key==='C')return '合计';
        }
        if(isCustomer&&r.kind==='total'){
          if(key==='A'||key==='B')return null;
          if(key==='C')return r.values.C==='客户合计'?'总合计':'合计';
        }
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
      }));rowMeta.set(row.number,{kind:'data',item:r});
    };
    if(sectioned){
      const grouped=workshopSections(items);
      for(const section of grouped.sections){
        const month=basis.month?`${basis.month}月份`:'';
        const suffix=[basis.abs&&`ABS ${basis.abs}`,basis.fx&&`汇率 ${basis.fx}`].filter(Boolean).join('；');
        addTitle(`${year}年${month}${section.workshop}各客实际生意核价总表${suffix?`（${suffix}）`:''}`,'EE');
        addOwners();addHeaders();section.items.forEach(addItem);
      }
      if(grouped.grandTotal){const spacer=ws.addRow([]);rowMeta.set(spacer.number,{kind:'blank'});addItem(grouped.grandTotal);}
    }else if(detailed){
      addTitle(`${year}年`);
      for(const section of customerDetailSections(items)){
        addOwners();addHeaders();section.items.forEach(addItem);
      }
    }else if(isCustomer){
      const grouped=customerWorkshopSections(items);
      const workshopTitle=grouped.sections[0]?.workshop||'';
      const suffix=[basis.abs&&`ABS ${basis.abs}`,basis.fx&&`汇率 ${basis.fx}`].filter(Boolean).join('；');
      addTitle(`${year}年 ${workshopTitle}各客产品核价总表${suffix?`（${suffix}）`:''}`,'EE');
      for(const section of grouped.sections){
        const label=section.workshop==='兴信A'?'A':section.workshop==='兴信B'?'B':section.workshop;
        addSectionOwners(label);addHeaders();section.items.forEach(addItem);
      }
      if(grouped.grandTotal)addItem(grouped.grandTotal);
    }else{
      if(consolidated){
        const month=basis.month?`${basis.month}月份`:'';
        const factory=String(factoryName||'').trim().replace(/厂区$/,'');
        const suffix=[basis.abs&&`ABS ${basis.abs}`,basis.fx&&`汇率 ${basis.fx}`].filter(Boolean).join('；');
        addTitle(`${factory?`${factory}厂区---`:''}${year}年${month}各客实际生意核价总表${suffix?`（${suffix}）`:''}`,'EE');
      }else addTitle(`${year}年 各客产品核价汇总表 · ${name}${summary?'（金额单位：万港币；单价：港币）':'（金额及单价：港币）'}`);
      addOwners();addHeaders();items.forEach(addItem);
    }
    profile.columns.forEach((c,i)=>{const col=ws.getColumn(i+1);col.width=c.width;col.hidden=c.hidden;});
    ws.views=[{state:'frozen',xSplit:summary?5:3,ySplit:3,showGridLines:false}];
    ws.eachRow((row,n)=>{
      const meta=rowMeta.get(n)||{},item=meta.item,heading=meta.kind==='heading';
      const total=item?.kind==='total'&&(!sectioned||item.values.C!=='客户小计'),grandTotal=item?.kind==='total'&&item.values.C==='总合计';
      const detailTotal=(detailed||isCustomer)&&item?.kind==='total';
      row.height=meta.kind==='title'?profile.heights[0]:meta.kind==='owner'?profile.heights[1]:meta.kind==='header'?profile.heights[2]:meta.kind==='blank'?12:heading?42:profile.heights[3];
      row.eachCell({includeEmpty:true},(cell,c)=>{
        const column=profile.columns[c-1];if(!column)return;
        const styleId=meta.kind==='title'?profile.titleStyle:meta.kind==='owner'?column.ownerStyle:meta.kind==='header'?column.header:grandTotal&&consolidated?workshopTotalStyles.get(column.key)??column.total:total?(sectioned?workshopTotalStyles.get(column.key)??column.total:column.total):column.body;
        cell.style=cellStyle(styleId,{title:meta.kind==='title',centerTitle:meta.centerTitle,header:meta.kind==='header',total:meta.kind==='data'&&!heading&&total,detailTotal,heading,
          percent:meta.kind==='data'&&!heading&&percentKeys.has(column.key),text:meta.kind==='data'&&!heading&&['A','B','C'].includes(column.key),scaled:meta.kind==='data'&&!heading&&summary&&column.scale===10000,uniform16:true});
      });
    });
    if(!sectioned&&!detailed&&!isCustomer)ws.autoFilter={from:{row:3,column:1},to:{row:Math.max(3,ws.rowCount),column:135}};
    ws.pageSetup={orientation:'landscape',paperSize:9,scale:profile.printScale,fitToPage:false,printTitlesRow:'1:3',printTitlesColumn:'A:C',printArea:`A1:EE${Math.max(3,ws.rowCount)}`};
    ws.headerFooter.oddFooter='第 &P 页 / 共 &N 页';
  }
  // Keep workflow/source details off the very wide template report.
  const notes=wb.addWorksheet('生成提示');notes.addRow(['客户','货号','车间','核价版本','审核状态','数量来源','车间来源','提示']);
  for(const r of rows)notes.addRow([r.values.A,r.values.B,G.workshop(r),r.version||'',r.status_label||'',r.sources.D||'',r.workshop_source||'',(r.issues||[]).join('；')]);
  [24,28,18,14,14,55,55,100].forEach((w,i)=>notes.getColumn(i+1).width=w);notes.eachRow((row,n)=>row.eachCell(cell=>{cell.font={name:'Arial',size:16,bold:n===1};}));notes.views=[{state:'frozen',ySplit:1}];
  return wb;
}
module.exports={buildWorkbook,localFormula};
