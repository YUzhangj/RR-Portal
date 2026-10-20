'use strict';

const path = require('node:path');
const XLSX = require('xlsx');
const { buildZuruPricingSummary } = require('./legacyVerificationImport');

const DEPARTMENTS = ['engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly'];
const text = value => String(value ?? '').trim();
const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const normalized = value => text(value).replace(/\s/g, '');
const address = (row, column) => XLSX.utils.encode_cell({ r: row - 1, c: column });

function departmentFor(label) {
  if (/料价|啤工/.test(label)) return 'molding';
  if (/喷油|喷印|移印|油漆|UV/.test(label)) return 'painting';
  if (/搪胶/.test(label)) return 'slush';
  if (/车缝|车衣|车发|布料/.test(label)) return 'sewing';
  if (/电子|PCB|PCBA|线路板|喇叭|马达/i.test(label)) return 'electronic';
  if (/装工|人工|拆查货|混装/.test(label)) return 'assembly';
  return 'engineering';
}

function parseZanzoonVerificationWorkbook(file, options = {}) {
  const workbook = XLSX.readFile(file, { cellFormula: true, cellDates: true });
  const summary = workbook.Sheets['总表'];
  const detail = workbook.Sheets['嘉苏核价'];
  if (!summary || !detail) throw new Error('Zanzoon 工作簿缺少“总表”或“嘉苏核价”');
  const sourceFile = options.sourceFile || path.basename(file);
  const sourceDate = options.sourceDate || '2026-07-01';
  const sourceCustomer = options.sourceCustomer || 'ZANZOON';
  const cell = (sheet, row, column) => sheet[address(row, column)] || {};
  const value = (sheet, row, column) => cell(sheet, row, column).v ?? null;
  const detailRows = Array.from({ length: 1926 }, (_, index) =>
    Array.from({ length: 29 }, (_, column) => value(detail, index + 1, column)));
  const header = Array.from({ length: 135 }, (_, column) => value(summary, 2, column));
  const analysis = detailRows.flatMap((row, index) => normalized(row[0]) === '货价(HK$)'
    && normalized(row[1]).startsWith('成本(含人工)') ? [index + 2] : []);
  const byPrice = new Map();
  for (const row of analysis) {
    const price = number(value(detail, row, 0));
    if (price != null) byPrice.set(price, [...(byPrice.get(price) || []), row]);
  }
  const candidates = [];
  const skipped = [];
  for (let row = 3; row <= 34; row += 1) {
    if (text(value(summary, row, 0)) !== sourceCustomer) continue;
    const originalSku = text(value(summary, row, 1));
    const productName = text(value(summary, row, 2));
    const price = number(value(summary, row, 5));
    const cost = number(value(summary, row, 6));
    const withoutLabor = number(value(summary, row, 7));
    if (!originalSku || price == null || price <= 0) {
      skipped.push({ row, originalSku, productName, reason: '缺少货号或有效价格' });
      continue;
    }
    if (price === 7 && cost === 7 && withoutLabor === 7) {
      skipped.push({ row, originalSku, productName, reason: '货价和两项成本均为占位值 7' });
      continue;
    }
    const matches = byPrice.get(price) || [];
    if (matches.length !== 1) throw new Error(`总表第 ${row} 行的货价 ${price} 无法唯一对应核价明细`);
    candidates.push({ row, originalSku, productName, qty: number(value(summary, row, 3)), price,
      cost, withoutLabor, detailRow: matches[0] });
  }
  const skuCounts = new Map();
  for (const item of candidates) skuCounts.set(item.originalSku, (skuCounts.get(item.originalSku) || 0) + 1);

  const materialPrices = detailRows[0].flatMap((name, column) => column && text(name) && number(detailRows[1][column]) != null
    ? [{ name: text(name), model: text(name), price: number(detailRows[1][column]) }] : []);
  const machinePrices = detailRows[5].flatMap((name, column) => column && text(name) && number(detailRows[6][column]) != null
    ? [{ model: text(name), normal: '', price: number(detailRows[6][column]) }] : []);

  const items = candidates.map(item => {
    const previous = analysis.filter(row => row < item.detailRow).at(-1) || 0;
    const moldHeaderRow = detailRows.findIndex((row, index) => index + 1 > previous && index + 1 < item.detailRow
      && text(row[0]) === '模号' && text(row[1]) === '名称') + 1;
    if (!moldHeaderRow) throw new Error(`货号 ${item.originalSku} 缺少模具明细表头`);
    const moldHeader = detailRows[moldHeaderRow - 1].map(normalized);
    const column = (...patterns) => moldHeader.findIndex(label => patterns.some(pattern => pattern.test(label)));
    const weightColumn = column(/^料重\(?G\)?$/);
    const materialColumn = column(/^料型$/);
    const priceColumn = column(/^料价\(?G\)?$/);
    const machineColumn = column(/^机型/);
    const cavityColumn = column(/件数|1出几套/);
    const setsColumn = column(/出模套数|套数/);
    const targetColumn = column(/目标数|啤数/);
    const shotColumn = column(/^啤工$/);
    if (weightColumn < 0 || priceColumn < 0) throw new Error(`货号 ${item.originalSku} 缺少料重或料价列`);
    const firstDetailRow = detailRows.findIndex((row, index) => index + 1 > moldHeaderRow
      && index + 1 < item.detailRow && /^(料价进口料|进口料价)$/.test(text(row[0]))) + 1;
    if (!firstDetailRow) throw new Error(`货号 ${item.originalSku} 缺少核价项目`);
    const injection = [];
    for (let row = moldHeaderRow + 1; row < firstDetailRow; row += 1) {
      const values = detailRows[row - 1];
      const weight = number(values[weightColumn]);
      const materialPrice = number(values[priceColumn]);
      if (!text(values[1]) || weight == null || materialPrice == null) continue;
      injection.push({
        mold_no: text(values[0]), name: text(values[1]), material: text(values[materialColumn]),
        weight_g: weight, source_weight_g: weight, material_unit_price: materialPrice,
        machine: text(values[machineColumn]), machine_model: text(values[machineColumn]),
        cavity: cavityColumn < 0 ? null : values[cavityColumn],
        sets: setsColumn < 0 ? null : number(values[setsColumn]),
        target: targetColumn < 0 ? null : number(values[targetColumn]),
        shot_price: shotColumn < 0 ? null : number(values[shotColumn]),
        source_usage: null, note: `来源：嘉苏核价!${row}`,
      });
    }
    const totalRow = detailRows.findIndex((values, index) => index + 1 > firstDetailRow
      && index + 1 < item.detailRow && (/^合计$/.test(text(values[0]))
        || /^(合计|TOTAL)/i.test(text(values[1]))
        || (!text(values[0]) && !text(values[1]) && number(values[2]) != null
          && /附加税/.test(text(detailRows[index - 1]?.[0]))))) + 1;
    if (!totalRow) throw new Error(`货号 ${item.originalSku} 缺少明细合计`);
    const departmentPayloads = Object.fromEntries(DEPARTMENTS.map(dept => [dept, { legacy_items: [] }]));
    for (let row = firstDetailRow; row < totalRow; row += 1) {
      const values = detailRows[row - 1];
      const name = text(values[0]);
      const amount = number(values[2]);
      if (!name || amount == null || /^(合计|TOTAL|码点)/i.test(name)) continue;
      departmentPayloads[departmentFor(name)].legacy_items.push({
        source_row: row, name, quantity: values[1] ?? null, current_hkd: amount,
        previous_hkd: null, difference_hkd: null,
        source_cells: values.slice(0, 5), note: `来源：嘉苏核价!${row}`,
      });
    }
    departmentPayloads.molding = { ...departmentPayloads.molding,
      injection, injection_loss_pct: 3, material_prices: materialPrices,
      machine_prices: machinePrices, blow_items: [], product_mix_ratios: {} };
    const startRow = Math.max(previous + 1, moldHeaderRow - 2);
    const sourceFormulas = [];
    for (let row = startRow; row <= item.detailRow; row += 1) {
      for (let col = 0; col < 29; col += 1) {
        const source = cell(detail, row, col);
        if (source.f) sourceFormulas.push({ cell: address(row, col), formula: source.f, value: source.v ?? null });
      }
    }
    const pricingTail = detailRows.slice(totalRow - 1, item.detailRow).flatMap((values, offset) =>
      values.some(value => value != null && value !== '')
        ? [{ source_row: totalRow + offset, cells: values.slice(0, 24) }] : []);
    const summaryRow = Array.from({ length: 135 }, (_, col) => value(summary, item.row, col));
    const duplicate = skuCounts.get(item.originalSku) > 1;
    const quoteNo = duplicate ? `${item.originalSku}（${item.productName}）` : item.originalSku;
    const sourceFormula = cell(summary, item.row, 5).f || '';
    const sourceDetailFormula = sourceFormula.match(/^'?货号分表'?!(\$?[A-Z]+\$?\d+)$/)
      ? workbook.Sheets['货号分表'][sourceFormula.split('!')[1].replaceAll('$', '')]?.f || '' : '';
    return {
      quoteNo, productName: item.productName || quoteNo, qty: item.qty, confirmedPrice: item.price,
      departmentPayloads,
      salesPayload: {
        header: { currency: 'HKD', fx_hkd_usd: 7.75, fx_rmb_hkd: 0.87 },
        pricing_summary: buildZuruPricingSummary(summaryRow, header, item.price),
        legacy_import: {
          summary_only: true, detail_imported: true, confirmed_currency: 'HKD',
          source_file: sourceFile, source_sheet: '总表', source_summary_row: item.row,
          source_detail_sheet: '嘉苏核价', source_detail_range: `A${startRow}:AC${item.detailRow}`,
          source_detail_title: detailRows.slice(startRow - 1, moldHeaderRow - 1)
            .flatMap(row => row.slice(0, 2).map(text)).filter(Boolean).join(' / ').slice(0, 250),
          source_price_formula: sourceFormula, source_detail_reference: sourceDetailFormula,
          source_formulas: sourceFormulas, source_detail_rows: Object.values(departmentPayloads)
            .reduce((sum, section) => sum + section.legacy_items.length, 0),
          source_mold_rows: injection.length, pricing_tail: pricingTail,
          source_detail_tail_rows: pricingTail.length,
          source_item: item.originalSku, source_customer: sourceCustomer,
          source_date: sourceDate, source_period: '2026-07',
          source_cost_including_labor: item.cost, source_cost_excluding_labor: item.withoutLabor,
        },
      },
    };
  });
  if (new Set(items.map(item => item.quoteNo)).size !== items.length) throw new Error('Zanzoon 货号与款式仍有重复');
  return { sourceFile, sourceDate, items, skipped,
    withQty: items.filter(item => item.qty != null).length,
    withoutQty: items.filter(item => item.qty == null).length,
    totalQty: items.reduce((sum, item) => sum + (item.qty || 0), 0) };
}

module.exports = { parseZanzoonVerificationWorkbook };
