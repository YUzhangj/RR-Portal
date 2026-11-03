'use strict';

const path = require('node:path');
const XLSX = require('xlsx');
const { buildZuruPricingSummary } = require('./legacyVerificationImport');

const DEPARTMENTS = ['engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly'];
const text = value => String(value ?? '').trim();
const numeric = value => Number.isFinite(Number(value)) && value !== '' && value != null ? Number(value) : null;
const headerKey = value => text(value).replace(/[\s（）():：]/g, '');
const sourceCell = (column, row) => XLSX.utils.encode_cell({ c: column, r: row });

function departmentFor(label) {
  if (/电子|PCB|线路板|IC\b|喇叭|马达/i.test(label)) return 'electronic';
  if (/装工|包装人工|半成品人工|混装|拆查货|包装工/.test(label)) return 'assembly';
  if (/喷油|喷印|油漆|移印/.test(label)) return 'painting';
  if (/搪胶/.test(label)) return 'slush';
  if (/车缝|车衣|车发|毛发|布料/.test(label)) return 'sewing';
  if (/料价|啤工|料金额/.test(label)) return 'molding';
  return 'engineering';
}

function analysisHeaders(rows) {
  return rows.flatMap((row, index) => row.some(value => headerKey(value) === '货价')
    && row.filter(value => value !== null && value !== '').length >= 4
    ? [index] : []);
}

function workbookRows(workbook, name) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null, raw: true });
}

function summaryReference(formula) {
  const match = text(formula).match(/(?:'([^']+)'|([^!]+))!\$?[A-Z]+\$?(\d+)/);
  return match ? { sheet: match[1] || match[2], row: Number(match[3]) - 1 } : null;
}

function findAnalysis(workbook, data, item) {
  const direct = summaryReference(item.priceFormula);
  const candidates = [];
  for (const [sheet, entry] of Object.entries(data)) {
    for (const index of entry.analysis) {
      const following = entry.rows[index + 1] || [];
      const priceColumn = entry.rows[index].findIndex(value => headerKey(value) === '货价');
      const price = numeric(following[priceColumn]);
      const samePrice = price != null && Math.abs(price - item.confirmedPrice) < 0.00001;
      const nearReference = direct?.sheet === sheet ? Math.abs(index - direct.row) : Infinity;
      const preceding = entry.rows.slice(Math.max(0, index - 115), index)
        .flatMap(row => row.slice(0, 3).map(text)).join(' ');
      const gender = item.productName.match(/[男女]款/)?.[0] || '';
      const genericName = item.productName.replace(/[男女]款/, '');
      const ownMold = entry.rows.findLastIndex((row, r) => r < index
        && headerKey(row[0]) === '模号' && headerKey(row[1]) === '名称');
      const ownTitle = entry.rows.slice(Math.max(0, ownMold - 3), ownMold)
        .flatMap(row => row.slice(0, 3).map(text)).join(' ');
      const nearby = entry.rows.slice(Math.max(0, index - 65), index)
        .flatMap(row => row.slice(0, 3).map(text)).join(' ');
      const flywheelMatch = item.productName.includes('飞轮') && nearby.includes('飞轮')
        && (item.productName.includes('不带电') ? /不带电|普通款/.test(nearby)
          : /带电款|带电飞轮/.test(nearby) && !/不带电|普通款/.test(nearby));
      const nameMatch = preceding.includes(item.quoteNo) || preceding.includes(item.productName)
        || Boolean(gender && ownTitle.includes(gender) && ownTitle.includes(genericName))
        || flywheelMatch;
      if (!samePrice && nearReference > 70 && !nameMatch) continue;
      candidates.push({ sheet, index, score: (samePrice ? 1000 : 0)
        + (direct?.sheet === sheet ? Math.max(0, 500 - nearReference * 4) : 0)
        + (nameMatch ? 150 : 0)
        + (gender && ownTitle.includes(gender) ? 200 : 0)
        + (flywheelMatch ? 200 : 0), price });
    }
  }
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 150) throw new Error(`货号 ${item.quoteNo} 找不到可靠的核价明细区块`);
  if (direct && best.sheet !== direct.sheet) throw new Error(`货号 ${item.quoteNo} 的明细工作表不匹配`);
  return best;
}

