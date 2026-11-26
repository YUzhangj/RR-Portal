'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildOutputWorkbook } = require('../backend/services/nexusOutputTemplate');
const { serializeWorkbook } = require('../backend/services/workbookPreview');

test('最终导出默认打开报价明细并隐藏旧系统汇总', async () => {
  const args = {
    quote: { quote_no: 'NEXUS-1', product_name: '双层巴士', customer: 'ToyMonster', qty: 1000 },
    sections: [
      {
        dept: 'molding',
        payload_json: JSON.stringify({
        injection_loss_pct: 3,
        material_prices: [{ name: 'ABS', model: '750SW', price: 6.5 }],
        machine_prices: [{ model: '14A-16A', normal: '150T', price: 1490 }],
        injection: [{
          mold_no: '01M', name: '车底', material: 'ABS', material_grade: '750SW',
          weight_g: 32.96, material_unit_price: 0.0143, machine_model: '14A-16A',
          sets: 2, target: 3000, shot_price: 0.2483,
        }],
        }),
      },
      {
        dept: 'engineering',
        payload_json: JSON.stringify({
          hardware: [{ name: '螺丝', qty: 2, unit_price_rmb: 0.1 }],
          packaging_materials: [{ name: '彩盒', category: '彩盒/内咭', qty: 1, unit_price_rmb: 2 }],
          carton_calc: {
            paper_rate: 2.75,
            cartons: [{ name: '主纸箱', cl: 18, cw: 12, ch: 10, qty: 12, flat_cards: [{ l: 18, w: 12, qty: 1 }] }],
          },
        }),
      },
      {
        dept: 'painting',
        payload_json: JSON.stringify({ painting_items: [{ name: '车身喷油', spray_qty: 1, spray_unit: 0.5 }] }),
      },
      {
        dept: 'electronic',
        payload_json: JSON.stringify({ electronics: [{ name: 'IC', qty: 1, unit_price_rmb: 1 }] }),
      },
      {
        dept: 'sales',
        payload_json: JSON.stringify({
          header: { fx_rmb_hkd: 0.85, fx_hkd_usd: 7.8 },
          shipping: {
            freight_pct: 48, lifting_pct: 52, markup_x: 1.2,
            scenarios: [{ name: '出厂价', is_factory: true }, { name: '盐田40柜', _freight_rate: 1 }],
          },
        }),
      },
    ],
  };
  const workbook = await buildOutputWorkbook(args);

  const systemSummary = workbook.getWorksheet('系统报价汇总');
  assert.ok(systemSummary);
  assert.equal(systemSummary.state, 'veryHidden');
  const sheet = workbook.getWorksheet('报价明细');
  assert.ok(sheet);
  const detailTabIndex = workbook.worksheets.findIndex(candidate => candidate.id === sheet.id);
  assert.equal(detailTabIndex, 0);
  assert.equal(workbook.worksheets[0].name, '报价明细');
  assert.equal(workbook.views[0].activeTab, detailTabIndex);
  assert.equal(workbook.views[0].firstSheet, detailTabIndex);
  const exportedBuffer = await workbook.xlsx.writeBuffer();
  const reopenedWorkbook = new ExcelJS.Workbook();
  await reopenedWorkbook.xlsx.load(exportedBuffer);
  assert.equal(reopenedWorkbook.getWorksheet('系统报价汇总').state, 'veryHidden');
  const reopenedDetailIndex = reopenedWorkbook.worksheets.findIndex(candidate => candidate.name === '报价明细');
  assert.equal(reopenedDetailIndex, 0);
  assert.equal(reopenedWorkbook.worksheets[0].name, '报价明细');
  assert.equal(reopenedWorkbook.views[0].activeTab, reopenedDetailIndex);
  assert.equal(reopenedWorkbook.views[0].firstSheet, reopenedDetailIndex);
  assert.equal(sheet.getCell('B1').value, '料型');
  assert.equal(sheet.getCell('C1').value, '750SW ABS');
  assert.equal(sheet.getCell('C2').value, 6.5);
  assert.equal(sheet.getCell('C3').value, 454);
  assert.equal(sheet.getCell('C4').formula, 'ROUND(C2/C3,4)');
  assert.equal(sheet.getCell('C4').result, 0.0143);
  assert.equal(sheet.getCell('B5').value, '机型');
  assert.equal(sheet.getCell('C5').value, '14A-16A');
  assert.equal(sheet.getCell('C6').value, 1490);
  assert.equal(sheet.getCell('B7').value, '汇率');
  assert.equal(sheet.getCell('C7').value, 0.85);
  assert.equal(sheet.getCell('D7').value, '主纸箱系数');
  assert.equal(sheet.getCell('E7').value, 2.75);
  assert.equal(sheet.getCell('F7').value, null);
  assert.equal(sheet.getCell('G7').value, null);
  assert.equal(sheet.getCell('J7').value, '料重损耗');
  assert.equal(sheet.getCell('K7').value, 0.03);
  assert.equal(sheet.getCell('K7').numFmt, '0%');
  assert.equal(sheet.getCell('H7').value, null);
  assert.equal(sheet.getCell('I7').value, null);
  assert.equal(sheet.getCell('A8').value, '双层巴士报价');
  assert.equal(sheet.getCell('A9').value, '双层巴士-明细');
  assert.equal(sheet.getCell('C10').value, '名称');
  assert.equal(sheet.getCell('C11').value, '车底');
  assert.equal(sheet.getCell('D11').value, 'ABS 750SW');
  assert.equal(sheet.getCell('F10').value, '含料损耗重量(G)');
  assert.equal(sheet.getCell('F11').formula, 'E11*(1+$K$7)');
  assert.equal(sheet.getCell('F11').result, 32.96 * 1.03);
  assert.equal(sheet.getCell('F11').numFmt, '0.000');
  assert.equal(sheet.getCell('G11').formula, 'C4');
  assert.equal(sheet.getCell('G11').result, 0.0143);
  assert.equal(sheet.getCell('K11').formula, 'ROUND(C6/J11/I11,4)');
  assert.equal(sheet.getCell('K11').result, 0.2483);
  assert.equal(sheet.getCell('L11').formula, 'F11*G11');
  assert.equal(sheet.getCell('M11').result, 0.2483 * 1.15);
  assert.equal(sheet.getCell('A17').value, '模具合计');
  assert.equal(sheet.getCell('C4').font.color.argb, 'FFFF00FF');
  assert.equal(sheet.getCell('A8').font.color.argb, 'FF0000FF');
  assert.equal(sheet.getCell('A8').border.top.style, 'medium');
  assert.equal(sheet.getCell('A9').fill.fgColor.argb, 'FFFFFF00');
  assert.equal(sheet.getCell('A9').font.color.argb, 'FF0000FF');
  assert.equal(sheet.getCell('C10').font.color.argb, 'FFFF0000');
  assert.equal(sheet.getCell('C11').font.name, '宋体');
  assert.equal(sheet.getCell('E11').font.name, 'Times New Roman');
  assert.equal(sheet.getCell('A17').font.color.argb, 'FF0000FF');
  assert.equal(sheet.getCell('E17').font.color.argb, 'FFFF0000');
  assert.equal(sheet.properties.showGridLines, true);

  const values = [];
  sheet.eachRow(row => row.eachCell(cell => {
    if (cell.value !== null && cell.value !== undefined && cell.value !== '') values.push(cell.value);
  }));
  assert.ok(values.includes('成本明细（外购、喷油、电子、包装及人工）'));
  let screwAmountCell;
  sheet.eachRow(row => {
    if (String(row.getCell(3).value || '').startsWith('螺丝 ')) screwAmountCell = row.getCell(4);
  });
  assert.ok(screwAmountCell, '五金明细应显示为独立项目');
  assert.deepEqual(screwAmountCell.outputCalculation, {
    kind: 'unit-quantity', quantity: 2, currency: 'RMB', unitPrice: 0.1,
    exchangeRate: 0.85, operator: 'divide', value: 2 * 0.1 / 0.85,
    unit: 'HKD/件', quantityLabel: '用量', unitPriceLabel: '单价（RMB）',
  });
  const previewCell = serializeWorkbook(workbook, {
    editableCells: workbook.outputEditState.editable,
    overriddenCells: workbook.outputEditState.overridden,
  }).find(candidate => candidate.name === '报价明细').cells.find(cell => cell.address === screwAmountCell.address);
  assert.equal(previewCell.calculation.quantity, 2);
  assert.equal(previewCell.calculation.unitPrice, 0.1);
  assert.ok(values.includes('进口料价'));
  assert.ok(values.includes('国内料价'));
  assert.ok(values.includes('外箱（主纸箱）'));
  assert.ok(values.includes('产品尺寸inch:'));
  assert.ok(values.includes('纸箱尺寸inch:'));
  assert.ok(values.includes('CU.FT:'));
  assert.ok(values.includes('箱价'));
  assert.ok(values.includes('箱价/件'));
  assert.ok(values.includes('（箱价+平卡）÷数量'));
  let cartonQuantityCell;
  let flatPriceCell;
  let flatUsageCell;
  let cuftCell;
  let cartonPriceCell;
  let unitCartonPriceCell;
  sheet.eachRow(row => row.eachCell(cell => {
    if (cell.value && cell.value.formula && /^\(K\d+\+1\)/.test(cell.value.formula)) flatPriceCell = cell;
    if (cell.numFmt === '"数量: "0.###') cartonQuantityCell = cell;
    if (cell.numFmt === '"用量: "0.###') flatUsageCell = cell;
    if (cell.value === 'CU.FT:') cuftCell = sheet.getCell(cell.row, cell.col + 1);
    if (cell.value === '箱价') cartonPriceCell = sheet.getCell(cell.row, cell.col + 1);
    if (cell.value === '箱价/件') unitCartonPriceCell = sheet.getCell(cell.row, cell.col + 1);
  }));
  assert.equal(cuftCell.col, 11, '纸箱计算应放在 J:N，并与成本明细间隔 E:I 五列');
  assert.match(cuftCell.value.formula, /^K\d+\*L\d+\*M\d+\/1728$/);
  assert.match(cartonPriceCell.value.formula, /^\(K\d+\+L\d+\+2\)\*\(L\d+\+M\d+\+1\)\*2\*\$E\$7\/1000$/);
  assert.match(flatPriceCell.value.formula, /^\(K\d+\+1\)\*\(L\d+\+1\)\*2\/1000\*N\d+$/);
  assert.match(unitCartonPriceCell.value.formula, /^\(M\d+\+SUM\(M\d+:M\d+\)\)\/N\d+$/);
  assert.equal(cartonQuantityCell.value, 12);
  assert.equal(flatUsageCell.value, 1);
  assert.equal(cartonQuantityCell.alignment.horizontal, 'center');
  assert.equal(flatPriceCell.value.result, 0.494);
  assert.equal(flatPriceCell.numFmt, '0.0000');
  assert.equal(flatPriceCell.font.color.argb, 'FF0000FF');
  assert.equal(flatUsageCell.font.color.argb, 'FF0000FF');
  assert.equal(values.includes('纸价系数'), false);
  assert.equal(values.includes('功能介绍：'), false);
  assert.ok(values.includes('运输方案'));
  assert.equal(values.includes('柜/车容量（CUFT）'), false);
  assert.equal(values.includes('装柜箱数'), false);
  assert.equal(values.includes('整柜/车运费（HKD）'), false);
  assert.equal(values.includes('整柜/车吊柜费（HKD）'), false);
  assert.ok(values.includes('运费计算(HK$)'));
  assert.ok(values.includes('1箱的CUFT：'));
  assert.ok(values.includes('1箱装的个数：'));
  assert.ok(values.includes('总箱数'));
  assert.ok(values.includes('运+吊柜/件'));
  let shippingRow;
  let freightPanelRow;
  let cuftParameterRow;
  let quantityParameterRow;
  let firstFreightGroupRow;
  sheet.eachRow(row => {
    if (row.getCell(2).value === '运输方案') shippingRow = row.number;
    if (row.getCell(2).value === '运费计算(HK$)') freightPanelRow = row.number;
    if (row.getCell(2).value === '1箱的CUFT：') cuftParameterRow = row.number;
    if (row.getCell(2).value === '1箱装的个数：') quantityParameterRow = row.number;
    if (row.getCell(2).value === 'HK40柜') firstFreightGroupRow = row.number;
  });
  assert.ok(shippingRow < freightPanelRow);
  assert.equal(sheet.getCell(`D${shippingRow}`).value, '出厂价');
  assert.equal(sheet.getCell(`E${shippingRow}`).value, '盐田40柜');
  assert.equal(sheet.getCell(`F${shippingRow}`).value, null);
  assert.equal(sheet.getCell(`B${shippingRow + 1}`).value, '运费');
  assert.equal(sheet.getCell(`B${shippingRow + 2}`).value, '吊柜费');
  assert.equal(sheet.getCell(`B${shippingRow + 3}`).value, '报价基数');
  assert.equal(sheet.getCell(`C${cuftParameterRow}`).formula, cuftCell.address);
  assert.equal(sheet.getCell(`C${quantityParameterRow}`).formula, cartonQuantityCell.address);
  assert.equal(workbook.outputEditState.editable.has(`报价明细!C${cuftParameterRow + 2}`), true,
    '10吨车容量参数应可修改并联动业务部运费计算');
  assert.equal(workbook.outputEditState.editable.has(`报价明细!C${cuftParameterRow + 6}`), true,
    'HK 40柜费用参数应可修改并联动业务部运费计算');
  const yt40RateCell = `D${firstFreightGroupRow + 2}`;
  assert.match(sheet.getCell(yt40RateCell).formula,
    new RegExp(`^C\\d+/D${firstFreightGroupRow + 1}/MAX\\(C${quantityParameterRow},1\\)$`));
  assert.equal(sheet.getCell(`E${shippingRow + 1}`).formula, `${yt40RateCell}*48%`);
  assert.equal(sheet.getCell(`E${shippingRow + 2}`).formula, `${yt40RateCell}*52%`);
  assert.ok(values.includes('报价（MOQ3K）'));
  assert.equal(values.includes('报价（MOQ5K）'), false);
  assert.equal(values.includes('报价（MOQ10K）'), false);
  assert.equal(values.includes('测试费用'), false);
  assert.equal(values.includes('包含测试费用（USD）'), false);
  assert.ok(values.includes('车身喷油') === false);
  assert.ok(values.includes('一、出厂货价核'));
  assert.ok(values.includes('二、包装 / 外购'));
  assert.ok(values.includes('三、人工 & 成本汇总'));
  assert.ok(values.includes('四、减税明细'));
  assert.ok(values.includes('减税后结果'));
  assert.ok(values.includes('螺丝 (2pcs)'));
  assert.ok(values.includes('IC (1pcs)'));
  assert.ok(values.includes('彩盒 (1pcs)'));
  assert.ok(values.includes('进口料'));
  assert.ok(values.includes('国内料'));
  assert.ok(values.includes('胶袋'));
  assert.ok(values.includes('植绒'));
  assert.ok(values.includes('合计减税'));
  assert.ok(values.includes('减税后成本'));
  assert.ok(values.includes('十、合计') === false);

  const withTestingArgs = JSON.parse(JSON.stringify(args));
  const engineeringSection = withTestingArgs.sections.find(section => section.dept === 'engineering');
  const engineeringPayload = JSON.parse(engineeringSection.payload_json);
  engineeringPayload.mold_costs = { testing_fee_usd: 300 };
  engineeringSection.payload_json = JSON.stringify(engineeringPayload);
  const withTestingWorkbook = await buildOutputWorkbook(withTestingArgs);
  const withTestingValues = [];
  withTestingWorkbook.getWorksheet('报价明细').eachRow(testingRow => testingRow.eachCell(cell => {
    if (cell.value !== null && cell.value !== undefined && cell.value !== '') withTestingValues.push(cell.value);
  }));
  assert.ok(withTestingValues.includes('测试费用'));
  assert.ok(withTestingValues.includes('包含测试费用（USD）'));

  let firstSummaryRow;
  let secondSummaryRow;
  let thirdSummaryRow;
  let fourthSummaryRow;
  let fourthRateRow;
  let fourthDeductionRow;
  let fifthSummaryRow;
  sheet.eachRow(row => {
    if (row.getCell(3).value === '一、出厂货价核') firstSummaryRow = row.number + 1;
    if (row.getCell(3).value === '二、包装 / 外购') secondSummaryRow = row.number + 1;
    if (row.getCell(3).value === '三、人工 & 成本汇总') thirdSummaryRow = row.number + 1;
    if (row.getCell(3).value === '四、减税明细') {
      fourthSummaryRow = row.number + 1;
      fourthRateRow = row.number + 2;
      fourthDeductionRow = row.number + 3;
    }
    if (row.getCell(3).value === '减税后结果') fifthSummaryRow = row.number + 1;
  });
  let selectedQuoteRow;
  sheet.eachRow(row => {
    if (row.getCell(2).value === '报价（MOQ3K）') selectedQuoteRow = row.number;
  });
  assert.ok(selectedQuoteRow);
  assert.equal(sheet.getCell(`D${firstSummaryRow}`).formula, `D${selectedQuoteRow}`);
  assert.equal(sheet.getCell(`D${firstSummaryRow}`).result, sheet.getCell(`D${selectedQuoteRow}`).result);
  assert.doesNotMatch(sheet.getCell(`D${firstSummaryRow}`).formula, /系统报价汇总/);
  assert.equal(sheet.getCell(`E${secondSummaryRow}`).formula,
    `IFERROR(D${firstSummaryRow}/N${thirdSummaryRow},0)`);
  assert.equal(sheet.getCell(`F${secondSummaryRow}`).formula,
    `IFERROR(D${firstSummaryRow}/E${fifthSummaryRow},0)`);
  assert.equal(sheet.getCell(`I${thirdSummaryRow}`).formula,
    `IFERROR(SUM(D${thirdSummaryRow},E${thirdSummaryRow},G${thirdSummaryRow})/D${firstSummaryRow},0)`);
  assert.equal(sheet.getCell(`C${fourthSummaryRow}`).value, '减税基数');
  assert.equal(sheet.getCell(`C${fourthRateRow}`).value, '减税率');
  assert.equal(sheet.getCell(`C${fourthDeductionRow}`).value, '减税值');
  const yellowTax13Formula = `SUM(F${firstSummaryRow},K${firstSummaryRow},M${firstSummaryRow},O${firstSummaryRow},D${secondSummaryRow},G${secondSummaryRow},H${secondSummaryRow},J${secondSummaryRow},K${secondSummaryRow},F${thirdSummaryRow})`;
  assert.equal(sheet.getCell(`D${fourthSummaryRow}`).formula, yellowTax13Formula);
  assert.equal(sheet.getCell(`E${fourthSummaryRow}`).formula, `L${secondSummaryRow}`);
  assert.equal(sheet.getCell(`F${fourthSummaryRow}`).formula, `I${secondSummaryRow}`);
  assert.equal(sheet.getCell(`G${fourthSummaryRow}`).formula, `H${firstSummaryRow}`);
  assert.match(sheet.getCell(`H${fourthSummaryRow}`).formula, new RegExp(`^I${firstSummaryRow}\\*`));
  assert.match(sheet.getCell(`I${fourthSummaryRow}`).formula, new RegExp(`^J${firstSummaryRow}\\*`));
  assert.equal(sheet.getCell(`J${fourthSummaryRow}`).formula, `N${firstSummaryRow}`);
  assert.equal(sheet.getCell(`K${fourthSummaryRow}`).formula, `M${secondSummaryRow}`);
  assert.equal(sheet.getCell(`L${fourthSummaryRow}`).formula, yellowTax13Formula);
  assert.equal(sheet.getCell(`D${fourthRateRow}`).value, '—');
  assert.equal(sheet.getCell(`E${fourthRateRow}`).value, 0.115);
  assert.equal(sheet.getCell(`F${fourthRateRow}`).value, 0.0099);
  assert.equal(sheet.getCell(`K${fourthRateRow}`).value, 0.0826);
  assert.equal(sheet.getCell(`E${fourthDeductionRow}`).formula,
    `E${fourthSummaryRow}/1.1*E${fourthRateRow}`);
  assert.equal(sheet.getCell(`F${fourthDeductionRow}`).formula,
    `F${fourthSummaryRow}*F${fourthRateRow}`);
  assert.equal(sheet.getCell(`M${fourthDeductionRow}`).formula,
    `SUM(E${fourthDeductionRow}:L${fourthDeductionRow})`);
  const taxValue = column => Number(sheet.getCell(`${column}${fourthSummaryRow}`).result
    ?? sheet.getCell(`${column}${fourthSummaryRow}`).value ?? 0);
  const expectedTax = taxValue('F') * 0.0099 + taxValue('G') * 0.03
    + taxValue('H') * 0.115 + taxValue('I') * 0.115 + taxValue('J') * 0.06
    + taxValue('K') * 0.0826 + taxValue('L') * 0.115 + taxValue('E') / 1.1 * 0.115;
  assert.ok(Math.abs(sheet.getCell(`M${fourthDeductionRow}`).result - expectedTax) < 1e-9);
  assert.equal(sheet.getCell(`D${fifthSummaryRow}`).formula, `M${fourthDeductionRow}`);
  assert.equal(sheet.getCell(`E${fifthSummaryRow}`).formula, `N${thirdSummaryRow}-D${fifthSummaryRow}`);

  let cartonCostCell;
  let directCostTotalCell;
  let importedMaterialRow;
  let domesticMaterialRow;
  let injectionLaborRow;
  let screwRow;
  let electronicRow;
  let colorBoxRow;
  let indonesiaFreightRow;
  let surtaxRow;
  let costDetailHeaderRow;
  sheet.eachRow(row => {
    if (row.getCell(1).value === '税类' && row.getCell(2).value === '类别'
      && row.getCell(3).value === '项目') costDetailHeaderRow = row.number;
    if (row.getCell(3).value === '纸箱 / 平卡') cartonCostCell = row.getCell(4);
    if (row.getCell(1).value === '直接成本合计') directCostTotalCell = row.getCell(4);
    if (row.getCell(3).value === '进口料价') importedMaterialRow = row.number;
    if (row.getCell(3).value === '国内料价') domesticMaterialRow = row.number;
    if (row.getCell(3).value === '啤工') injectionLaborRow = row.number;
    if (row.getCell(3).value === '螺丝 (2pcs)') screwRow = row.number;
    if (row.getCell(3).value === 'IC (1pcs)') electronicRow = row.number;
    if (row.getCell(3).value === '彩盒 (1pcs)') colorBoxRow = row.number;
    if (row.getCell(3).value === '印尼运费') indonesiaFreightRow = row.number;
    if (row.getCell(3).value === '附加税 0.4%') surtaxRow = row.number;
  });
  assert.ok(importedMaterialRow < domesticMaterialRow);
  assert.ok(domesticMaterialRow < injectionLaborRow);
  assert.equal(sheet.getCell(`D${importedMaterialRow}`).formula, 'L11');
  assert.equal(sheet.getCell(`D${domesticMaterialRow}`).formula, '0');
  assert.equal(sheet.getCell(`D${injectionLaborRow}`).formula, 'K17');
  assert.ok(Math.abs(sheet.getCell(`D${screwRow}`).value - (2 * 0.1 / 0.85)) < 1e-9);
  assert.ok(Math.abs(sheet.getCell(`D${electronicRow}`).value - (1 / 0.85)) < 1e-9);
  assert.ok(Math.abs(sheet.getCell(`D${colorBoxRow}`).value - (2 / 0.85)) < 1e-9);
  assert.match(sheet.getCell(`K${firstSummaryRow}`).formula, new RegExp(`D${screwRow}`));
  assert.match(sheet.getCell(`L${firstSummaryRow}`).formula, new RegExp(`D${electronicRow}`));
  assert.match(sheet.getCell(`D${secondSummaryRow}`).formula, new RegExp(`D${colorBoxRow}`));
  assert.ok(cartonCostCell);
  assert.match(cartonCostCell.formula, /^K\d+$/);
  assert.equal(workbook.outputEditState.editable.has(`报价明细!${cartonCostCell.address}`), false);
  assert.match(directCostTotalCell.formula, /^SUM\(D\d+:D\d+\)$/);
  assert.ok(indonesiaFreightRow);
  assert.ok(surtaxRow);
  assert.equal(sheet.getCell(`B${indonesiaFreightRow}`).value, '印尼运费');
  assert.equal(sheet.getCell(`B${surtaxRow}`).value, '附加税');
  assert.equal(Number(sheet.getCell(`D${indonesiaFreightRow}`).result
    ?? sheet.getCell(`D${indonesiaFreightRow}`).value), 0);
  assert.ok(Number(sheet.getCell(`D${surtaxRow}`).result
    ?? sheet.getCell(`D${surtaxRow}`).value) > 0);
  assert.match(sheet.getCell(`D${indonesiaFreightRow}`).formula, /\$O\$7\/100/);
  assert.equal(sheet.getCell(`D${surtaxRow}`).formula, undefined);
  assert.equal(workbook.outputEditState.editable.has(`报价明细!D${indonesiaFreightRow}`), false);
  assert.equal(workbook.outputEditState.editable.has('报价明细!O7'), true);
  assert.equal(workbook.outputEditState.editable.has(`报价明细!D${surtaxRow}`), true);
  const systemSummaryReferences = [];
  sheet.eachRow(row => row.eachCell(cell => {
    if (String(cell.formula || '').includes('系统报价汇总')) systemSummaryReferences.push(cell.address);
  }));
  assert.deepEqual(systemSummaryReferences, []);
  assert.ok(costDetailHeaderRow);
  const directCostCategories = [];
  for (let row = costDetailHeaderRow + 1; row < directCostTotalCell.row; row += 1) {
    directCostCategories.push(sheet.getCell(`B${row}`).value);
  }
  assert.equal(directCostCategories.includes('运费'), false);
  assert.equal(directCostCategories.includes('吊柜费'), false);
  let shippingFreightRow;
  let shippingCabinetRow;
  for (let row = directCostTotalCell.row + 1; row <= sheet.rowCount; row += 1) {
    if (sheet.getCell(`B${row}`).value === '运费') shippingFreightRow = row;
    if (sheet.getCell(`B${row}`).value === '吊柜费') shippingCabinetRow = row;
    if (shippingFreightRow && shippingCabinetRow) break;
  }
  assert.ok(shippingFreightRow);
  assert.ok(shippingCabinetRow);

  let cartonLengthCell;
  sheet.eachRow(row => {
    if (row.getCell(10).value === '纸箱尺寸inch:') cartonLengthCell = row.getCell(11);
  });
  assert.ok(cartonLengthCell);
  assert.ok(workbook.outputEditState.editable.has(`报价明细!${cartonLengthCell.address}`));
  const overriddenWorkbook = await buildOutputWorkbook({
    ...args,
    overrides: [{
      sheet_name: '报价明细',
      cell_address: cartonLengthCell.address,
      value_json: JSON.stringify(require('../backend/services/outputWorkbookOverrides').boundOverride(workbook, '报价明细', cartonLengthCell.address, Number(cartonLengthCell.value) + 1, 'engineering')),
    }],
  });
  const changedSheet = overriddenWorkbook.getWorksheet('报价明细');
  const changedCarton = changedSheet.getCell(cartonCostCell.address).result;
  assert.ok(changedCarton > cartonCostCell.result);
  const totalRange = directCostTotalCell.formula.match(/^SUM\(D(\d+):D(\d+)\)$/);
  assert.ok(totalRange);
  let expectedDirectCost = 0;
  for (let row = Number(totalRange[1]); row <= Number(totalRange[2]); row += 1) {
    const cell = changedSheet.getCell(`D${row}`);
    expectedDirectCost += Number(cell.result ?? cell.value ?? 0);
  }
  const changedDirectCost = changedSheet.getCell(directCostTotalCell.address).result;
  assert.ok(Math.abs(changedDirectCost - expectedDirectCost) < 1e-9);
  let finalDirectCostCell;
  let finalProfitCell;
  let changedQuotedPriceCell;
  changedSheet.eachRow(row => {
    if (row.getCell(3).value === '一、出厂货价核') changedQuotedPriceCell = changedSheet.getCell(row.number + 1, 4);
    if (row.getCell(3).value === '三、人工 & 成本汇总') {
      finalDirectCostCell = changedSheet.getCell(row.number + 1, 14);
      finalProfitCell = changedSheet.getCell(row.number + 1, 12);
    }
  });
  assert.ok(Math.abs(finalDirectCostCell.result - changedDirectCost) < 1e-9);
  assert.equal(finalProfitCell.formula, `D${changedQuotedPriceCell.row}-N${finalProfitCell.row}`);
  assert.equal(finalProfitCell.result, finalProfitCell.value.result);
  const changedQuotedPrice = Number(changedQuotedPriceCell.result ?? changedQuotedPriceCell.value ?? 0);
  assert.ok(Math.abs(finalProfitCell.result - (
    changedQuotedPrice - finalDirectCostCell.result
  )) < 1e-9);
  assert.ok(overriddenWorkbook.outputEditState.overridden.has(`报价明细!${cartonLengthCell.address}`));
});

