const ExcelJS=require('exceljs');
const {serial}=require('../../frontend/mixed-sku');
const text=v=>v==null?'':typeof v==='object'?v.richText?v.richText.map(x=>x.text).join(''):String(v.result??v.text??''):String(v).trim();
async function parseWorkbook(buffer){
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);
 for(const ws of wb.worksheets){
  let columns=null;const records=[];
  ws.eachRow(row=>{
   if(!columns){const headers={};row.eachCell((c,i)=>{headers[text(c.value).toLowerCase().replace(/[\s_.]/g,'')]=i;});if(headers.miniitemno&&(headers.discription||headers.description)&&headers.no)columns={number:headers.no,code:headers.miniitemno,name:headers.discription||headers.description,brand:headers.brand};return;}
   const code=text(row.getCell(columns.code).value);if(!code)return;
   const number=text(row.getCell(columns.number).value);if(!/^\d+$/.test(number))throw Error(`第${row.number}行序号无效`);
   const name=text(row.getCell(columns.name).value);if(!name)throw Error(`第${row.number}行产品名称为空`);
   records.push({source_number:serial(number),code,name,brand:columns.brand?text(row.getCell(columns.brand).value):''});
  });
  if(columns){if(!records.length)throw Error('没有产品资料');if(records.length>200)throw Error('产品不能超过200个');if(new Set(records.map(r=>r.source_number)).size!==records.length||new Set(records.map(r=>r.code)).size!==records.length)throw Error('序号或货号重复');return {records,sheet_used:ws.name};}
 }
 throw Error('未找到 NO.、Mini_item no、Discription 表头');
}
module.exports={parseWorkbook};
