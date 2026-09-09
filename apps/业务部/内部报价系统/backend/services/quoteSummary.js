const ExcelJS = require('exceljs');
const { calculateQuoteCosts } = require('./quoteCostSummary');

const WORKSHOPS = [
  ['xingxin_a', '兴信A'],
  ['xingxin_b', '兴信B'],
  ['huadeng', '华登'],
  ['heyuan', '河源'],
];

const QUOTE_COMPONENTS = [
  ['injection_labor', '啤工', 't3'],
  ['assembly_labor', '装工', 't3'],
  ['painting_labor', '喷印工', 't3'],
  ['paint_material', '油漆', 't3'],
  ['imp_mat', '进口料', 't1'],
  ['dom_mat', '国内料', 't1'],
  ['blow', '吹气', 't1'],
  ['slush', '搪胶', 't1'],
  ['sewing_hair', '车发', 't1'],
  ['sewing_cloth', '车衣', 't1'],
  ['hardware', '五金', 't1'],
  ['electronic', '电子', 't1'],
  ['motor', '马达', 't1'],
  ['suction', '吸塑', 't1'],
  ['glue_bag', '胶袋', 't1'],
  ['color_box', '彩盒/内咭', 't2'],
  ['battery', '电池', 't2'],
  ['libao', '利宝', 't2'],
  ['plating', '电镀', 't2'],
  ['other_buy', '其他外购', 't2'],
  ['carton', '纸箱', 't2'],
  ['freight', '运费', 't2'],
  ['cabinet', '吊柜费', 't2'],
  ['misc', '杂项', 't2'],
];