test('有内箱时保留实际使用的系数，修改后箱价仍联动', async () => {
  const args = {
    quote: { quote_no: 'INNER-BOX', product_name: '内箱系数', qty: 1000 },
    sections: [{ dept: 'engineering', payload_json: JSON.stringify({
      carton_calc: { cartons: [{ name: '内箱', cl: 10, cw: 8, ch: 6, qty: 4, paper_rate: 2.75 }] },
    }) }],
  };
  const workbook = await buildOutputWorkbook(args);
  const sheet = workbook.getWorksheet('报价明细');
  assert.equal(sheet.getCell('F7').value, '内纸箱系数');
  assert.equal(sheet.getCell('G7').value, 2.75);
  let priceCell;
  sheet.eachRow(row => row.eachCell(cell => {
    if (cell.formula?.includes('*$G$7/1000')) priceCell = cell;
  }));
  assert.ok(priceCell);
  const changed = await buildOutputWorkbook({ ...args, overrides: [{
    sheet_name: '报价明细', cell_address: 'G7', value_json: JSON.stringify(require('../backend/services/outputWorkbookOverrides').boundOverride(workbook, '报价明细', 'G7', 5.5, 'engineering')),
  }] });
  const nextPrice = changed.getWorksheet('报价明细').getCell(priceCell.address);
  assert.ok(Math.abs(nextPrice.result - priceCell.result * 2) < 0.0001);
});

