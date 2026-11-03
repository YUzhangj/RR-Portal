const ExcelJS=require('exceljs');
const {serial}=require('../../frontend/mixed-sku');
const text=v=>v==null?'':typeof v==='object'?v.richText?v.richText.map(x=>x.text).join(''):String(v.result??v.text??''):String(v).trim();
function capsuleRatio(cell, rowNumber) {
 let value=cell.value;
 if(value && typeof value==='object') {
  if ('formula' in value || 'sharedFormula' in value) {
   if(value.result == null) throw Error(`第${rowNumber}行 Ratio per capsule 公式没有计算结果，请在 Excel 中计算并保存后再导入`);
   value=value.result;
  } else value=text(value);
 }
 if(value == null || String(value).trim()==='') throw Error(`第${rowNumber}行 Ratio per capsule 为空`);
 if(typeof value==='number') { if(!Number.isFinite(value)||value<0) throw Error(`第${rowNumber}行 Ratio per capsule 无效`); return value; }
 const raw=String(value).trim().replace(/％/g,'%');
 const percent=raw.endsWith('%');
 const numeric=percent?raw.slice(0,-1).trim():raw;
 if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric)) throw Error(`第${rowNumber}行 Ratio per capsule 无效`);
 const ratio=Number(numeric)/(percent?100:1);
 if(!Number.isFinite(ratio)||ratio<0) throw Error(`第${rowNumber}行 Ratio per capsule 无效`);
 return ratio;
}
async function parseWorkbook(buffer){
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);
 for(const ws of wb.worksheets){
  let columns=null;const records=[];
  ws.eachRow(row=>{
   if(!columns){const headers={};row.eachCell((c,i)=>{headers[text(c.value).toLowerCase().replace(/[\s_.]/g,'')]=i;});if(headers.miniitemno&&(headers.discription||headers.description)&&headers.no)columns={number:headers.no,code:headers.miniitemno,name:headers.discription||headers.description,brand:headers.brand,capsule:headers.ratiopercapsule};return;}
   const code=text(row.getCell(columns.code).value);if(!code)return;
   const number=text(row.getCell(columns.number).value);if(!/^\d+$/.test(number))throw Error(`第${row.number}行序号无效`);
   const name=text(row.getCell(columns.name).value);if(!name)throw Error(`第${row.number}行产品名称为空`);
   records.push({source_number:serial(number),code,name,brand:columns.brand?text(row.getCell(columns.brand).value):'',...(columns.capsule?{na_ratio:capsuleRatio(row.getCell(columns.capsule),row.number)}:{})});
  });
  if(columns){if(!records.length)throw Error('没有产品资料');if(records.length>200)throw Error('产品不能超过200个');if(new Set(records.map(r=>r.source_number)).size!==records.length||new Set(records.map(r=>r.code)).size!==records.length)throw Error('序号或货号重复');records.sort((a,b)=>Number(a.source_number)-Number(b.source_number));return {records,sheet_used:ws.name};}
 }
 throw Error('未找到 NO.、Mini_item no、Discription 表头');
}
module.exports={parseWorkbook};
