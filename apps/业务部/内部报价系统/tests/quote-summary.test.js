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