// 与报价单“减税明细”保持同一口径。汇总页和汇总导出均展示减税后单价。
// 未列出的项目（人工、进口料、吹气、电子、吊柜费、杂项）不减税。
const TAX_DEDUCTION_RATES = Object.freeze({
  paint_material: 11.5,
  dom_mat: 11.5,
  slush: 3,
  sewing_hair: 11.5,
  sewing_cloth: 11.5,
  hardware: 11.5,
  motor: 11.5,
  suction: 6,
  glue_bag: 11.5,
  color_box: 11.5,
  battery: 11.5,
  libao: 11.5,
  plating: 0.99,
  other_buy: 11.5,
  carton: 11.5,
  freight: 8.26,
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseJson(raw, fallback = {}) {
  try { return JSON.parse(raw || '') || fallback; } catch { return fallback; }
}

function afterTaxComponents(components) {
  return Object.fromEntries(QUOTE_COMPONENTS.map(([key]) => {
    const rate = num(TAX_DEDUCTION_RATES[key]);
    return [key, +(num(components?.[key]) * (1 - rate / 100)).toFixed(6)];
  }));
}

function buildQuoteSummary(quote, sections) {
  const salesSection = (sections || []).find(section => section.dept === 'sales');
  const sales = parseJson(salesSection && salesSection.payload_json);
  const pricing = sales?.pricing_summary || {};
  const calculated = calculateQuoteCosts(quote, sections);
  const beforeTaxComponents = Object.fromEntries(QUOTE_COMPONENTS.map(([key, , table]) => {
    const liveValue = calculated.components[key];
    return [key, calculated.hasSourceData ? num(liveValue) : num(pricing[table]?.[key])];
  }));
  const components = afterTaxComponents(beforeTaxComponents);
  return {
    id: quote.id,
    quote_no: quote.quote_no,
    product_name: quote.product_name,
    customer: quote.customer || '',
    qty: num(quote.qty),
    version: quote.version || '',
    created_at: quote.created_at,
    quote_status: quote.status,
    quoted_price: calculated.hasSourceData ? num(calculated.quotedPrice) : num(pricing.t1?.base_price),
    components,
    component_basis: 'after_tax',
  };
}

function buildSummaryWorkbook(rows, filters = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '内部报价系统';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;
  wb.calcProperties.forceFullCalc = true;
  wb.calcProperties.calcMode = 'auto';
  const ws = wb.addWorksheet('各客报价汇总', {
    views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
  });
  ws.pageSetup = {
    orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 },
  };
  ws.headerFooter = {
    oddHeader: '&C&B各客报价汇总',
    oddFooter: '&L内部报价系统&C第 &P 页 / 共 &N 页&R&D',
  };
  const baseHeaders = ['客名', '货号', '货品名称', '报价日期', '实际接单数量', '货价 (HK$)'];
  const workflowHeaders = ['客价确认', '实际生产车间', '确认人', '确认时间', '备注'];
  const totalColumns = baseHeaders.length + QUOTE_COMPONENTS.length * 3 + workflowHeaders.length;
  ws.getCell(1, 1).value = `${new Date().getFullYear()}年`;
  ws.getCell(1, 1).font = { bold: true, size: 14, name: 'Microsoft YaHei' };
  ws.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(1, 2, 1, totalColumns);
  ws.getCell(1, 2).value = '各客产品报价汇总表';
  ws.getCell(1, 2).font = { bold: true, size: 16, name: 'Microsoft YaHei' };
  ws.getCell(1, 2).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(1).height = 28;
  ws.mergeCells(2, 1, 2, totalColumns);
  ws.getCell(2, 1).value = `客户：${filters.customer || '全部'}    导出日期：${new Date().toLocaleDateString('zh-CN')}`;
  ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF52647A' }, name: 'Microsoft YaHei' };
  ws.getCell(2, 1).alignment = { horizontal: 'left' };
  const headerStyle = (cell, fill = 'FFFFFFFF') => {
    cell.font = { bold: true, color: { argb: 'FF153A5B' }, name: 'Microsoft YaHei' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF94A3B8' } }, left: { style: 'thin', color: { argb: 'FF94A3B8' } },
      bottom: { style: 'thin', color: { argb: 'FF94A3B8' } }, right: { style: 'thin', color: { argb: 'FF94A3B8' } },
    };
  };
  let column = 1;
  baseHeaders.forEach(header => {
    ws.getCell(4, column).value = header;
    headerStyle(ws.getCell(4, column));
    column += 1;
  });
  QUOTE_COMPONENTS.forEach(([, label], componentIndex) => {
    const fill = componentIndex % 2 ? 'FFEAF0F8' : 'FFD9E2F3';
    [`${label}减税后单价`, `${label}减税后金额`, `${label}占货价`].forEach((header, offset) => {
      ws.getCell(4, column + offset).value = header;
      headerStyle(ws.getCell(4, column + offset), offset ? fill : 'FFFFFFFF');
    });
    column += 3;
  });
  workflowHeaders.forEach(header => {
    ws.getCell(4, column).value = header;
    headerStyle(ws.getCell(4, column), 'FFFFF2CC');
    column += 1;
  });
  ws.getRow(4).height = 42;
  rows.forEach((row, index) => {
    const targetRow = index + 5;
    const confirmation = row.confirmation || {};
    const workshopNames = (confirmation.workshops || []).map(code => {
      const match = WORKSHOPS.find(item => item[0] === code);
      return match ? match[1] : code;
    }).join('、');
    const qty = confirmation.confirmed_qty ?? row.qty;
    const price = confirmation.confirmed_price ?? row.quoted_price;
    const componentValues = QUOTE_COMPONENTS.flatMap(([key]) => {
      const unitPrice = num(row.components?.[key]);
      return [unitPrice, unitPrice * num(qty), price ? unitPrice / price : 0];
    });
    const values = [
      row.customer, row.quote_no, row.product_name,
      row.created_at ? new Date(row.created_at) : '',
      qty, price,
      ...componentValues,
      confirmation.status === 'confirmed' ? '已确认' : '待确认',
      workshopNames, confirmation.confirmed_by || '',
      confirmation.confirmed_at ? new Date(confirmation.confirmed_at) : '',
      confirmation.note || '',
    ];
    values.forEach((value, columnIndex) => {
      const cell = ws.getCell(targetRow, columnIndex + 1);
      cell.value = value;
      cell.font = { name: 'Microsoft YaHei', size: 10 };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 ? 'FFF7FAFC' : 'FFFFFFFF' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD8E2EA' } } };
    });
    ws.getCell(targetRow, 4).numFmt = 'yyyy-mm-dd';
    ws.getCell(targetRow, 5).numFmt = '#,##0';
    ws.getCell(targetRow, 6).numFmt = '#,##0.0000';
    QUOTE_COMPONENTS.forEach((_, componentIndex) => {
      const startColumn = 7 + componentIndex * 3;
      const unitCell = ws.getCell(targetRow, startColumn);
      const amountCell = ws.getCell(targetRow, startColumn + 1);
      const shareCell = ws.getCell(targetRow, startColumn + 2);
      const unitPrice = num(row.components?.[QUOTE_COMPONENTS[componentIndex][0]]);
      unitCell.numFmt = '#,##0.0000';
      amountCell.value = {
        formula: `${unitCell.address}*$E${targetRow}`,
        result: unitPrice * num(qty),
      };
      amountCell.numFmt = '#,##0.00';
      shareCell.value = {
        formula: `IF($F${targetRow}=0,0,${unitCell.address}/$F${targetRow})`,
        result: price ? unitPrice / price : 0,
      };
      shareCell.numFmt = '0.00%';
    });
    ws.getCell(targetRow, totalColumns - 1).numFmt = 'yyyy-mm-dd hh:mm';
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, rows.length + 4), column: totalColumns } };
  [18, 16, 24, 14, 18, 15].forEach((width, index) => { ws.getColumn(index + 1).width = width; });
  QUOTE_COMPONENTS.forEach((_, componentIndex) => {
    const startColumn = 7 + componentIndex * 3;
    ws.getColumn(startColumn).width = 11;
    ws.getColumn(startColumn + 1).width = 14;
    ws.getColumn(startColumn + 2).width = 11;
  });
  [13, 18, 14, 19, 26].forEach((width, index) => { ws.getColumn(7 + QUOTE_COMPONENTS.length * 3 + index).width = width; });
  return wb;
}

module.exports = {
  WORKSHOPS, QUOTE_COMPONENTS, TAX_DEDUCTION_RATES,
  afterTaxComponents, buildQuoteSummary, buildSummaryWorkbook, parseJson,
};
