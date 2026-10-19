const test=require('node:test'),assert=require('node:assert/strict');
const {calculateSummaryValues,buildSummaryWorkbook}=require('../backend/services/quoteSummary');
test('啤工占比按生产金额计算，零接单为零，客户合计按金额加权',()=>{
 const make=(qty,price,labor)=>{const before={injection_labor:labor};return {customer:'T',qty,quoted_price:price,abs_material_cost:7,components_before_tax:before,components:before,summary_values:calculateSummaryValues(before,before,qty,price),confirmation:{}};};
 const rows=[make(100,10,2),make(50,20,1),make(0,10,9)];
 assert.equal(rows[2].summary_values.injection_labor_share,0);
 const ws=buildSummaryWorkbook(rows).getWorksheet('各客报价汇总');
 const col=label=>ws.getRow(4).values.indexOf(label);
 const share=col('啤工占比'),amount=ws.getColumn(col('啤工金额')).letter,production=ws.getColumn(col('总生产金额')).letter;
 assert.equal(ws.getCell(5,share).formula,`IF(${production}5=0,0,${amount}5/${production}5)`);
 assert.equal(ws.getCell(7,share).result||0,0);
 assert.equal(ws.getCell(8,share).result,250/2000);
});

test('所有成本占比使用对应总金额，导出与客户合计一致',()=>{
 const {SHARE_AMOUNTS,SHARE_UNITS,SUMMARY_COLUMNS,AMOUNT_SHARE_KEYS}=require('../backend/services/quoteSummary');
 const before={injection_labor:2,assembly_labor:3,painting_labor:4,imp_mat:5,dom_mat:6,color_box:1,libao:1,suction:1,carton:1,electronic:1,battery:1,hardware:1,slush:1,sewing_hair:1,sewing_cloth:1,paint_material:1,other_buy:1,misc:1,freight:2,cabinet:1};
 const rows=[{qty:100,price:100},{qty:50,price:200},{qty:0,price:100},{qty:10,price:0}].map(({qty,price})=>({customer:'T',qty,quoted_price:price,abs_material_cost:7,components_before_tax:before,components:before,summary_values:calculateSummaryValues(before,before,qty,price,7),confirmation:{}}));
 const ws=buildSummaryWorkbook(rows).getWorksheet('各客报价汇总');
 const col=key=>9+SUMMARY_COLUMNS.findIndex(c=>c[0]===key);
 const production=ws.getColumn(col('production_amount')).letter;
 for(const [key,amount] of Object.entries(SHARE_AMOUNTS)) {
   assert.equal(rows[2].summary_values[key],0,key);
   assert.equal(rows[3].summary_values[key],0,key);
   const amountCol=ws.getColumn(col(amount)).letter;
   assert.equal(ws.getCell(5,col(key)).formula,`IF(${production}5=0,0,${amountCol}5/${production}5)`,key);
   const numerator=rows.reduce((s,r)=>s+r.summary_values[amount],0);
   assert.equal(ws.getCell(9,col(key)).result,numerator/20000,key);
 }
 for(const [key,unit] of Object.entries(SHARE_UNITS)) {
   assert.equal(rows[2].summary_values[key],rows[2].summary_values[unit]/100);
   assert.equal(rows[3].summary_values[key],0);
   assert.equal(ws.getCell(9,col(key)).result,rows.reduce((sum,r)=>sum+r.summary_values[unit],0)/400);
   const unitCol=ws.getColumn(col(unit)).letter;
   assert.equal(ws.getCell(5,col(key)).formula,`IF(H5=0,0,${unitCol}5/H5)`);
   assert.equal(ws.getCell(9,col(key)).formula,`IF(H9=0,0,${unitCol}9/H9)`);
 }
 const allAmounts=rows.reduce((sum,r)=>sum+AMOUNT_SHARE_KEYS.reduce((s,k)=>s+r.summary_values[SHARE_AMOUNTS[k]],0),0);
 assert.equal(ws.getCell(9,col('amount_share_total')).result,allAmounts/20000);
});

test('退税后纸箱按成本减去成本除以1.1乘11.5%，金额和占比联动',()=>{
 const {afterTaxComponents,SUMMARY_COLUMNS}=require('../backend/services/quoteSummary');
 const before={carton:1.1},after=afterTaxComponents(before);
 assert.equal(after.carton,0.985);
 assert.equal(afterTaxComponents({carton:0}).carton,0);
 const values=calculateSummaryValues(before,after,100,10);
 assert.equal(values.carton_after_tax,0.985);
 assert.ok(Math.abs(values.carton_amount-98.5)<1e-9);
 assert.ok(Math.abs(values.carton_share-0.0985)<1e-9);
 const ws=buildSummaryWorkbook([{customer:'T',qty:100,quoted_price:10,components_before_tax:before,components:after,summary_values:values,confirmation:{}}]).getWorksheet('各客报价汇总');
 const col=key=>9+SUMMARY_COLUMNS.findIndex(c=>c[0]===key);
 const carton=ws.getColumn(col('carton')).letter;
 assert.equal(ws.getCell(5,col('carton_after_tax')).formula,`${carton}5-${carton}5/1.1*11.5%`);
 assert.equal(ws.getCell(5,col('carton_after_tax')).result,0.985);
});

