const test = require('node:test');
const assert = require('node:assert/strict');
const {
  QUOTE_COMPONENTS, TAX_DEDUCTION_RATES, buildQuoteSummary, buildSummaryWorkbook,
} = require('../backend/services/quoteSummary');

test('报价汇总读取报价基本资料和客价', () => {
  const quote = { id: 9, quote_no: 'A-100', product_name: '测试产品', customer: 'ZURU', qty: 5000, status: 'fully_approved' };
  const sections = [
    { dept: 'sales', status: 'approved', payload_json: JSON.stringify({ pricing_summary: {
      t1: { base_price: 20, dom_mat: 2, electronic: 1, slush: 0.5 },
      t2: { color_box: 1, carton: 0.5 },
      t3: { injection_labor: 1, painting_labor: 0.7, paint_material: 0.3, assembly_labor: 2, no_labor_cost: 8, total_cost: 10 },
      t4: { carton: { amt: 0.5, rate: 13 }, slush3: { amt: 0.5, rate: 3 } },
    } }) },
    { dept: 'molding', status: 'approved', payload_json: '{}' },
    { dept: 'painting', status: 'approved', payload_json: '{}' },
    { dept: 'assembly', status: 'approved', payload_json: '{}' },
  ];
  const result = buildQuoteSummary(quote, sections);
  assert.equal(result.quoted_price, 20);
  assert.equal(result.customer, 'ZURU');
  assert.equal(result.qty, 5000);
  assert.equal(result.components.dom_mat, 1.77);
  assert.equal(result.components.injection_labor, 1);
  assert.equal(result.components_before_tax.dom_mat, 2);
  assert.equal(result.components_before_tax.injection_labor, 1);
  assert.equal(result.component_basis, 'after_tax');
});

test('报价汇总直接统计各部门明细，不依赖业务部历史快照', () => {
  const quote = { id: 10, quote_no: 'LIVE-100', product_name: '历史报价', customer: 'TOMY', qty: 5000, factory_code: 'qingxi' };
  const sections = [
    { dept: 'sales', payload_json: JSON.stringify({
      header: { fx_rmb_hkd: 0.85, fx_hkd_usd: 7.8 },
      shipping: { markup_x: 1.2, freight_pct: 48, lifting_pct: 52, scenarios: [{ name: '盐田40柜', _freight_rate: 10 }] },
    }) },
    { dept: 'molding', payload_json: JSON.stringify({
      injection: [{ material: 'PVC', weight_g: 2, material_unit_price: 1, shot_price: 3 }],
      injection_loss_pct: 0,
    }) },
    { dept: 'electronic', payload_json: JSON.stringify({ electronics: [{ name: '主控IC', qty: 1, unit_price_rmb: 0.85 }] }) },
    { dept: 'engineering', payload_json: JSON.stringify({ hardware: [{ name: '马达', qty: 1, unit_price_rmb: 1.7 }] }) },
  ];
  const result = buildQuoteSummary(quote, sections);
  assert.equal(result.components.dom_mat, 1.77);
  assert.equal(result.components.injection_labor, 3);
  assert.equal(result.components.electronic, 1);
  assert.equal(result.components.motor, 1.77);
  assert.equal(result.components.hardware, 0);
  assert.equal(result.components.freight, 4.40352);
  assert.equal(result.components.cabinet, 5.2);
  assert.equal(result.quoted_price, 21.6);
});

test('报价汇总按减税明细口径计算各项减税后单价', () => {
  const quote = { id: 11, quote_no: 'TAX-100', product_name: '减税测试', customer: 'TOMY', qty: 100 };
  const sections = [{
    dept: 'sales', payload_json: JSON.stringify({ pricing_summary: {
      t1: { base_price: 30, imp_mat: 10, dom_mat: 10, slush: 10, sewing_hair: 10, electronic: 10, suction: 10 },
      t2: { color_box: 10, plating: 10, carton: 10, freight: 10, cabinet: 10, misc: 10 },
      t3: { injection_labor: 10, paint_material: 10 },
    } }),
  }];
  const result = buildQuoteSummary(quote, sections);
  assert.equal(TAX_DEDUCTION_RATES.dom_mat, 11.5);
  assert.equal(result.components.imp_mat, 10);
  assert.equal(result.components.dom_mat, 8.85);
  assert.equal(result.components.injection_labor, 10);
  assert.equal(result.components.paint_material, 8.85);
  assert.equal(result.components.slush, 9.7);
  assert.equal(result.components.sewing_hair, 8.85);
  assert.equal(result.components.electronic, 10);
  assert.equal(result.components.suction, 9.4);
  assert.equal(result.components.color_box, 8.85);
  assert.equal(result.components.plating, 9.901);
  assert.equal(result.components.carton, 8.85);
  assert.equal(result.components.freight, 9.174);
  assert.equal(result.components.cabinet, 10);
  assert.equal(result.components.misc, 10);
});

test('导出表横向展开报价项目并保留客户确认和实际生产车间', async () => {
  const row = {
    id: 1, customer: 'Sky Castle', quote_no: 'SC-1', product_name: '产品', version: 'V1', qty: 100,
    quoted_price: 10, created_at: '2026-09-08T09:00:00Z',
    components_before_tax: { injection_labor: 1.5, dom_mat: 2 },
    components: { injection_labor: 1.5, dom_mat: 1.77 },
    confirmation: { status: 'confirmed', workshops: ['xingxin_a'], confirmed_price: 10, confirmed_qty: 100, note: '已确认' },
  };
  const workbook = buildSummaryWorkbook([row], { customer: 'Sky Castle' });
  const sheet = workbook.getWorksheet('各客报价汇总');
  const workflowStart = 7 + QUOTE_COMPONENTS.length * 4;
  assert.equal(sheet.getCell(5, 1).value, 'Sky Castle');
  assert.equal(sheet.getCell(4, 7).value, '啤工');
  assert.equal(sheet.getCell(4, 8).value, '退税后啤工');
  assert.equal(sheet.getCell(4, 9).value, '啤工金额');
  assert.equal(sheet.getCell(4, 10).value, '啤工占比');
  assert.equal(sheet.getCell(5, 7).value, 1.5);
  assert.deepEqual(sheet.getCell(5, 8).value, { formula: 'G5', result: 1.5 });
  assert.deepEqual(sheet.getCell(5, 9).value, { formula: 'H5*$E5', result: 150 });
  assert.equal(sheet.getCell(5, 10).value.formula, 'IF($F5=0,0,H5/$F5)');
  assert.ok(Math.abs(sheet.getCell(5, 10).value.result - 0.15) < 1e-12);
  assert.equal(sheet.getCell(5, 28).value.formula, 'AA5*(1-11.5%)');
  assert.equal(sheet.getCell(5, 29).value.formula, 'AB5*$E5');
  assert.equal(sheet.getCell(5, workflowStart).value, '已确认');
  assert.equal(sheet.getCell(5, workflowStart + 1).value, '兴信A');
  assert.equal(sheet.getCell(5, 6).value, 10);
  const buffer = await workbook.xlsx.writeBuffer();
  assert.ok(buffer.byteLength > 1000);
  const reopened = new (require('exceljs').Workbook)();
  await reopened.xlsx.load(buffer);
  assert.equal(reopened.getWorksheet('各客报价汇总').getCell('H5').value.formula, 'G5');
  assert.equal(reopened.getWorksheet('各客报价汇总').getCell('I5').value.formula, 'H5*$E5');
  assert.equal(reopened.getWorksheet('各客报价汇总').getCell('J5').value.formula, 'IF($F5=0,0,H5/$F5)');
});