test('报价MOQ取所选材料档位，5K也用于测试费用分摊', async () => {
  const args = { quote: { quote_no: 'MATERIAL-MOQ', qty: 3000 }, sections: [
    { dept: 'sales', payload_json: '{}' },
    { dept: 'engineering', payload_json: JSON.stringify({
      hardware: [{ name: '螺丝', qty: 1, unit_price: 1, moq_qty: 5000,
        price_tiers: [{ moq_qty: 3000 }, { moq_qty: 10000 }] }],
      aux_materials: [{ name: '胶圈', qty: 1, unit_price: 1, note: '单位：PCS；适用MOQ：5K；价格来源：人民币含税' }],
      mold_costs: { testing_fee_usd: 500 },
    }) },
  ] };
  const workbook = await buildOutputWorkbook(args);
  const sheet = workbook.getWorksheet('报价明细');
  const labels = [];
  let testingRow;
  sheet.eachRow(row => {
    if (/^报价（MOQ/.test(String(row.getCell(2).value))) labels.push(row.getCell(2).value);
    if (row.getCell(14).value === 5000) testingRow = row;
  });
  assert.deepEqual(labels, ['报价（MOQ5K）']);
  assert.ok(testingRow);
  assert.equal(testingRow.getCell(15).value, 0.1);
  const quote = sheet.getColumn(2).values.findIndex(value => value === '报价（MOQ5K）');
  assert.match(sheet.getCell(quote, 4).formula, /^D\d+\*D\d+\/D\d+$/);

  const explicit = structuredClone(args);
  explicit.sections[0].payload_json = JSON.stringify({ shipping: { moq_tiers: ['5K', { moq: '10K' }] } });
  const configured = (await buildOutputWorkbook(explicit)).getWorksheet('报价明细');
  const configuredLabels = [];
  configured.eachRow(row => {
    if (/^报价（MOQ/.test(String(row.getCell(2).value))) configuredLabels.push(row.getCell(2).value);
  });
  assert.deepEqual(configuredLabels, ['报价（MOQ5K）', '报价（MOQ10K）']);
});
