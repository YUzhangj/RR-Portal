'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSewingTemplateWorkbook } = require('../backend/services/exportSewingTemplate');

test('sewing department export follows the two-sheet ZURU quotation template', async () => {
  const workbook = await buildSewingTemplateWorkbook({
    quote: {
      quote_no: '9577', product_name: '摇摆水豚鼠', customer: 'ZURU',
      created_by_name: '刘锦龙', created_at: '2026-07-24 09:30:00',
    },
    sections: [{
      dept: 'sewing', reviewed_by: '小龙', payload_json: JSON.stringify({
        sewing_groups: [{
          name: '摇摆水豚鼠', product_qty: 1,
          items: [
            { fabric: '棕色长短云貂绒', part: '身', usage: 0.12, mat_price: 21.297, markup: 1.05 },
            { fabric: '人工', usage: 1, mat_price: 6, markup: 1.05 },
          ],
        }],
      }),
    }],
  });

  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['报价单', '明细表']);
  const quoteSheet = workbook.getWorksheet('报价单');
  const detailSheet = workbook.getWorksheet('明细表');
  assert.equal(quoteSheet.getCell('A1').value, '东莞市华信兴服装有限公司');
  assert.equal(quoteSheet.getCell('A6').value, '报价单');
  assert.equal(quoteSheet.getCell('B10').value, '9577');
  assert.equal(quoteSheet.getCell('D10').value.formula, "'明细表'!I7");
  assert.equal(quoteSheet.getCell('E10').value.formula, 'D10*1.1');
  assert.equal(detailSheet.getCell('A1').value, '摇摆水豚鼠-明细表');
  assert.equal(detailSheet.getCell('A3').value, '图片');
  assert.equal(detailSheet.getCell('J3').value, '布料');
  assert.equal(detailSheet.getCell('J4').value, 'MOQ');
  assert.equal(detailSheet.getCell('G5').value.formula, 'E5*F5');
  assert.equal(detailSheet.getCell('I5').value.formula, 'G5*H5');
  assert.equal(detailSheet.getCell('I7').value.formula, 'SUM(I5:I6)');
  assert.equal(detailSheet.pageSetup.printTitlesRow, '3:4');
  assert.equal(detailSheet.pageSetup.printArea, 'A1:K7');
});
