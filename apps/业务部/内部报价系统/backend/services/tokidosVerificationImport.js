'use strict';
const XLSX = require('xlsx');
const path = require('node:path');
const { parseLegacyDetailSheet, detailAnalysisSummary } = require('./legacyVerificationImport');

// This workbook includes unrelated, older templates. Identity comes from the
// assembly sheet; only the matching current valuation is used for its costs.
function parseTokidosVerificationWorkbook(file, options = {}) {
  const workbook = XLSX.readFile(file, { cellFormula: true, cellNF: true });
  const assembly = workbook.Sheets['装配'], source = workbook.Sheets['核价'];
  const customer = String(assembly?.A2?.v || '').match(/客名[：:]\s*(\S+)/)?.[1];
  const identity = String(assembly?.A3?.v || '').match(/货名[：:]\s*(.*?)\s+货号[：:]\s*(\S+)/);
  if (customer !== 'Tokidos' || !identity || !String(source?.A12?.v).includes(identity[1])) {
    throw new Error('无法唯一对应 Tokidos 装配表与当前核价表');
  }
  if (!options.sourceDate) throw new Error('请指定原表日期');
  const sheet = { ...source, '!ref': 'A1:AC75' };
  const detail = parseLegacyDetailSheet(sheet, '核价', { moldHeaderIndex: 12, detailHeaderIndex: 21 });
  const analysis = detailAnalysisSummary(sheet);
  if (!Number.isFinite(analysis?.pricingSummary.t1.base_price)) throw new Error('缺少有效的原表货价');
  // Keep imported material and the separate PCBA calculation with their owners.
  const engineering = detail.departmentPayloads.engineering.legacy_items;
  const material = engineering.filter(row => /^(进口|国内)料价/.test(row.name));
  detail.departmentPayloads.engineering.legacy_items = engineering.filter(row => !material.includes(row));
  detail.departmentPayloads.molding.legacy_items.push(...material);
  detail.departmentPayloads.electronic.legacy_items.push({
    name: 'PCBA', source_row: 54, source_cell: 'C54', current_hkd: source.C54.v,
    previous_hkd: null, difference_hkd: null, quantity: null,
    note: '原表单独计算 PCBA；成本分析区按原表公式保留',
  });
  const sourceFile = options.sourceFile || path.basename(file);
  const notes = Object.values(source).filter(c => c && typeof c.v === 'string' && /暂时|暂定/.test(c.v)).map(c => c.v);
  const item = {
    quoteNo: identity[2], productName: identity[1], qty: null,
    confirmedPrice: analysis.pricingSummary.t1.base_price,
    verificationStatus: 'drafting',
    departmentPayloads: detail.departmentPayloads,
    salesPayload: {
      header: { currency: 'HKD', fx_rmb_hkd: source.D9.v, fx_hkd_usd: 7.75 },
      pricing_summary: analysis.pricingSummary,
      legacy_import: {
        detail_imported: true, confirmed_currency: 'HKD', source_file: sourceFile,
        source_date: options.sourceDate, source_sheet: '核价', source_detail_sheet: '核价',
        source_detail_range: 'A1:AC75', source_item: identity[2],
        source_identity: '装配!A2:A3', source_detail_rows: detail.detailCount + 1,
        source_mold_rows: detail.moldCount, pricing_tail: detail.pricingTail,
        source_order_quantity: null, source_cost_including_labor: analysis.totalCost,
        source_cost_excluding_labor: analysis.costWithoutLabor,
        import_review_notes: notes,
      },
    },
  };
  return { customer, sourceFile, sourceDate: options.sourceDate, items: [item], withQty: 0, withoutQty: 1, totalQty: 0 };
}
module.exports = { parseTokidosVerificationWorkbook };