test('退税后运费包含未退税吊柜费，导出公式与页面计算一致',()=>{
 const {afterTaxComponents,SUMMARY_COLUMNS}=require('../backend/services/quoteSummary');
 const before={freight:100,cabinet:50},after=afterTaxComponents(before);
 const values=calculateSummaryValues(before,after,10,200);
 assert.equal(values.freight_after_tax,141.74);
 assert.equal(values.freight_amount,1417.4);
 const ws=buildSummaryWorkbook([{customer:'T',qty:10,quoted_price:200,components_before_tax:before,components:after,summary_values:values,confirmation:{}}]).getWorksheet('各客报价汇总');
 const col=key=>9+SUMMARY_COLUMNS.findIndex(c=>c[0]===key);
 const freight=ws.getColumn(col('freight')).letter,cabinet=ws.getColumn(col('cabinet')).letter;
 assert.equal(ws.getCell(5,col('freight_after_tax')).formula,`(${freight}5-${freight}5*8.26%)+${cabinet}5`);
 assert.equal(ws.getCell(5,col('freight_after_tax')).result,141.74);
 assert.equal(ws.getCell(5,col('freight_share')).result,1417.4/2000);
});

test('未退税前毛利直接引用货价减不含人工成本',()=>{
 const {afterTaxComponents,SUMMARY_COLUMNS}=require('../backend/services/quoteSummary');
 const before={injection_labor:2,assembly_labor:3,painting_labor:1,carton:4,imp_mat:5};
 const after=afterTaxComponents(before),values=calculateSummaryValues(before,after,10,20);
 assert.equal(values.cost_without_labor,9);
 assert.equal(values.gross_before_tax,11);
 assert.equal(values.profit_before_tax,5);
 const ws=buildSummaryWorkbook([{customer:'T',qty:10,quoted_price:20,components_before_tax:before,components:after,summary_values:values,confirmation:{}}]).getWorksheet('各客报价汇总');
 const col=key=>9+SUMMARY_COLUMNS.findIndex(c=>c[0]===key);
 assert.equal(ws.getCell(5,col('gross_before_tax')).formula,`H5-${ws.getColumn(col('cost_without_labor')).letter}5`);
 assert.equal(ws.getCell(5,col('gross_before_tax')).result,11);
 assert.equal(ws.getCell(5,col('profit_before_tax')).formula,`H5-${ws.getColumn(col('cost_with_labor')).letter}5`);
 assert.equal(ws.getCell(5,col('profit_before_tax')).result,5);
 const cost=ws.getColumn(col('cost_with_labor')).letter;
 assert.equal(ws.getCell(5,col('markup_before_tax')).formula,`IF(${cost}5=0,0,H5/${cost}5)`);
 assert.equal(ws.getCell(5,col('markup_before_tax')).result,20/15);
 assert.equal(calculateSummaryValues({}, {}, 10, 20).markup_before_tax,0);
});

test('含税13%成本包含杂项，退税及利润随之更新',()=>{
 const {afterTaxComponents,SUMMARY_COLUMNS}=require('../backend/services/quoteSummary');
 const before={misc:100},after=afterTaxComponents(before),values=calculateSummaryValues(before,after,10,200);
 assert.equal(values.tax_13_cost,100);
 assert.equal(values.rebate_reduction,11.5);
 assert.equal(values.cost_after_rebate,88.5);
 assert.equal(values.profit_after_tax,111.5);
 const ws=buildSummaryWorkbook([{customer:'T',qty:10,quoted_price:200,components_before_tax:before,components:after,summary_values:values,confirmation:{}}]).getWorksheet('各客报价汇总');
 const col=key=>9+SUMMARY_COLUMNS.findIndex(c=>c[0]===key);
 assert.equal(ws.getCell(5,col('tax_13_cost')).formula,'SUM(AE5,AI5,BA5,BU5,X5,BE5,AV5,BY5,CC5)');
 assert.equal(ws.getCell(5,col('tax_13_cost')).result,100);
 assert.equal(ws.getCell(5,col('cost_after_rebate')).formula,`${ws.getColumn(col('cost_with_labor')).letter}5-${ws.getColumn(col('rebate_reduction')).letter}5`);
 assert.equal(ws.getCell(5,col('cost_after_rebate')).result,88.5);
});
