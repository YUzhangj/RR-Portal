const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {DEFAULT_COSTING_BASIS} = require('../backend/services/costingBasis');
const {upgradeLegacySectionsForCalculation, calculateLegacyFormulaCosts} = require('../backend/services/legacyFormula');
const {buildQuoteSummary} = require('../backend/services/quoteSummary');
const {buildVerificationRow, buildVerificationWorkbook} = require('../backend/services/verificationSummary');
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-9, `${a} != ${b}`);
const quote = {id:1,quote_no:'LIVE',customer:'TOMY',qty:100,factory_code:'qingxi'};
const sectionsOf = p => Object.entries(p).map(([dept,payload])=>({dept,payload_json:JSON.stringify(payload)}));

function pageComponents(payloads) {
  const source = fs.readFileSync(path.join(__dirname,'../frontend/workbench.js'),'utf8');
  const context = vm.createContext({num:v=>Number(v)||0,window:{__data:{sections:sectionsOf(payloads)}},globalCostingBasis:()=>DEFAULT_COSTING_BASIS,defaultAssemblyBaseRateForFactory:()=>310});
  vm.runInContext(source.slice(source.indexOf('function legacyFormulaAmount('),source.indexOf('function renderLegacyItems(')),context);
  vm.runInContext(source.slice(source.indexOf('function legacyFormulaComponents('),source.indexOf('// ============== 汇总面板')),context);
  return context.legacyFormulaComponents(structuredClone(payloads));
}

test('edited historical itemized formulas drive report components, price and saved workbook', async()=>{
  const prepared=upgradeLegacySectionsForCalculation([
    {dept:'sales',payload:{header:{fx_rmb_hkd:.87},pricing_summary:{t1:{base_price:12},t2:{other_buy:6},t3:{}},legacy_import:{summary_only:true,source_cost_including_labor:6}}},
    {dept:'engineering',payload:{legacy_items:[{name:'外购配件',quantity:2,current_hkd:6}]}}
  ],DEFAULT_COSTING_BASIS);
  const payloads=Object.fromEntries(prepared.map(s=>[s.dept,s.payload]));
  payloads.engineering.legacy_items[0].formula_unit_hkd=4;
  const before=JSON.stringify(payloads),sections=sectionsOf(payloads),summary=buildQuoteSummary(quote,sections);
  near(summary.components_before_tax.other_buy,8);near(summary.quoted_price,16);
  near(summary.summary_values.cost_with_labor,8);near(summary.summary_values.rebate_reduction,8*.115);
  const row=buildVerificationRow(quote,{id:1,status:'drafting'},sections,[]);
  near(row.values.BU,8);near(row.values.E,16);near(row.values.F,8);
  const workbook=buildVerificationWorkbook([row]);
  const customer=workbook.getWorksheet('TOMY');near(customer.getCell('BU5').value,8);near(customer.getCell('E5').value,16);
  const loaded=new(require('exceljs').Workbook)();await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
  near(loaded.getWorksheet('TOMY').getCell('BU5').value,8);
  assert.equal(JSON.stringify(payloads),before,'calculating never rewrites legacy source values or offsets');
});

test('backend matches page formula parameters, exchange, live injection and balancing offsets without abs double counting',()=>{
  const payloads={
    sales:{header:{fx_rmb_hkd:.9},legacy_import:{formula_mode:'itemized_v1',formula_markup_x:1.23456,formula_offsets:{imp_mat:2,misc:-.6,abs_cost:3}}},
    molding:{injection_loss_pct:3,injection:[{material:'ABS',weight_g:2.5,material_unit_price:.025,shot_price:.1234567},{material:'PVC',weight_g:3,material_unit_price:.015,shot_price:.02}],legacy_items:[{include_in_summary:false,current_hkd:999}]},
    engineering:{legacy_items:[{cost_category:'other_buy',include_in_summary:true,formula_kind:'quantity_x_unit',formula_quantity:2.3,formula_unit_hkd:.1234567,current_hkd:999},{cost_category:'hardware',include_in_summary:true,formula_kind:'rmb_divided_by_fx',formula_rmb_value:.135,current_hkd:999}]},
    assembly:{assembly_base_rate:325,legacy_items:[{cost_category:'assembly_labor',include_in_summary:true,formula_kind:'assembly_base_per_output',people:2,team:3,output:1234,current_hkd:999}]},
  };
  const expected=pageComponents(payloads),before=JSON.stringify(payloads),actual=calculateLegacyFormulaCosts(quote,payloads);
  for(const [key,value] of Object.entries(expected))near(actual.components[key],value);
  const total=Object.entries(expected).filter(([k])=>k!=='abs_cost').reduce((s,[,v])=>s+v,0);
  near(actual.quotedPrice,total*1.23456);near(actual.components.abs_material,expected.abs_cost);
  const row=buildVerificationRow(quote,{id:1,status:'drafting'},sectionsOf(payloads),[]);
  near(row.values.F,total);near(row.values.E,total*1.23456);near(row.values.L,325*2*3/1234);
  assert.equal(JSON.stringify(payloads),before);
});

test('source-only and native Excel historical calculations are never converted by the itemized calculator',()=>{
  assert.equal(calculateLegacyFormulaCosts(quote,{sales:{legacy_import:{summary_only:true}}}),null);
  assert.equal(calculateLegacyFormulaCosts(quote,{sales:{legacy_import:{formula_mode:'excel_native_v1',excel_model:{}}}}),null);
  assert.equal(calculateLegacyFormulaCosts(quote,{sales:{legacy_import:{formula_mode:'itemized_v1',excel_model:{}}}}),null);
});
