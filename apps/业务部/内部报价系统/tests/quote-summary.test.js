const test = require('node:test');
const assert = require('node:assert/strict');
const { QUOTE_COMPONENTS, buildQuoteSummary, buildSummaryWorkbook } = require('../backend/services/quoteSummary');

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
  assert.equal(result.components.dom_mat, 2);
  assert.equal(result.components.injection_labor, 1);
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
  assert.equal(result.components.dom_mat, 2);
  assert.equal(result.components.injection_labor, 3);
  assert.equal(result.components.electronic, 1);
  assert.equal(result.components.motor, 2);
  assert.equal(result.components.hardware, 0);
  assert.equal(result.components.freight, 4.8);
  assert.equal(result.components.cabinet, 5.2);
  assert.equal(result.quoted_price, 21.6);
});

test('导出表横向展开报价项目并保留客户确认和实际生产车间', async () => {
  const row = {
    id: 1, customer: 'Sky Castle', quote_no: 'SC-1', product_name: '产品', version: 'V1', qty: 100,
    quoted_price: 10, created_at: '2026-09-08T09:00:00Z',
    components: { injection_labor: 1.5, dom_mat: 2 },
    confirmation: { status: 'confirmed', workshops: ['xingxin_a'], confirmed_price: 10, confirmed_qty: 100, note: '已确认' },
  };
  const workbook = buildSummaryWorkbook([row], { customer: 'Sky Castle' });
  const sheet = workbook.getWorksheet('各客报价汇总');
  const workflowStart = 7 + QUOTE_COMPONENTS.length * 3;
  assert.equal(sheet.getCell(5, 1).value, 'Sky Castle');
  assert.equal(sheet.getCell(5, 7).value, 1.5);
  assert.deepEqual(sheet.getCell(5, 8).value, { formula: 'G5*$E5', result: 150 });
  assert.deepEqual(sheet.getCell(5, 9).value, { formula: 'IF($F5=0,0,G5/$F5)', result: 0.15 });
  assert.equal(sheet.getCell(5, workflowStart).value, '已确认');
  assert.equal(sheet.getCell(5, workflowStart + 1).value, '兴信A');
  assert.equal(sheet.getCell(5, 6).value, 10);
  const buffer = await workbook.xlsx.writeBuffer();
  assert.ok(buffer.byteLength > 1000);
  const reopened = new (require('exceljs').Workbook)();
  await reopened.xlsx.load(buffer);
  assert.equal(reopened.getWorksheet('各客报价汇总').getCell('H5').value.formula, 'G5*$E5');
  assert.equal(reopened.getWorksheet('各客报价汇总').getCell('I5').value.formula, 'IF($F5=0,0,G5/$F5)');
});
