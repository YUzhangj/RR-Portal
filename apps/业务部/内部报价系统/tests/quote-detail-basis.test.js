const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { calculateDetailPricing } = require('../backend/services/quoteDetailPricing');
const { calculateSingleQuoteCosts } = require('../backend/services/quoteCostSummary');
const { buildQuoteSummary, buildSummaryWorkbook, BASE_SUMMARY_COLUMNS, SUMMARY_COLUMNS } = require('../backend/services/quoteSummary');
const { buildWorkbook } = require('../backend/services/exportInternal');
const source = fs.readFileSync(path.join(__dirname, '../frontend/workbench.js'), 'utf8');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const sectionsOf = p => Object.entries(p).map(([dept, data]) => ({dept, payload_json: JSON.stringify(data)}));
// Run the actual page calculator, omitting only DOM rendering.
const ctx = vm.createContext({ num: v => Number(v) || 0, sum: (rows, f) => (rows || []).reduce((a, r) => a + f(r), 0) });
vm.runInContext(source.slice(source.indexOf('const FREIGHT_TYPES ='), source.indexOf('function renderJazwaresFreight(')), ctx);
vm.runInContext(source.slice(source.indexOf('function matchFreightByName('), source.indexOf('function renderShipping(')), ctx);
const start = source.indexOf('function renderShipping(');
vm.runInContext(source.slice(start, source.indexOf('\n  // 重算并仅刷新计算单元格', start)) + '\nreturn compute();\n}', ctx);
const quote = { id:1, customer:'TOMY', quote_no:'CHECK', qty:1000, factory_code:'qingxi' };
function payloads() {
  return {
    sales: {header:{fx_rmb_hkd:1,fx_hkd_usd:7.8}, pricing_summary:{surtax:999,indo_freight:999},
      freight_calc:{cap_40:100,yt40:1000,cap_20:100,hk20:300},
      shipping:{markup_x:1.2,divisor:.98,freight_pct:48,lifting_pct:52,scenarios:[{name:'盐田40柜',_freight_rate:999}],
        customer_supplied_products:[{name:'成品',amount_usd:2}]}},
    engineering:{hardware:[{name:'五金',qty:1,unit_price:10}],carton_calc:{cuft:1,qty:10},
      mold_costs:{items:[{price_rmb:850}],amortization_qty:1000,fx_rmb_usd:10,customer_subsidy_usd:10,
        prototype_fee_usd:100,prototype_amortization_qty:1000,testing_fee_usd:200,testing_amortization_qty:1000}},
    sewing:{indo_pct:10,sewing_groups:[{category:'车衣',product_qty:1,
      items:[{fabric:'布料',usage:1,mat_price:10},{fabric:'人工',usage:1,mat_price:5}],labor_amount:5}]},
  };
}
test('汇总货价及附加税与详情页原函数一致，覆盖摊费、客供及多种场景', () => {
  for (const name of ['盐田40柜','香港20柜','出厂价']) {
    const p=payloads(); p.sales.shipping.scenarios=[{name,is_factory:name==='出厂价'}];
    Object.assign(p.sales.shipping,{sew_markup_x:1.3,elec_markup_x:1.4,surtax_markup_x:1.1});
    const args={quote,sales:p.sales,engineering:p.engineering,mainBase:11.1234567,sewingHkd:15.1234567,electronicHkd:2.1234567};
    const actual=calculateDetailPricing(args);
    const expected=ctx.renderShipping(null,structuredClone(p.sales),p.sales.header,false,()=>{},
      ctx.computeFreightMap(p.sales.freight_calc,p.engineering.carton_calc),args.mainBase,null,
      {mold:.09,prototype:.1,testing:.2},{sewing:args.sewingHkd,electronic:args.electronicHkd});
    near(actual.quotedPrice,expected.customerBeforeDivisorHkd);
    near(actual.surtaxHkd,expected.customerSurtaxHkd);
  }
});
test('运费排除车缝人工，忽略旧快照，汇总及明细导出同值', async () => {
  const p=payloads(),sections=sectionsOf(p);
  const costs=calculateSingleQuoteCosts(quote,sections);
  near(costs.indoFreight,1);
  near(costs.detailPricing.moldShare,.09);
  near(costs.detailPricing.prototypeShare,.1);
  near(costs.detailPricing.testingShare,.2);
  near(costs.components.misc,1+costs.detailPricing.surtaxHkd);
  const summary=buildQuoteSummary(quote,sections);
  near(summary.quoted_price,costs.detailPricing.quotedPrice);
  const summarySheet=buildSummaryWorkbook([summary]).worksheets[0];
  const col=key=>[...BASE_SUMMARY_COLUMNS,...SUMMARY_COLUMNS].findIndex(c=>c[0]===key)+1;
  near(summarySheet.getCell(5,col('quoted_price')).value,summary.quoted_price);
  const total=summarySheet.getCell(5,col('production_amount')).value;
  near(total.result,summary.quoted_price*quote.qty);
  assert.match(total.formula,/\*/);
  const verified=require('../backend/services/verificationSummary').buildVerificationRow(quote,{id:1,status:'drafting'},sections,[]);
  near(verified.values.E,summary.quoted_price);
  near(verified.values.BY,summary.components_before_tax.misc);
  const wb=await buildWorkbook({quote,sections});
  const ws=wb.getWorksheet('报价明细'); let finalRow,taxRow;
  ws.eachRow(row=>{if(row.getCell(1).value==='TOTAL (USD)')finalRow=row.number;
    if(row.getCell(1).value==='一、出厂货价核')taxRow=row.number+2;});
  near(ws.getCell(finalRow,3).value.result,costs.detailPricing.quotedUsd);
  near(ws.getCell(taxRow,1).value.result,summary.quoted_price);
  p.sales.pricing_summary={surtax:-999,indo_freight:-999};
  near(calculateSingleQuoteCosts(quote,sectionsOf(p)).quotedPrice,summary.quoted_price);
});
test('单列车缝人工不参与运费，零附加税码点保持零',()=>{
  const p=payloads();p.sewing.sewing_groups[0].items.pop();p.sales.shipping.surtax_markup_x=0;
  const costs=calculateSingleQuoteCosts(quote,sectionsOf(p));
  near(costs.indoFreight,1);
  near(costs.detailPricing.quotedUsd,(12*1.2+15*1.2)/.98/7.8+.09+.1+.2+2);
});
