const test=require('node:test'),assert=require('node:assert/strict');
const Excel=require('../frontend/excel-formulas');
const {calculateSummaryValues,afterTaxComponents,buildSummaryWorkbook,buildQuoteSummary}=require('../backend/services/quoteSummary');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('944及945叠加：纸箱、部分含税车缝和马达胶袋在页面及可重算导出中各计一次',async()=>{
 const before={motor:9,glue_bag:10,misc:100,carton:11,sewing_cloth:20,sewing_hair:10,dom_mat:4,other_buy:7,paint_material:1,injection_labor:8};
 const sewing={sewing_hair:0,sewing_cloth:5};
 const after=afterTaxComponents(before,sewing),values=calculateSummaryValues(before,after,10,300,0,sewing);
 assert.equal(values.tax_13_cost,31);assert.equal(values.rmb_purchase_cost,172);
 assert.equal(values.cost_with_labor,180);near(values.carton_after_tax,9.85);
 assert.equal(values.hair_13_cost,0);assert.equal(values.cloth_13_cost,5);
 near(values.rebate_reduction,31*.115+11/1.1*.115+5*.115+8*.08*.115);
 const wb=buildSummaryWorkbook([{customer:'COMBINED',qty:10,quoted_price:300,components_before_tax:before,components:after,sewing_taxable:sewing,summary_values:values,confirmation:{}}]);
 const saved=new(require('exceljs').Workbook)();await saved.xlsx.load(await wb.xlsx.writeBuffer());
 const ws=saved.getWorksheet('各客报价汇总'),cell=label=>ws.getCell(5,ws.getRow(4).values.indexOf(label));
 const cells={};ws.eachRow(row=>row.eachCell(c=>{cells['s!'+c.address]={v:c.formula?c.result:c.value,...(c.formula?{f:c.formula}:{})};}));
 const original=Excel.createEvaluator({cells});
 for(const label of ['成本（含人工）','人民币采购成本','含税13%成本','总退税可减少成本','退税后利润'])near(original.value('s!'+cell(label).address),cell(label).result);
 const motor=cell('马达（计算来源）'),hair=cell('车发'),carton=cell('纸箱');
 const changed=Excel.createEvaluator({cells},{['s!'+motor.address]:{v:19,f:null,t:'n'},['s!'+hair.address]:{v:13,f:null,t:'n'},['s!'+carton.address]:{v:12.1,f:null,t:'n'}});
 near(changed.value('s!'+cell('含税13%成本').address),41);
 near(changed.value('s!'+cell('人民币采购成本').address),186.1);
 near(changed.value('s!'+cell('成本（含人工）').address),194.1);
 near(changed.value('s!'+cell('总退税可减少成本').address),values.rebate_reduction+1.15+.115);
 near(changed.value('s!'+cell('退税后利润').address),values.profit_after_tax-14.1+1.15+.115);
});

test('真实部门明细的马达从五金分出、胶袋归类，杂项只计采购不计13%退税',()=>{
 const sections=Object.entries({
  sales:{header:{fx_rmb_hkd:1,fx_hkd_usd:7.8},shipping:{scenarios:[]}},
  engineering:{hardware:[{name:'马达',qty:1,unit_price_rmb:9},{name:'五金',qty:1,unit_price_rmb:2}],packaging_materials:[{name:'PE bag',qty:1,unit_price_rmb:10}],indo_pct:10}
 }).map(([dept,payload])=>({dept,payload_json:JSON.stringify(payload)}));
 const row=buildQuoteSummary({qty:10,factory_code:'qingxi'},sections),before=row.components_before_tax;
 near(before.motor,9);near(before.hardware,2);near(before.glue_bag,10);const surcharge = require('../backend/services/quoteCostSummary').calculateSingleQuoteCosts({qty:10,factory_code:'qingxi'},sections).detailPricing.surtaxHkd;
 near(before.misc,2.1+surcharge);
 near(row.summary_values.tax_13_cost,21);near(row.summary_values.rmb_purchase_cost,23.1+surcharge);
 near(row.summary_values.cost_with_labor,23.1+surcharge);near(row.summary_values.rebate_reduction,2.415);
});