function parseBlock(workbook, data, item, match) {
  const { sheet, index } = match;
  const { rows, analysis } = data[sheet];
  const previous = analysis.filter(value => value < index).at(-1) ?? -1;
  const next = analysis.find(value => value > index) ?? rows.length;
  const moldIndex = rows.findIndex((row, offset) => offset > previous && offset < index
    && headerKey(row[0]) === '模号' && headerKey(row[1]) === '名称');
  const start = moldIndex >= 0 ? Math.max(previous + 1, moldIndex - 2) : Math.max(0, previous + 8);
  const end = Math.min(next, index + 10);
  const sourceSheet = workbook.Sheets[sheet];
  const formulas = [];
  for (let r = start; r < end; r += 1) {
    for (let c = 0; c < Math.min(rows[r]?.length || 0, 24); c += 1) {
      const address = sourceCell(c, r);
      const cell = sourceSheet[address];
      if (cell?.f) formulas.push({ cell: address, formula: cell.f, value: cell.v ?? null });
    }
  }
  const departmentPayloads = Object.fromEntries(DEPARTMENTS.map(dept => [dept, { legacy_items: [] }]));
  const injection = [];
  let injectionEnd = moldIndex;
  if (moldIndex >= 0) {
    for (let r = moldIndex + 1; r < index; r += 1) {
      const row = rows[r];
      const weight = numeric(row[3]);
      const materialPrice = numeric(row[5]);
      if (!text(row[1]) || weight == null || materialPrice == null) {
        if (injection.length) break;
        continue;
      }
      injection.push({
        mold_no: text(row[0]), name: text(row[1]), material: text(row[2]),
        weight_g: weight, source_weight_g: weight, material_unit_price: materialPrice,
        machine: text(row[6]), machine_model: text(row[6]), cavity: row[7] ?? null,
        sets: numeric(row[8]), target: numeric(row[9]), shot_price: numeric(row[10]),
        source_usage: null, note: `来源：${sheet}!${r + 1}`,
      });
      injectionEnd = r;
    }
  }
  let total = rows.findIndex((row, r) => r > Math.max(start, injectionEnd) && r < index
    && row.some(value => /TOTAL.*HK/i.test(text(value))));
  if (total < 0) total = index;
  const detailStart = Math.max(start, injectionEnd + 1);
  for (let r = detailStart; r < total; r += 1) {
    const row = rows[r];
    const name = text(row[0]);
    const amount = numeric(row[2]);
    if (!name || amount == null || /^(合计|TOTAL|汇率|料型|机型|备注)/i.test(name)) continue;
    const record = {
      source_row: r + 1, name, quantity: row[1] ?? null,
      current_hkd: amount, previous_hkd: null, difference_hkd: null,
      note: `来源：${sheet}!${r + 1}`,
      source_cells: row.slice(0, 5),
    };
    departmentPayloads[departmentFor(name)].legacy_items.push(record);
  }
  const materialNames = rows[0] || [];
  const materialRates = rows[1] || [];
  const machineNames = rows[5] || [];
  const machineRates = rows[6] || [];
  departmentPayloads.molding = {
    ...departmentPayloads.molding,
    injection, injection_loss_pct: 3,
    material_prices: materialNames.flatMap((name, c) => c && text(name) && numeric(materialRates[c]) != null
      ? [{ name: text(name), model: text(name), price: numeric(materialRates[c]) }] : []),
    machine_prices: machineNames.flatMap((name, c) => c && text(name) && numeric(machineRates[c]) != null
      ? [{ model: text(name), normal: '', price: numeric(machineRates[c]) }] : []),
    blow_items: [], product_mix_ratios: {},
  };
  const tail = rows.slice(total, index).flatMap((row, offset) => row.some(value => value !== null && value !== '')
    ? [{ source_row: total + offset + 1, cells: row.slice(0, 24) }] : []);
  const title = rows.slice(start, moldIndex >= 0 ? moldIndex : Math.min(index, start + 5))
    .flatMap(row => row.slice(0, 3).map(text)).filter(Boolean).join(' / ').slice(0, 250);
  return {
    departmentPayloads, sourceSheet: sheet, sourceRange: `A${start + 1}:X${end}`,
    sourceTitle: title, sourceFormulas: formulas, pricingTail: tail,
    detailCount: Object.values(departmentPayloads).reduce((sum, section) => sum + section.legacy_items.length, 0),
    moldCount: injection.length,
  };
}

