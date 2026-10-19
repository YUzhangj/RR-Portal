const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Excel=require('../frontend/excel-formulas');
const {calculateSummaryValues,afterTaxComponents,buildSummaryWorkbook,buildQuoteSummary}=require('../backend/services/quoteSummary');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const before={dom_mat:1,hardware:2,battery:3,flocking:4,other_buy:5,paint_material:6,color_box:7,libao:8,motor:9,glue_bag:10,misc:100,electronic:11,sewing_hair:12,sewing_cloth:13,carton:14,plating:15,imp_mat:16,freight:17,cabinet:18};

test('汇总与详情页的13%类及人民币外购件范围一致，马达和胶袋各计一次',()=>{
 const values=calculateSummaryValues(before,afterTaxComponents(before),2,1000);
 assert.equal(values.tax_13_cost,55);assert.equal(values.rmb_purchase_cost,220);
 const source=fs.readFileSync(path.join(__dirname,'../frontend/workbench.js'),'utf8');
 const context=vm.createContext({window:{},num:v=>Number(v)||0,formatNum:String});
 vm.runInContext(source.slice(source.indexOf('function renderTaxDeductionBlock('),source.indexOf('\nfunction hasSlushCostingInputs(')),context);
 const sales={};context.renderTaxDeductionBlock({innerHTML:'',querySelector:()=>null},sales,null,{},before);
 assert.equal(sales.pricing_summary.t4.tax13.amt,values.tax_13_cost);
 assert.equal(sales.pricing_summary.t4.rmb_buy.amt,values.rmb_purchase_cost);
 const r=buildQuoteSummary({qty:2},[{dept:'sales',payload_json:JSON.stringify({pricing_summary:{t1:{motor:9,glue_bag:10},t2:{misc:100}}})}]);
 assert.equal(r.summary_values.tax_13_cost,19);assert.equal(r.summary_values.rmb_purchase_cost,119);
});

test('导出公式使用马达胶袋输入，成本、减税、利润及金额可重新计算',async()=>{
 const values=calculateSummaryValues(before,afterTaxComponents(before),2,1000);
 const wb=buildSummaryWorkbook([{customer:'测试',qty:2,quoted_price:1000,components_before_tax:before,components:afterTaxComponents(before),summary_values:values,confirmation:{}}]);
 const saved=new(require('exceljs').Workbook)();await saved.xlsx.load(await wb.xlsx.writeBuffer());
 const ws=saved.getWorksheet('各客报价汇总');
 const col=label=>ws.getRow(4).values.indexOf(label);
 const tax=ws.getCell(5,col('含税13%成本')),purchase=ws.getCell(5,col('人民币采购成本'));
 const motor=ws.getCell(5,col('马达（计算来源）')),bag=ws.getCell(5,col('胶袋（计算来源）')),misc=ws.getCell(5,col('杂项'));
 for(const cell of [motor,bag]){assert.equal(ws.getColumn(cell.col).hidden,true);assert.ok(tax.formula.includes(cell.address));assert.ok(purchase.formula.includes(cell.address));}
 assert.ok(!tax.formula.includes(misc.address));assert.ok(purchase.formula.includes(misc.address));
 assert.equal(tax.result,55);assert.equal(purchase.result,220);
 const cells={};ws.eachRow(row=>row.eachCell(cell=>{cells['s!'+cell.address]={v:cell.formula?cell.result:cell.value,...(cell.formula?{f:cell.formula}:{})};}));
 const original=Excel.createEvaluator({cells});
 const cost=ws.getCell(5,col('成本（含人工）')),rebate=ws.getCell(5,col('总退税可减少成本')),profit=ws.getCell(5,col('退税后利润'));
 for(const cell of [tax,purchase,cost,rebate,profit])near(original.value('s!'+cell.address),cell.result);
 const adjusted=Excel.createEvaluator({cells},{['s!'+motor.address]:{v:19,f:null,t:'n'}});
 near(adjusted.value('s!'+tax.address),65);near(adjusted.value('s!'+purchase.address),230);
 near(adjusted.value('s!'+cost.address),cost.result+10);
 near(adjusted.value('s!'+rebate.address),rebate.result+1.15);
 near(adjusted.value('s!'+profit.address),profit.result-8.85);
});