function parseCepiaVerificationWorkbook(file, options = {}) {
  const workbook = XLSX.readFile(file, { cellDates: true, cellFormula: true });
  if (!workbook.Sheets['总表']) throw new Error('Cepia 工作簿缺少“总表”');
  const sourceFile = options.sourceFile || path.basename(file);
  const sourceDate = options.sourceDate || '2026-05-09';
  const summary = workbookRows(workbook, '总表');
  const header = summary[0];
  const data = Object.fromEntries(workbook.SheetNames
    .filter(name => !['总表', '喷笔核价', 'WpsReserved_CellImgList'].includes(name))
    .map(name => {
      const rows = workbookRows(workbook, name);
      return [name, { rows, analysis: analysisHeaders(rows) }];
    }));
  const items = summary.slice(1).flatMap((row, offset) => {
    const quoteNo = text(row[1]);
    const confirmedPrice = numeric(row[4]);
    if (!quoteNo || confirmedPrice == null || confirmedPrice <= 0) return [];
    const item = {
      quoteNo, productName: text(row[2]) || quoteNo,
      qty: numeric(row[3]), confirmedPrice,
      priceFormula: workbook.Sheets['总表'][`E${offset + 2}`]?.f || '',
    };
    const match = findAnalysis(workbook, data, item);
    const block = parseBlock(workbook, data, item, match);
    return [{
      quoteNo, productName: item.productName, qty: item.qty, confirmedPrice,
      departmentPayloads: block.departmentPayloads,
      salesPayload: {
        header: { currency: 'HKD', fx_hkd_usd: 7.75, fx_rmb_hkd: 0.87 },
        pricing_summary: buildZuruPricingSummary(row, header, confirmedPrice),
        legacy_import: {
          summary_only: true, detail_imported: true, confirmed_currency: 'HKD',
          source_file: sourceFile, source_sheet: '总表', source_summary_row: offset + 2,
          source_detail_sheet: block.sourceSheet, source_detail_range: block.sourceRange,
          source_detail_title: block.sourceTitle, source_price_formula: item.priceFormula,
          source_formulas: block.sourceFormulas,
          source_detail_rows: block.detailCount, source_mold_rows: block.moldCount,
          source_detail_tail_rows: block.pricingTail.length, pricing_tail: block.pricingTail,
          source_item: quoteNo, source_date: sourceDate,
          source_cost_including_labor: numeric(row[5]) || 0,
          source_cost_excluding_labor: numeric(row[6]) || 0,
        },
      },
    }];
  });
  if (new Set(items.map(item => item.quoteNo)).size !== items.length) throw new Error('Cepia 总表存在重复货号');
  return {
    sourceFile, sourceDate, items,
    withQty: items.filter(item => item.qty != null).length,
    withoutQty: items.filter(item => item.qty == null).length,
    totalQty: items.reduce((sum, item) => sum + (item.qty || 0), 0),
  };
}

module.exports = { parseCepiaVerificationWorkbook };
