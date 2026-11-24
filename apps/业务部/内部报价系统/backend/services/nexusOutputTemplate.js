'use strict';

const { DEFAULT_COSTING_BASIS } = require('./costingBasis');
const InjectionPricing = require('../../frontend/injection-pricing');
const { buildWorkbook: buildLegacyWorkbook } = require('./exportInternal');
const { calculateQuoteCosts } = require('./quoteCostSummary');
const { applyWorkbookOverrides } = require('./outputWorkbookOverrides');

// The workbook body intentionally keeps the quotation template pulled from
// Royal-Regent-Nexus.  Only the surrounding output page uses this system's
// blue/white application chrome.
const TEMPLATE_RED = 'FFFF0000';
const TEMPLATE_BLUE = 'FF0000FF';
const TEMPLATE_BLACK = 'FF000000';
const TEMPLATE_YELLOW = 'FFFFFF00';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function parseSections(sections) {
  const result = {};
  for (const section of sections || []) {
    try { result[section.dept] = JSON.parse(section.payload_json || '{}'); }
    catch (_) { result[section.dept] = {}; }
  }
  return result;
}

function border(style = 'thin') {
  const side = { style, color: { argb: TEMPLATE_BLACK } };
  return { top: side, right: side, bottom: side, left: side };
}

function styleCell(cell, options = {}) {
  cell.font = {
    name: options.fontName || '宋体',
    size: options.size || 10,
    bold: Boolean(options.bold),
    color: { argb: options.color || TEMPLATE_BLACK },
  };
  cell.alignment = {
    horizontal: options.horizontal || 'center',
    vertical: 'middle',
    wrapText: options.wrap !== false,
  };
  if (options.fill) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: options.fill } };
  }
  cell.border = options.border === false ? {} : border(options.border || 'thin');
  if (options.numFmt) cell.numFmt = options.numFmt;
}

function referenceRows(molding) {
  const materials = Array.isArray(molding.material_prices) && molding.material_prices.length
    ? molding.material_prices : DEFAULT_COSTING_BASIS.materials;
  const machines = Array.isArray(molding.machine_prices) && molding.machine_prices.length
    ? molding.machine_prices : DEFAULT_COSTING_BASIS.machines;
  return { materials, machines };
}

function cartonPaperRates(engineering) {
  const carton = engineering.carton_calc || {};
  const boxes = Array.isArray(carton.cartons) ? carton.cartons : [];
  const mainBox = boxes.find(box => /主纸箱|外箱/.test(text(box.name || box.label))) || boxes[0] || {};
  const innerBox = boxes.find(box => /内箱/.test(text(box.name || box.label))) || {};
  const flatCard = boxes.flatMap(box => Array.isArray(box.flat_cards) ? box.flat_cards : [])[0] || {};
  const savedRate = number(carton.paper_rate, 2.75);
  return {
    main: number(mainBox.paper_rate ?? carton.main_paper_rate, savedRate),
    inner: number(innerBox.paper_rate ?? carton.inner_paper_rate, savedRate),
    flat: number(flatCard.paper_rate ?? carton.flat_card_paper_rate ?? carton.flat_card_rate, savedRate),
  };
}

function materialReferenceLabel(row) {
  const name = text(row && row.name);
  const model = text(row && row.model);
  if (!model) return name;
  if (!name || name.toUpperCase().includes(model.toUpperCase())) return name || model;
  return `${model} ${name}`;
}

function normalizedMaterialPart(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9\u3400-\u9FFF]+/g, '');
}

function materialReferenceColumn(molding, source) {
  if (!source) return null;
  const material = normalizedMaterialPart(source.material);
  const grade = normalizedMaterialPart(source.material_grade);
  const references = referenceRows(molding || {}).materials.slice(0, 18);
  const index = references.findIndex(reference => {
    const name = normalizedMaterialPart(reference.name);
    const model = normalizedMaterialPart(reference.model);
    const materialMatches = !material || name.includes(material) || material.includes(name);
    const gradeMatches = !grade || model === grade || model.includes(grade) || grade.includes(model);
    return materialMatches && gradeMatches;
  });
  return index < 0 ? null : { column: index + 3, reference: references[index] };
}

function machineReferenceColumn(molding, source) {
  if (!source) return null;
  const references = referenceRows(molding || {}).machines.slice(0, 15);
  const matched = InjectionPricing.lookupMachinePrice(source.machine_model, references);
  if (!matched) return null;
  const index = references.indexOf(matched);
  return index < 0 ? null : { column: index + 3, reference: matched };
}

function buildReferenceBlock(ws, molding, sales, assembly, engineering) {
  const references = referenceRows(molding || {});
  const materialReferences = references.materials.slice(0, 18);
  const machineReferences = references.machines.slice(0, 15);
  for (let row = 1; row <= 7; row += 1) {
    ws.getRow(row).height = row === 7 ? 15 : (row === 6 ? 13.5 : 12.75);
    for (let column = 1; column <= 20; column += 1) {
      styleCell(ws.getCell(row, column), {
        color: TEMPLATE_BLACK,
        border: false,
        wrap: false,
      });
    }
  }

  ws.getCell(1, 2).value = '料型';
  ws.getCell(2, 2).value = '单价';
  ws.getCell(4, 2).value = '料单价';
  styleCell(ws.getCell(4, 2), { color: 'FFFF00FF', border: false, horizontal: 'left', wrap: false });
  materialReferences.forEach((reference, index) => {
    const column = 3 + index;
    const price = number(reference.price);
    ws.getCell(1, column).value = materialReferenceLabel(reference);
    ws.getCell(2, column).value = price;
    ws.getCell(2, column).numFmt = '0.00';
    ws.getCell(3, column).value = 454;
    ws.getCell(3, column).numFmt = '0';
    const columnLetter = ws.getColumn(column).letter;
    ws.getCell(4, column).value = {
      formula: `ROUND(${columnLetter}2/${columnLetter}3,4)`,
      result: Number((price / 454).toFixed(4)),
    };
    ws.getCell(4, column).numFmt = '0.0000';
    styleCell(ws.getCell(4, column), { color: 'FFFF00FF', border: false, wrap: false });
  });
  ws.getCell(5, 2).value = '机型';
  ws.getCell(6, 2).value = '啤工价';
  styleCell(ws.getCell(6, 2), { color: 'FFFF00FF', border: false, horizontal: 'left', wrap: false });
  machineReferences.forEach((reference, index) => {
    const column = 3 + index;
    const price = number(reference.price);
    ws.getCell(5, column).value = text(reference.model || reference.normal);
    ws.getCell(6, column).value = price;
    ws.getCell(6, column).numFmt = '#,##0';
    styleCell(ws.getCell(6, column), { color: 'FFFF00FF', border: false, wrap: false });
  });

  // Keep the quote parameters together on one visible reference row.  These
  // values come from the current quote instead of being template constants.
  const paperRates = cartonPaperRates(engineering || {});
  const lossPercentage = number(molding.injection_loss_pct, 3);
  const parameterPairs = [
    ['汇率', number(sales.header && sales.header.fx_rmb_hkd, DEFAULT_COSTING_BASIS.exchange.rmb_hkd), '0.00'],
    ['主纸箱系数', paperRates.main, '0.00'],
    ['内纸箱系数', paperRates.inner, '0.00'],
    ['平卡系数', paperRates.flat, '0.00'],
    ['料重损耗', lossPercentage / 100, '0%'],
    ['人工', number(assembly.assembly_base_rate, DEFAULT_COSTING_BASIS.assembly.base_rate_hkd), '#,##0'],
    ['印尼运费', number(molding.indo_pct) / 100, '0.00%'],
  ];
  parameterPairs.forEach(([label, value, numFmt], index) => {
    const labelColumn = 2 + index * 2;
    const valueColumn = labelColumn + 1;
    ws.getCell(7, labelColumn).value = label;
    ws.getCell(7, valueColumn).value = value;
    ws.getCell(7, valueColumn).outputLabel = label;
    styleCell(ws.getCell(7, labelColumn), {
      color: TEMPLATE_BLACK, border: false, horizontal: 'left', wrap: false,
    });
    styleCell(ws.getCell(7, valueColumn), {
      color: TEMPLATE_BLACK, border: false, numFmt, wrap: false,
    });
  });
}

function injectionRows(molding) {
  return Array.isArray(molding.injection) ? molding.injection : [];
}

function buildQuotationDetail(ws, quote, molding) {
  ws.mergeCells(8, 1, 8, 18);
  const quoteTitle = ws.getCell(8, 1);
  quoteTitle.value = `${quote.product_name || quote.quote_no || '产品'}报价`;
  styleCell(quoteTitle, {
    color: TEMPLATE_BLUE,
    size: 14,
    bold: false,
    border: 'medium',
    wrap: false,
  });
  ws.getRow(8).height = 27;

  ws.mergeCells(9, 1, 9, 13);
  const detailTitle = ws.getCell(9, 1);
  detailTitle.value = `${quote.product_name || quote.quote_no || '产品'}-明细`;
  styleCell(detailTitle, {
    color: TEMPLATE_BLUE,
    fill: TEMPLATE_YELLOW,
    bold: true,
    size: 10,
    border: 'medium',
    wrap: false,
  });
  const lossPercentage = number(molding.injection_loss_pct, 3);
  const headers = ['', '', '名称', '料型', '料重(G)', '含料损耗重量(G)', '料价(G)', '机型（A）', '1出几套', '目标数', '啤工', '料金额', '报价啤工'];
  headers.forEach((header, index) => {
    const cell = ws.getCell(10, index + 1);
    cell.value = header;
    styleCell(cell, {
      color: index < 2 ? TEMPLATE_BLACK : TEMPLATE_RED,
      wrap: false,
    });
  });
  ws.getRow(10).height = 15;

  const rows = injectionRows(molding);
  const slots = Math.max(6, rows.length);
  const start = 11;
  const lossRate = lossPercentage / 100;
  const lossMultiplier = 1 + lossRate;
  for (let index = 0; index < slots; index += 1) {
    const source = rows[index];
    const row = start + index;
    const materialReferenceCandidate = materialReferenceColumn(molding, source);
    const savedMaterialPrice = source?.material_unit_price;
    const materialReference = materialReferenceCandidate && (savedMaterialPrice == null || savedMaterialPrice === ''
      || Math.abs(Number(savedMaterialPrice) - Number((number(materialReferenceCandidate.reference.price) / 454).toFixed(4))) < 1e-10)
      ? materialReferenceCandidate : null;
    const machineReference = machineReferenceColumn(molding, source);
    const weight = source ? number(source.weight_g) : 0;
    const materialPrice = source ? (materialReference
      ? Number((number(materialReference.reference.price) / 454).toFixed(4))
      : number(source.material_unit_price)) : 0;
    const labor = source ? number(InjectionPricing.laborPrice(source)) : 0;
    const materialAmount = weight * lossMultiplier * materialPrice;
    const values = source ? [
      index + 1,
      text(source.mold_no),
      text(source.name),
      [text(source.material), text(source.material_grade)].filter(Boolean).join(' '),
      weight,
      weight * lossMultiplier,
      materialPrice,
      text(source.machine_model || source.machine),
      source.sets == null || source.sets === '' ? 1 : number(source.sets),
      number(source.target),
      labor,
      materialAmount,
      labor * 1.15,
    ] : Array(13).fill('');
    values.forEach((value, offset) => {
      const cell = ws.getCell(row, offset + 1);
      if (source && offset + 1 === 6) {
        cell.value = {
          formula: `E${row}*(1+$K$7)`,
          result: weight * lossMultiplier,
        };
      } else if (source && offset + 1 === 7 && materialReference) {
        const referenceLetter = ws.getColumn(materialReference.column).letter;
        cell.value = {
          formula: `${referenceLetter}4`,
          result: Number((number(materialReference.reference.price) / 454).toFixed(4)),
        };
      } else if (source && offset + 1 === 11 && machineReference &&
          number(source.target) > 0 && number(source.sets, 1) > 0 &&
          !InjectionPricing.isAdditionalPart(source) &&
          Math.abs(labor - Number((number(machineReference.reference.price) / number(source.target) / number(source.sets, 1)).toFixed(4))) < 1e-10) {
        const referenceLetter = ws.getColumn(machineReference.column).letter;
        cell.value = {
          formula: `ROUND(${referenceLetter}6/J${row}/I${row},4)`,
          result: labor,
        };
      } else if (source && offset + 1 === 13) {
        cell.value = { formula: `K${row}*1.15`, result: labor * 1.15 };
      } else if (source && offset + 1 === 12) {
        cell.value = {
          formula: `F${row}*G${row}`,
          result: materialAmount,
        };
      } else {
        cell.value = value;
      }
      if (source) cell.outputSourceIdentity = ['molding', 'injection', index, source];
      styleCell(cell, {
        horizontal: [2, 3, 4].includes(offset + 1) ? 'left' : 'center',
        wrap: false,
        numFmt: offset + 1 === 6 ? '0.000'
          : [7, 11, 13].includes(offset + 1) ? '0.0000'
            : offset + 1 === 12 ? '0.000' : undefined,
        fontName: [1, 5, 6, 7, 9, 10, 11, 12, 13].includes(offset + 1) ? 'Times New Roman' : '宋体',
      });
    });
    ws.getRow(row).height = 15;
  }

  const totalRow = start + slots;
  for (let column = 1; column <= 13; column += 1) {
    styleCell(ws.getCell(totalRow, column), {
      color: TEMPLATE_RED,
      wrap: false,
    });
  }
  ws.mergeCells(totalRow, 1, totalRow, 4);
  ws.getCell(totalRow, 1).value = '模具合计';
  ws.getCell(totalRow, 1).font = {
    name: '宋体',
    size: 10,
    bold: true,
    color: { argb: TEMPLATE_BLUE },
  };
  const sums = {
    5: rows.reduce((sum, row) => sum + number(row.weight_g), 0),
    6: rows.reduce((sum, row) => sum + number(row.weight_g) * lossMultiplier, 0),
    11: rows.reduce((sum, row) => sum + number(InjectionPricing.laborPrice(row)), 0),
    12: rows.reduce((sum, row) => {
      const reference = materialReferenceColumn(molding, row);
      const price = row.material_unit_price != null && row.material_unit_price !== '' ? number(row.material_unit_price) : reference
        ? Number((number(reference.reference.price) / 454).toFixed(4))
        : number(row.material_unit_price);
      return sum + number(row.weight_g) * lossMultiplier * price;
    }, 0),
    13: rows.reduce((sum, row) => sum + number(InjectionPricing.laborPrice(row)) * 1.15, 0),
  };
  for (const [column, result] of Object.entries(sums)) {
    const letter = ws.getColumn(Number(column)).letter;
    ws.getCell(totalRow, Number(column)).value = { formula: `SUM(${letter}${start}:${letter}${start + slots - 1})`, result };
    ws.getCell(totalRow, Number(column)).numFmt = Number(column) === 12 ? '0.000' : '0.0000';
  }

  return totalRow;
}

function snapshotCellValue(value) {
  if (value == null) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'formula')) {
    // The pulled quotation-detail page is a generated snapshot.  Formula
    // addresses from the system summary no longer point at the same rows once
    // the block is appended here, so use Excel's cached result instead.
    return value.result == null ? '' : value.result;
  }
  if (Array.isArray(value.richText)) return value.richText.map(item => item.text || '').join('');
  if (Object.prototype.hasOwnProperty.call(value, 'text')) return value.text;
  return JSON.parse(JSON.stringify(value));
}

function cloneStyle(style) {
  return style ? JSON.parse(JSON.stringify(style)) : {};
}

function columnNumber(label) {
  return String(label || '').toUpperCase().split('').reduce((total, letter) => (
    total * 26 + letter.charCodeAt(0) - 64
  ), 0);
}

function decodeRange(range) {
  const match = String(range || '').match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    left: columnNumber(match[1]), top: Number(match[2]),
    right: columnNumber(match[3]), bottom: Number(match[4]),
  };
}

function findAdditionalDetailsStart(ws) {
  for (let row = 1; row <= ws.rowCount; row += 1) {
    if (text(ws.getCell(row, 1).value) === '序号' && text(ws.getCell(row, 2).value) === '类别') return row;
  }
  return 0;
}

function appendRemainingQuotationSections(target, source, afterRow) {
  if (!source) return afterRow;
  const sourceStart = findAdditionalDetailsStart(source);
  if (!sourceStart) return afterRow;

  const titleRow = afterRow + 2;
  target.mergeCells(titleRow, 1, titleRow, 18);
  target.getCell(titleRow, 1).value = '外购、喷油、电子、包装及总成本';
  styleCell(target.getCell(titleRow, 1), {
    color: TEMPLATE_BLUE,
    fill: TEMPLATE_YELLOW,
    bold: true,
    size: 10,
    border: 'medium',
    wrap: false,
  });

  const targetStart = titleRow + 1;
  const sourceEnd = source.rowCount;
  for (let sourceRow = sourceStart; sourceRow <= sourceEnd; sourceRow += 1) {
    const targetRow = targetStart + sourceRow - sourceStart;
    const fromRow = source.getRow(sourceRow);
    const toRow = target.getRow(targetRow);
    toRow.height = fromRow.height;
    toRow.hidden = fromRow.hidden;
    toRow.outlineLevel = fromRow.outlineLevel;
    for (let column = 1; column <= 18; column += 1) {
      const from = source.getCell(sourceRow, column);
      const to = target.getCell(targetRow, column);
      const isMergeChild = from.isMerged && from.master && from.master.address !== from.address;
      to.value = isMergeChild ? null : snapshotCellValue(from.value);
      to.style = cloneStyle(from.style);
      if (from.numFmt) to.numFmt = from.numFmt;
    }
  }

  for (const rangeText of source.model.merges || []) {
    const range = decodeRange(rangeText);
    if (!range || range.top < sourceStart || range.bottom > sourceEnd || range.right > 18) continue;
    const rowOffset = targetStart - sourceStart;
    target.mergeCells(
      range.top + rowOffset,
      range.left,
      range.bottom + rowOffset,
      range.right
    );
  }

  return targetStart + sourceEnd - sourceStart;
}

function itemizedFreeRows(payloads, costs) {
  const components = costs.components || {};
  const engineering = payloads.engineering || {};
  const electronic = payloads.electronic || {};
  const sales = payloads.sales || {};
  const fxRH = number(sales.header && sales.header.fx_rmb_hkd, 0.85) || 0.85;
  const fxHU = number(sales.header && sales.header.fx_hkd_usd, 7.8) || 7.8;
  const hasValue = (row, key) => row && row[key] !== undefined && row[key] !== null && row[key] !== '';
  const pricing = row => {
    if (row.source_currency === 'USD' || (hasValue(row, 'unit_price_usd') && !hasValue(row, 'unit_price_rmb'))) {
      return {
        currency: 'USD', unitPrice: number(hasValue(row, 'unit_price_usd') ? row.unit_price_usd : row.unit_price_usd_raw),
        exchangeRate: fxHU, operator: 'multiply',
      };
    }
    if (hasValue(row, 'unit_price_rmb')) {
      return { currency: 'RMB', unitPrice: number(row.unit_price_rmb), exchangeRate: fxRH, operator: 'divide' };
    }
    return { currency: 'HKD', unitPrice: number(row.unit_price), exchangeRate: 1, operator: 'none' };
  };
  const flatten = rows => (rows || []).flatMap(parent => {
    if (!Array.isArray(parent.children) || !parent.children.length) return [parent];
    return parent.children.map(child => ({ ...parent, ...child, category: child.category || parent.category }));
  }).filter(row => !row.is_subtotal);
  const calculation = row => {
    const price = pricing(row);
    const quantity = number(row.qty);
    const value = price.operator === 'divide'
      ? quantity * price.unitPrice / price.exchangeRate
      : price.operator === 'multiply'
        ? quantity * price.unitPrice * price.exchangeRate
        : quantity * price.unitPrice;
    return {
      kind: 'unit-quantity', quantity, ...price, value,
      unit: 'HKD/件', quantityLabel: '用量', unitPriceLabel: `单价（${price.currency}）`,
    };
  };
  const displayName = row => {
    const name = text(row.name || row.part || row.item || row.spec) || '未命名项目';
    const spec = text(row.spec);
    const detail = spec && !name.includes(spec) ? `${name} ${spec}` : name;
    const qty = number(row.qty);
    return qty && !/\bpcs?\b|件|个|只|套/i.test(detail) ? `${detail} (${qty}pcs)` : detail;
  };
  const matches = (row, pattern) => pattern.test(`${row.name || ''} ${row.spec || ''}`);
  const categoryOf = (row, table) => {
    const allowed = ['吸塑', '胶袋', '彩盒/内咭', '电池', '产品利宝', '彩盒利宝', '电镀', '植绒', '其他外购'];
    if (allowed.includes(row.category)) return row.category;
    if (row.category === '利宝') return '产品利宝';
    if (matches(row, /吸塑|blister/i)) return '吸塑';
    if (matches(row, /胶袋|胶代|poly\s?bag|pe\s?bag|opp\s?bag/i)) return '胶袋';
    if (matches(row, /电池|battery/i)) return '电池';
    if (matches(row, /利宝|贴纸|libao|sticker/i)) {
      return matches(row, /彩盒|彩卡|内咭|内卡|背卡|包装|package|box/i) ? '彩盒利宝' : '产品利宝';
    }
    if (matches(row, /电镀|plating/i)) return '电镀';
    if (matches(row, /纸箱|carton/i)) return null;
    return table === 'aux' ? '其他外购' : '彩盒/内咭';
  };
  const hardware = flatten(engineering.hardware);
  const electronics = flatten(electronic.electronics && electronic.electronics.length
    ? electronic.electronics : engineering.electronics);
  const packaging = flatten(engineering.packaging_materials).map(row => ({ ...row, _table: 'packaging' }));
  const auxiliary = flatten(engineering.aux_materials).map(row => ({ ...row, _table: 'aux' }));
  const purchases = [...packaging, ...auxiliary];
  const definitions = {
    hardware: { tax: '¥13%', category: '五金', rows: hardware.filter(row => !matches(row, /马达|motor/i)) },
    electronic: { tax: '¥13%', category: '电子', rows: electronics },
    motor: { tax: '¥13%', category: '马达', rows: hardware.filter(row => matches(row, /马达|motor/i)) },
    suction: { tax: '¥4%', category: '吸塑', rows: [
      ...purchases.filter(row => categoryOf(row, row._table) === '吸塑'),
      ...hardware.filter(row => matches(row, /吸塑|blister/i)),
      ...electronics.filter(row => matches(row, /吸塑|blister/i)),
    ] },
    glue_bag: { tax: '¥13%', category: '其他外购', rows: purchases.filter(row => categoryOf(row, row._table) === '胶袋') },
    color_box: { tax: '¥13%', category: '彩盒/内卡', rows: purchases.filter(row => categoryOf(row, row._table) === '彩盒/内咭') },
    battery: { tax: '¥13%', category: '电池', rows: purchases.filter(row => categoryOf(row, row._table) === '电池') },
    libao: { tax: '¥13%', category: '利宝/说明书', rows: purchases.filter(row => ['产品利宝', '彩盒利宝'].includes(categoryOf(row, row._table))) },
    plating: { tax: '¥1%', category: '电镀', rows: purchases.filter(row => categoryOf(row, row._table) === '电镀') },
    flocking: { tax: '¥13%', category: '植绒', rows: purchases.filter(row => categoryOf(row, row._table) === '植绒') },
    other_buy: { tax: '¥13%', category: '其他外购', rows: purchases.filter(row => categoryOf(row, row._table) === '其他外购') },
  };
  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => {
    const rows = definition.rows.map(row => {
      const itemCalculation = calculation(row);
      return [definition.tax, definition.category, displayName(row), itemCalculation.value, [key], {
        itemized: true, calculation: itemCalculation,
      }];
    });
    const sum = rows.reduce((total, row) => total + number(row[3]), 0);
    const remainder = number(components[key]) - sum;
    if (Math.abs(remainder) >= 0.00005) {
      rows.push([definition.tax, definition.category, rows.length ? `${definition.category}调整` : definition.category,
        remainder, [key], { itemized: true }]);
    }
    return [key, rows];
  }));
}

function itemizedAssemblyRows(payloads, costs, quote) {
  const assembly = payloads.assembly || {};
  const rows = [];
  const pushLegacy = (items, label) => (items || []).filter(item => !item.is_subtotal).forEach(item => {
    rows.push(['', '装配工', text(item.name) || label, number(item.qty) * number(item.unit_price),
      ['assembly_labor'], { itemized: true }]);
  });
  pushLegacy(assembly.assembly_labor, '组装');
  pushLegacy(assembly.packaging_labor, '包装');
  const baseRate = number(assembly.assembly_base_rate, quote.factory_code === 'heyuan' ? 260 : 310);
  const pushGroups = (groups, label) => (groups || []).forEach(group => {
    const people = (group.steps || []).reduce((sum, step) => sum + number(step.count), 0);
    const team = number(group.team, 1) || 1;
    const quantity = Math.max(number(group.qty), 1);
    const factor = require('./assemblyMix').assemblyGroupFactor(group, groups);
    rows.push(['', '装配工', text(group.product) || label,
      baseRate * people / quantity * team * factor, ['assembly_labor'], { itemized: true }]);
  });
  pushGroups(assembly.assembly_step_groups, '组装');
  pushGroups(assembly.packaging_step_groups, '包装');
  const sum = rows.reduce((total, row) => total + number(row[3]), 0);
  const remainder = number(costs.components && costs.components.assembly_labor) - sum;
  if (Math.abs(remainder) >= 0.00005) {
    rows.push(['', '装配工', rows.length ? '装配工调整' : '装工 / 包装', remainder,
      ['assembly_labor'], { itemized: true }]);
  }
  return rows;
}

function componentRows(costs, payloads = {}, quote = {}) {
  const components = costs.components || {};
  const surtax = number(costs.detailPricing && costs.detailPricing.surtaxHkd);
  // components.misc 是现有成本口径中的“印尼运费 + 附加税”；用差额拆分可保持
  // 拆分前后总额完全一致，也兼容历史报价和混装报价。
  const indonesiaFreight = number(components.misc) - surtax;
  const purchaseRows = itemizedFreeRows(payloads, costs);
  const assemblyRows = itemizedAssemblyRows(payloads, costs, quote);
  const rows = [
    ['', '料价', '进口料价', number(components.imp_mat), ['imp_mat']],
    ['', '料价', '国内料价', number(components.dom_mat), ['dom_mat']],
    ['', '啤工', '啤工', number(components.injection_labor), ['injection_labor']],
    ...assemblyRows,
    ['', '喷油工', '喷油人工', number(components.painting_labor), ['painting_labor']],
    ['¥13%', '油漆', '油漆', number(components.paint_material), ['paint_material']],
    ['', '吹气', '吹气', number(components.blow), ['blow']],
    ['', '搪胶', '搪胶', number(components.slush), ['slush']],
    ['', '车发', '车发', number(components.sewing_hair), ['sewing_hair']],
    ['', '车衣', '车衣', number(components.sewing_cloth), ['sewing_cloth']],
    ...purchaseRows.hardware,
    ...purchaseRows.electronic,
    ...purchaseRows.motor,
    ...purchaseRows.suction,
    ...purchaseRows.glue_bag,
    ...purchaseRows.color_box,
    ...purchaseRows.battery,
    ...purchaseRows.libao,
    ...purchaseRows.plating,
    ...purchaseRows.flocking,
    ...purchaseRows.other_buy,
    ['', '纸箱', '纸箱 / 平卡', number(components.carton), ['carton']],
    ['', '印尼运费', '印尼运费', indonesiaFreight, ['indo_freight']],
    ['', '附加税', '附加税 0.4%', surtax, ['surtax']],
  ];
  return rows.filter(row => row[5]?.itemized
    || ['imp_mat', 'dom_mat', 'indo_freight', 'surtax'].includes(row[4] && row[4][0])
    || Math.abs(row[3]) >= 0.0005);
}

function costComponentTotal(costs) {
  return Object.entries(costs.components || {}).reduce((sum, [key, value]) => (
    key === 'abs_material' ? sum : sum + number(value)
  ), 0);
}

function writeDetailCell(ws, row, column, value, options = {}) {
  const cell = ws.getCell(row, column);
  cell.value = value;
  styleCell(cell, {
    horizontal: options.horizontal || (column === 3 ? 'left' : 'center'),
    color: options.color || TEMPLATE_BLACK,
    fill: options.fill,
    bold: options.bold,
    border: options.border || 'thin',
    wrap: options.wrap !== false,
    numFmt: options.numFmt,
    fontName: column === 4 ? 'Times New Roman' : '宋体',
  });
  return cell;
}

function formulaResult(cell) {
  const value = cell && cell.value;
  const raw = cell?.formula ? cell.result
    : value && typeof value === 'object' && Object.hasOwn(value, 'result') ? value.result : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function sectionFieldReference(sourceSheet, sectionTitle, fieldLabel) {
  if (!sourceSheet) return null;
  let sectionRow = 0;
  sourceSheet.eachRow(row => {
    if (!sectionRow && text(row.getCell(1).value) === sectionTitle) sectionRow = row.number;
  });
  if (!sectionRow) return null;
  const headerRow = sourceSheet.getRow(sectionRow + 1);
  let column = 0;
  headerRow.eachCell(cell => {
    if (!column && text(cell.value) === fieldLabel) column = cell.col;
  });
  if (!column) return null;
  const valueCell = sourceSheet.getCell(sectionRow + 2, column);
  const result = formulaResult(valueCell);
  if (result == null) return null;
  return {
    formula: `'${sourceSheet.name.replace(/'/g, "''")}'!${valueCell.address}`,
    result,
  };
}

function upperQuotationCostLinks(ws, molding, totalRow) {
  const imported = [];
  const domestic = [];
  injectionRows(molding).forEach((source, index) => {
    const material = text(source && source.material).toUpperCase();
    if (!material) return;
    const target = /^(PVC|TPR|TPE)\b/.test(material) ? domestic : imported;
    const address = `L${11 + index}`;
    target.push({ address, result: number(ws.getCell(address).result) });
  });
  const linkedSum = cells => ({
    formula: cells.length === 0 ? '0'
      : cells.length === 1 ? cells[0].address
        : `SUM(${cells.map(cell => cell.address).join(',')})`,
    result: cells.reduce((sum, cell) => sum + cell.result, 0),
  });
  return new Map([
    ['imp_mat', linkedSum(imported)],
    ['dom_mat', linkedSum(domestic)],
    ['injection_labor', {
      formula: `K${totalRow}`,
      result: number(ws.getCell(totalRow, 11).result),
    }],
  ]);
}

function buildCartonPanel(ws, engineering, startRow, unitPriceCells = [], metrics = {}) {
  const carton = engineering.carton_calc || {};
  const cartons = Array.isArray(carton.cartons) && carton.cartons.length
    ? carton.cartons
    : (carton.cl || carton.cw || carton.ch ? [carton] : []);
  const paperRates = cartonPaperRates(engineering);
  let row = startRow;
  // 成本明细占 A:D；纸箱计算放在 J:N，中间保留 E:I 五列空白，兼顾距离与可见性。
  const panelStartColumn = 10;
  const lengthColumn = ws.getColumn(panelStartColumn + 1).letter;
  const widthColumn = ws.getColumn(panelStartColumn + 2).letter;
  const heightColumn = ws.getColumn(panelStartColumn + 3).letter;
  const quantityColumn = ws.getColumn(panelStartColumn + 4).letter;
  cartons.forEach((box, index) => {
    const sourceName = text(box.name || box.label || box.ka_label) || `纸箱${index + 1}`;
    const blockName = /内箱/.test(sourceName)
      ? sourceName
      : (/外箱|主纸箱/.test(sourceName) ? `外箱${sourceName === '主纸箱' ? '（主纸箱）' : ''}` : sourceName);
    const productL = number(box.pl ?? box.product_l ?? carton.pl);
    const productW = number(box.pw ?? box.product_w ?? carton.pw);
    const productH = number(box.ph ?? box.product_h ?? carton.ph);
    const cartonL = number(box.cl ?? box.l);
    const cartonW = number(box.cw ?? box.w);
    const cartonH = number(box.ch ?? box.h);
    const cartonQty = number(box.qty, 1);
    const cuft = cartonL * cartonW * cartonH / 1728;
    const isInner = /内箱/.test(sourceName);
    const paperRate = number(box.paper_rate, isInner ? paperRates.inner : paperRates.main);
    const boxPrice = (cartonL + cartonW + 2) * (cartonW + cartonH + 1) * 2 * paperRate / 1000;

    [blockName, 'L', 'W', 'H', ''].forEach((value, offset) => writeDetailCell(ws, row, panelStartColumn + offset, value, {
      bold: true,
      color: TEMPLATE_BLUE,
      fill: 'FFF2F6FC',
      horizontal: offset === 0 ? 'left' : 'center',
      wrap: false,
    }));
    row += 1;

    ['产品尺寸inch:', productL, productW, productH, ''].forEach((value, offset) => writeDetailCell(ws, row, panelStartColumn + offset, value, {
      horizontal: offset === 0 ? 'left' : 'center',
      numFmt: offset === 0 || offset === 4 ? undefined : '0.000',
    }));
    row += 1;

    const cartonDimensionRow = row;
    ['纸箱尺寸inch:', cartonL, cartonW, cartonH, ''].forEach((value, offset) => writeDetailCell(ws, row, panelStartColumn + offset, value, {
      horizontal: offset === 0 ? 'left' : 'center',
      numFmt: offset === 0 || offset === 4 ? undefined : '0.000',
    }));
    row += 1;

    const cartonSummaryRow = row;
    const paperRateCell = isInner ? '$G$7' : '$E$7';
    [
      'CU.FT:',
      {
        formula: `${lengthColumn}${cartonDimensionRow}*${widthColumn}${cartonDimensionRow}*${heightColumn}${cartonDimensionRow}/1728`,
        result: Number(cuft.toFixed(2)),
      },
      '箱价',
      {
        formula: `(${lengthColumn}${cartonDimensionRow}+${widthColumn}${cartonDimensionRow}+2)*(${widthColumn}${cartonDimensionRow}+${heightColumn}${cartonDimensionRow}+1)*2*${paperRateCell}/1000`,
        result: Number(boxPrice.toFixed(4)),
      },
      cartonQty,
    ].forEach((value, offset) => writeDetailCell(ws, row, panelStartColumn + offset, value, {
      bold: offset === 0 || offset === 2 || offset === 4,
      color: offset === 0 || offset === 2 || offset === 4 ? TEMPLATE_BLUE : TEMPLATE_BLACK,
      horizontal: 'center',
      numFmt: offset === 1 ? '0.00'
        : offset === 3 ? '0.0000'
          : offset === 4 ? '"数量: "0.###' : undefined,
    }));
    ['纸箱长 L','纸箱宽 W','纸箱高 H'].forEach((label,i)=>{ws.getCell(cartonDimensionRow,panelStartColumn+1+i).outputLabel=sourceName+' · '+label;});
    ws.getCell(cartonSummaryRow,panelStartColumn+4).outputLabel=sourceName+' · 装箱数量';
    ws.getCell(cartonSummaryRow,panelStartColumn+3).outputLabel=sourceName+' · 箱价';
    if (!metrics.cuftCell && !isInner) {
      metrics.cuftCell = `${lengthColumn}${cartonSummaryRow}`;
      metrics.quantityCell = `${quantityColumn}${cartonSummaryRow}`;
      metrics.cuft = cuft;
      metrics.quantity = Math.max(cartonQty, 1);
    }
    row += 1;

    let flatPriceTotal = 0;
    const flatPriceRows = [];
    for (const [flatIndex, card] of (box.flat_cards || []).entries()) {
      const flatL = number(card.l || box.cl);
      const flatW = number(card.w || box.cw);
      const flatQty = number(card.qty, 1);
      const flatUnitPrice = (flatL + 1) * (flatW + 1) * 2 / 1000;
      const flatPrice = flatUnitPrice * flatQty;
      flatPriceTotal += flatPrice;
      flatPriceRows.push(row);
      [
        text(card.name) || `平卡${flatIndex + 1}`,
        flatL,
        flatW,
        {
          formula: `(${lengthColumn}${row}+1)*(${widthColumn}${row}+1)*2/1000*${quantityColumn}${row}`,
          result: flatPrice,
        },
        flatQty,
      ]
        .forEach((value, offset) => writeDetailCell(ws, row, panelStartColumn + offset, value, {
          color: offset >= 3 ? TEMPLATE_BLUE : TEMPLATE_BLACK,
          horizontal: offset === 0 ? 'left' : 'center',
          numFmt: [1, 2].includes(offset) ? '0.000'
            : offset === 3 ? '0.0000'
              : offset === 4 ? '"用量: "0.###' : undefined,
        }));
      ['平卡长 L','平卡宽 W','平卡费用','平卡用量'].forEach((label,i)=>{ws.getCell(row,panelStartColumn+1+i).outputLabel=(text(card.name)||`平卡${flatIndex+1}`)+' · '+label;});
      row += 1;
    }

    const unitCartonPrice = (boxPrice + flatPriceTotal) / Math.max(cartonQty, 1);
    const flatPriceFormula = flatPriceRows.length
      ? `+SUM(${heightColumn}${flatPriceRows[0]}:${heightColumn}${flatPriceRows[flatPriceRows.length - 1]})`
      : '';
    [
      '箱价/件',
      {
        formula: `(${heightColumn}${cartonSummaryRow}${flatPriceFormula})/${quantityColumn}${cartonSummaryRow}`,
        result: Number(unitCartonPrice.toFixed(4)),
      },
      '',
      '（箱价+平卡）÷数量',
      '',
    ].forEach((value, offset) => (
      writeDetailCell(ws, row, panelStartColumn + offset, value, {
        bold: offset === 0 || offset === 1,
        color: offset <= 1 ? TEMPLATE_BLUE : TEMPLATE_BLACK,
        horizontal: offset === 3 ? 'left' : 'center',
        numFmt: offset === 1 ? '0.0000' : undefined,
      })
    ));
    unitPriceCells.push(`${lengthColumn}${row}`);
    row += 1;
    row += 1;
  });
  if (!cartons.length) {
    ['纸箱', 'L', 'W', 'H', ''].forEach((value, offset) => writeDetailCell(ws, row, panelStartColumn + offset, value, {
      bold: true, color: TEMPLATE_BLUE, fill: 'FFF2F6FC',
    }));
    row += 1;
    ['待填写', '', '', '', ''].forEach((value, offset) => writeDetailCell(ws, row, panelStartColumn + offset, value, {
      color: 'FF7A869A', horizontal: offset === 0 ? 'left' : 'center',
    }));
    row += 2;
  }
  return Math.max(startRow, row - 1);
}

function writeSummaryBand(ws, startRow, title, entries) {
  ws.mergeCells(startRow, 1, startRow, 18);
  const titleCell = ws.getCell(startRow, 1);
  titleCell.value = title;
  styleCell(titleCell, {
    color: TEMPLATE_BLUE,
    fill: TEMPLATE_YELLOW,
    bold: true,
    size: 10,
    border: 'medium',
    wrap: false,
  });
  const chunks = [];
  for (let index = 0; index < entries.length; index += 6) chunks.push(entries.slice(index, index + 6));
  let row = startRow + 1;
  for (const chunk of chunks) {
    chunk.forEach(([label], index) => {
      const column = 1 + index * 3;
      ws.mergeCells(row, column, row, column + 2);
      writeDetailCell(ws, row, column, label, {
        color: TEMPLATE_RED,
        fill: 'FFF2F6FC',
        bold: true,
        wrap: false,
      });
    });
    chunk.forEach(([, value], index) => {
      const column = 1 + index * 3;
      ws.mergeCells(row + 1, column, row + 1, column + 2);
      const cellValue = value && typeof value === 'object' && Object.hasOwn(value, 'formula')
        ? value : number(value);
      writeDetailCell(ws, row + 1, column, cellValue, {
        color: TEMPLATE_BLUE,
        numFmt: '0.0000',
        wrap: false,
      });
    });
    row += 2;
  }
  return row - 1;
}

const REFERENCE_FREIGHT_SCENARIOS = [
  { name: '盐田40柜', key: 'yt40', capKey: 'cap_40' },
  { name: '盐田5吨车', key: 'yt5t', capKey: 'cap_5t' },
];

const DEFAULT_REFERENCE_FREIGHT_CALC = {
  cap_10t: 1166, cap_5t: 750, cap_40: 1980, cap_20: 883,
  hk40: 8000, hk20: 7100, yt40: 7200, yt20: 6000,
  hk10t: 14900, yt10t: 11500, hk5t: 12500, yt5t: 11000,
};

const FULL_REFERENCE_FREIGHT_SCENARIOS = [
  { name: 'HK40柜', key: 'hk40', capKey: 'cap_40' },
  { name: 'HK20柜', key: 'hk20', capKey: 'cap_20' },
  { name: 'YT40柜', key: 'yt40', capKey: 'cap_40' },
  { name: 'YT20柜', key: 'yt20', capKey: 'cap_20' },
  { name: 'HK10吨', key: 'hk10t', capKey: 'cap_10t' },
  { name: 'YT10吨', key: 'yt10t', capKey: 'cap_10t' },
  { name: 'HK5吨', key: 'hk5t', capKey: 'cap_5t' },
  { name: 'YT5吨', key: 'yt5t', capKey: 'cap_5t' },
];

function referenceFreightCalc(sales) {
  return { ...DEFAULT_REFERENCE_FREIGHT_CALC, ...(sales.freight_calc || {}) };
}

function referenceFreightRates(sales, engineering) {
  const freightCalc = referenceFreightCalc(sales);
  const basis = cartonShippingBasis(engineering);
  const cuft = Math.max(number(basis.cuft), 0.01);
  const quantity = Math.max(number(basis.quantity), 1);
  const rates = {};
  FULL_REFERENCE_FREIGHT_SCENARIOS.forEach(definition => {
    const cartons = Math.max(Math.round(number(freightCalc[definition.capKey]) / cuft), 1);
    rates[definition.key] = number(freightCalc[definition.key]) / cartons / quantity;
  });
  return { freightCalc, basis: { cuft, quantity }, rates };
}

function selectedReferenceFreightKey(sales, rates, currentRate) {
  const shipping = sales.shipping || {};
  const explicit = text(shipping.container_key || shipping.selected_container);
  if (rates[explicit] != null) return explicit;
  const supplied = Array.isArray(shipping.scenarios)
    ? shipping.scenarios.find(item => !item.is_factory) : null;
  const suppliedKey = freightScenarioKey(supplied && supplied.name);
  if (rates[suppliedKey] != null) return suppliedKey;
  if (currentRate > 0) {
    return Object.keys(rates).sort((left, right) => (
      Math.abs(rates[left] - currentRate) - Math.abs(rates[right] - currentRate)
    ))[0];
  }
  return 'yt40';
}

function freightScenarioKey(name) {
  const value = text(name);
  const prefix = /盐田|YT/i.test(value) ? 'yt' : 'hk';
  if (/40\s*柜|40['"\s]*[尺呎]?/i.test(value)) return `${prefix}40`;
  if (/20\s*柜|20['"\s]*[尺呎]?/i.test(value)) return `${prefix}20`;
  if (/10\s*吨/i.test(value)) return `${prefix}10t`;
  if (/5\s*吨/i.test(value)) return `${prefix}5t`;
  return '';
}

function cartonShippingBasis(engineering) {
  const carton = engineering.carton_calc || {};
  const boxes = Array.isArray(carton.cartons) ? carton.cartons : [];
  const box = boxes.find(item => /主纸箱|外箱/.test(text(item.name || item.label))) || boxes[0] || carton;
  const cuft = number(box.cuft ?? carton.cuft)
    || number(box.cl ?? box.l ?? carton.cl) * number(box.cw ?? box.w ?? carton.cw) * number(box.ch ?? box.h ?? carton.ch) / 1728;
  return { cuft, quantity: Math.max(number(box.qty ?? carton.qty, 1), 1) };
}

function referenceMoqTiers(sales) {
  const shipping = sales.shipping || {};
  const candidates = shipping.moq_tiers ?? shipping.moqs
    ?? (sales.pricing_summary && sales.pricing_summary.moq_tiers);
  if (!Array.isArray(candidates)) return [3000];
  const tiers = candidates.map(item => {
    if (item && typeof item === 'object' && item.enabled === false) return 0;
    return number(item && typeof item === 'object' ? (item.moq ?? item.qty ?? item.value) : item);
  }).filter(value => value > 0);
  return tiers.length ? [...new Set(tiers)].sort((left, right) => left - right) : [3000];
}

function buildReferenceShippingPricing(ws, sales, engineering, startRow, costTotalRow, total) {
  const shipping = sales.shipping || {};
  const freightCalc = referenceFreightCalc(sales);
  const supplied = Array.isArray(shipping.scenarios)
    ? shipping.scenarios.filter(item => !item.is_factory) : [];
  const basis = cartonShippingBasis(engineering);
  const freightPct = number(shipping.freight_pct, 48) / 100;
  const liftingPct = number(shipping.lifting_pct, 52) / 100;
  const markup = number(shipping.markup_x, 1.2);
  const divisor = number(shipping.divisor, 0.98) || 0.98;
  const fx = number(sales.header && sales.header.fx_hkd_usd, 7.8) || 7.8;
  const moldCosts = engineering.mold_costs || {};
  const testingFee = number(moldCosts.testing_fee_usd ?? moldCosts.testing_fee_rmb);
  const hasTestingFee = testingFee > 0;
  const visibleScenarios = Array.isArray(shipping.scenarios) ? supplied : REFERENCE_FREIGHT_SCENARIOS;
  const definitions = visibleScenarios.map(scenario => {
    const key = freightScenarioKey(scenario.name) || scenario.key;
    const type = /40$/.test(key) ? '40' : /20$/.test(key) ? '20' : /10t$/.test(key) ? '10t' : '5t';
    const capacity = number(freightCalc[`cap_${type}`]);
    const cartons = Math.max(Math.round(capacity / Math.max(basis.cuft, 0.0001)), 1);
    const configuredWholeFee = number(freightCalc[key]);
    const scenarioUnitFee = number(scenario._freight_rate ?? scenario.freight_hkd ?? scenario.freight);
    const wholeFee = Object.hasOwn(freightCalc, key) ? configuredWholeFee : scenarioUnitFee * cartons * basis.quantity;
    const wholeFreight = wholeFee * freightPct;
    const wholeLifting = wholeFee * liftingPct;
    return {
      name: text(scenario.name),
      key,
      capacity,
      cartons,
      wholeFreight,
      wholeLifting,
      freight: wholeFreight / cartons / basis.quantity,
      lifting: wholeLifting / cartons / basis.quantity,
    };
  });
  const scenarios = [{ name: '出厂价', key: '', capacity: 0, cartons: 0, wholeFreight: 0, wholeLifting: 0, freight: 0, lifting: 0 }, ...definitions];

  const writeLeftRow = (row, label, values, options = {}) => {
    ws.mergeCells(row, 2, row, 3);
    writeDetailCell(ws, row, 2, label, {
      horizontal: 'left', bold: Boolean(options.bold), color: options.color || TEMPLATE_BLACK,
      fill: options.fill, wrap: false,
    });
    values.forEach((value, index) => writeDetailCell(ws, row, 4 + index, value, {
      bold: Boolean(options.bold), color: options.color || TEMPLATE_BLACK,
      fill: options.fill, numFmt: options.numFmt, wrap: false,
    }));
  };

  writeLeftRow(startRow, '运输方案', scenarios.map(item => item.name), { bold: true, fill: 'FFFFF2CC' });
  const freightRow = startRow + 1;
  const liftingRow = startRow + 2;
  writeLeftRow(freightRow, '运费', scenarios.map(item => item.freight), { numFmt: '0.0000' });
  writeLeftRow(liftingRow, '吊柜费', scenarios.map(item => item.lifting), { numFmt: '0.0000' });

  const baseRow = startRow + 3;
  const baseResults = scenarios.map(item => total + item.freight + item.lifting);
  writeLeftRow(baseRow, '报价基数', scenarios.map((item, index) => ({
    formula: index === 0 ? `D${costTotalRow}` : `$D$${costTotalRow}+${ws.getColumn(4 + index).letter}${freightRow}+${ws.getColumn(4 + index).letter}${liftingRow}`,
    result: baseResults[index],
  })), { bold: true, numFmt: '0.0000' });

  const moqTiers = referenceMoqTiers(sales);
  const quoteRows = [];
  const usdRows = [];
  const includedRows = [];
  const tierRowCount = hasTestingFee ? 6 : 5;
  moqTiers.forEach((moq, groupIndex) => {
    const multiplierRow = baseRow + 1 + groupIndex * tierRowCount;
    const divisorRow = multiplierRow + 1;
    const quoteRow = multiplierRow + 2;
    const usdRow = multiplierRow + 3;
    const includedRow = multiplierRow + 4;
    writeLeftRow(multiplierRow, '× 码点', scenarios.map(() => markup), { numFmt: '0.00' });
    writeLeftRow(divisorRow, '÷ 找数', scenarios.map(() => divisor), { numFmt: '0.0000' });
    const quotedResults = baseResults.map(value => value * markup / divisor);
    writeLeftRow(quoteRow, `报价（MOQ${moq / 1000}K）`, scenarios.map((_, index) => {
      const column = ws.getColumn(4 + index).letter;
      return { formula: `${column}${baseRow}*${column}${multiplierRow}/${column}${divisorRow}`, result: quotedResults[index] };
    }), { bold: true, numFmt: '0.00' });
    const usdResults = quotedResults.map(value => value / fx);
    writeLeftRow(usdRow, '报价（USD）', scenarios.map((_, index) => {
      const column = ws.getColumn(4 + index).letter;
      return { formula: `${column}${quoteRow}/${fx}`, result: usdResults[index] };
    }), { bold: true, numFmt: '0.00' });
    if (hasTestingFee) {
      const testingShare = testingFee / moq;
      writeLeftRow(includedRow, '包含测试费用（USD）', scenarios.map((_, index) => {
        const column = ws.getColumn(4 + index).letter;
        return { formula: `${column}${usdRow}+$O$${startRow + 1 + groupIndex}`, result: usdResults[index] + testingShare };
      }), { bold: true, numFmt: '0.00' });
      includedRows.push(includedRow);
    }
    quoteRows.push(quoteRow);
    usdRows.push(usdRow);
  });

  if (hasTestingFee) {
    writeDetailCell(ws, startRow, 14, '测试费用', { horizontal: 'left', bold: true, fill: 'FFF2F6FC', wrap: false });
    writeDetailCell(ws, startRow, 15, testingFee, { numFmt: '0.00', wrap: false });
    moqTiers.forEach((moq, index) => {
      writeDetailCell(ws, startRow + 1 + index, 14, moq, { numFmt: '#,##0', wrap: false });
      writeDetailCell(ws, startRow + 1 + index, 15, testingFee / moq, { numFmt: '0.0000', wrap: false });
      writeDetailCell(ws, startRow + 1 + index, 16, { formula: `O${startRow + 1 + index}*D${startRow + 4 + index * tierRowCount}`, result: testingFee / moq * markup }, { numFmt: '0.0000', wrap: false });
    });
  }
  return {
    endRow: (hasTestingFee ? includedRows[includedRows.length - 1] : usdRows[usdRows.length - 1]) || baseRow,
    quoteRows,
    usdRows,
    includedRows,
    freightRow,
    liftingRow,
    scenarioKeys: scenarios.map(item => item.key),
    scenarioResults: scenarios.map(item => ({ freight: item.freight, lifting: item.lifting })),
  };
}

function buildReferenceFreightCalculationPanel(ws, sales, engineering, startRow, metrics = {}) {
  const freightCalc = referenceFreightCalc(sales);
  const basis = cartonShippingBasis(engineering);
  const cuft = Math.max(number(metrics.cuft, basis.cuft), 0.01);
  const quantity = Math.max(number(metrics.quantity, basis.quantity), 1);

  ws.mergeCells(startRow, 2, startRow, 6);
  writeDetailCell(ws, startRow, 2, '运费计算(HK$)', {
    bold: true, fill: 'FFF2F6FC', border: 'medium', wrap: false,
  });

  const parameterRows = [
    ['cuft', '1箱的CUFT：', metrics.cuftCell
      ? { formula: metrics.cuftCell, result: cuft } : cuft, 'CUFT', '0.00'],
    ['quantity', '1箱装的个数：', metrics.quantityCell
      ? { formula: metrics.quantityCell, result: quantity } : quantity, 'PCS', '0'],
    ['cap_10t', '10吨车：', freightCalc.cap_10t, 'CUFT', '0'],
    ['cap_5t', '5吨车：', freightCalc.cap_5t, 'CUFT', '0'],
    ['cap_40', "40'：", freightCalc.cap_40, 'CUFT', '0'],
    ['cap_20', "20'：", freightCalc.cap_20, 'CUFT', '0'],
    ['hk40', 'HK 40柜运费+吊柜费', freightCalc.hk40, 'HK$', '#,##0'],
    ['hk20', 'HK 20柜运费+吊柜费', freightCalc.hk20, 'HK$', '#,##0'],
    ['yt40', 'YT 40柜运费+吊柜费', freightCalc.yt40, 'HK$', '#,##0'],
    ['yt20', 'YT 20柜运费+吊柜费', freightCalc.yt20, 'HK$', '#,##0'],
    ['hk10t', 'HK10吨运费', freightCalc.hk10t, 'HK$', '#,##0'],
    ['yt10t', 'YT10吨运费', freightCalc.yt10t, 'HK$', '#,##0'],
    ['hk5t', 'HK5吨运费', freightCalc.hk5t, 'HK$', '#,##0'],
    ['yt5t', 'YT5吨运费', freightCalc.yt5t, 'HK$', '#,##0'],
  ];
  const parameterCells = {};
  let row = startRow + 1;
  parameterRows.forEach(([key, label, value, unit, numFmt]) => {
    writeDetailCell(ws, row, 2, label, { horizontal: 'left', wrap: false });
    const valueCell = writeDetailCell(ws, row, 3, value, { numFmt, wrap: false });
    // 容量与整柜费用是业务部 freight_calc 的原始参数。它们即使被
    // MAX/ROUND 等本地公式引用，也必须在报价明细预览中保持可编辑。
    if (!valueCell.formula) valueCell.outputEditable = true;
    writeDetailCell(ws, row, 4, unit, { wrap: false });
    writeDetailCell(ws, row, 5, '', { wrap: false });
    writeDetailCell(ws, row, 6, '', { wrap: false });
    parameterCells[key] = valueCell.address;
    row += 1;
  });

  const rateCells = {};
  const rateResults = {};
  const renderGroup = definitions => {
    row += 1;
    definitions.forEach((definition, index) => {
      writeDetailCell(ws, row, 2 + index, definition.name, {
        bold: true, fill: 'FFF2F6FC', wrap: false,
      });
    });
    writeDetailCell(ws, row, 6, '', { fill: 'FFF2F6FC', wrap: false });
    row += 1;

    const boxesRow = row;
    definitions.forEach((definition, index) => {
      const capacity = number(freightCalc[definition.capKey]);
      const cartons = Math.max(Math.round(capacity / cuft), 1);
      writeDetailCell(ws, row, 2 + index, {
        formula: `MAX(ROUND(${parameterCells[definition.capKey]}/MAX(${parameterCells.cuft},0.01),0),1)`,
        result: cartons,
      }, { numFmt: '0', wrap: false });
    });
    writeDetailCell(ws, row, 6, '总箱数', { bold: true, wrap: false });
    row += 1;

    definitions.forEach((definition, index) => {
      const column = ws.getColumn(2 + index).letter;
      const fee = number(freightCalc[definition.key]);
      const cartons = Math.max(Math.round(number(freightCalc[definition.capKey]) / cuft), 1);
      const result = fee / cartons / quantity;
      const cell = writeDetailCell(ws, row, 2 + index, {
        formula: `${parameterCells[definition.key]}/${column}${boxesRow}/MAX(${parameterCells.quantity},1)`,
        result,
      }, { numFmt: '0.0000', color: TEMPLATE_BLUE, wrap: false });
      rateCells[definition.key] = cell.address;
      rateResults[definition.key] = result;
    });
    writeDetailCell(ws, row, 6, '运+吊柜/件', { bold: true, wrap: false });
    row += 1;
  };

  renderGroup(FULL_REFERENCE_FREIGHT_SCENARIOS.slice(0, 4));
  renderGroup(FULL_REFERENCE_FREIGHT_SCENARIOS.slice(4));
  return { endRow: row - 1, rateCells, rateResults, parameterCells };
}

function writeCompactSummaryBand(ws, row, title, headers, values, options = {}) {
  writeDetailCell(ws, row, 3, title, {
    bold: true, fill: options.titleFill || 'FFFFC000', wrap: false,
  });
  headers.forEach((header, index) => writeDetailCell(ws, row, 4 + index, header, {
    color: options.headerColor || TEMPLATE_BLACK,
    fill: options.headerFill || TEMPLATE_YELLOW,
    bold: true, wrap: false,
  }));
  writeDetailCell(ws, row + 1, 3, options.valueLabel || '', { wrap: false });
  values.forEach((value, index) => writeDetailCell(ws, row + 1, 4 + index, value, {
    color: options.valueColor || TEMPLATE_BLUE,
    bold: Boolean(options.boldValues), numFmt: options.numFmt || '0.0000', wrap: false,
  }));
  return row + 1;
}

function buildReferenceLowerSections(ws, quote, sections, payloads, afterRow, sourceSheet, preparedCosts) {
  const costs = preparedCosts || calculateQuoteCosts(quote || {}, sections || []);
  const components = costs.components || {};
  const salesPayload = payloads.sales || {};
  const shipping = salesPayload.shipping || {};
  const freightRateData = referenceFreightRates(salesPayload, payloads.engineering || {});
  const selectedFreightKey = selectedReferenceFreightKey(
    salesPayload,
    freightRateData.rates,
    number(components.freight) + number(components.cabinet)
  );
  const selectedFreightRate = number(freightRateData.rates[selectedFreightKey]);
  const freightPct = number(shipping.freight_pct, 48) / 100;
  const liftingPct = number(shipping.lifting_pct, 52) / 100;
  components.freight = selectedFreightRate * freightPct;
  components.cabinet = selectedFreightRate * liftingPct;
  const detailRows = componentRows(costs, payloads, quote);
  const startRow = afterRow + 3;

  ws.mergeCells(startRow, 1, startRow, 12);
  const title = ws.getCell(startRow, 1);
  title.value = '成本明细（外购、喷油、电子、包装及人工）';
  styleCell(title, {
    color: TEMPLATE_BLUE, fill: TEMPLATE_YELLOW, bold: true, border: 'medium', wrap: false,
  });
  ['税类', '类别', '项目', 'HKD/件'].forEach((header, index) => writeDetailCell(ws, startRow + 1, index + 1, header, {
    color: TEMPLATE_RED, fill: 'FFF2F6FC', bold: true, wrap: false,
  }));
  let row = startRow + 2;
  const rendered = detailRows.length ? detailRows : [['', '成本', '当前报价暂无成本数据', 0]];
  const componentCells = new Map();
  const upperCostLinks = upperQuotationCostLinks(ws, payloads.molding || {}, afterRow);
  for (const key of ['imp_mat', 'dom_mat', 'injection_labor']) {
    components[key] = upperCostLinks.get(key).result;
  }
  const componentDepartments = {
    imp_mat: 'molding', dom_mat: 'molding', injection_labor: 'molding', blow: 'molding',
    painting_labor: 'painting', paint_material: 'painting', assembly_labor: 'assembly',
    semi_finished: 'assembly', slush: 'slush', sewing_hair: 'sewing', sewing_cloth: 'sewing',
    electronic: 'electronic', hardware: 'engineering', motor: 'engineering', suction: 'engineering',
    glue_bag: 'engineering', color_box: 'engineering', battery: 'engineering', libao: 'engineering',
    plating: 'engineering', flocking: 'engineering', other_buy: 'engineering', carton: 'engineering',
    indo_freight: 'molding', surtax: 'sales',
  };
  rendered.forEach(values => {
    const keys = values[4] || [];
    const renderedValues = values.slice(0, 4);
    if (keys.length === 1 && upperCostLinks.has(keys[0])) {
      renderedValues[3] = upperCostLinks.get(keys[0]);
    }
    renderedValues.forEach((value, index) => writeDetailCell(ws, row, index + 1, value, {
      horizontal: index === 2 ? 'left' : 'center',
      numFmt: index === 3 ? '0.0000' : undefined,
    }));
    ws.getCell(row, 4).outputDepartment = componentDepartments[keys[0]] || null;
    ws.getCell(row, 4).outputSourceIdentity = values;
    if (values[5]?.calculation) {
      Object.defineProperty(ws.getCell(row, 4), 'outputCalculation', {
        value: { ...values[5].calculation }, writable: true, configurable: true,
      });
    }
    for (const key of keys) {
      if (!componentCells.has(key)) componentCells.set(key, []);
      componentCells.get(key).push(`D${row}`);
    }
    row += 1;
  });
  // 运费和吊柜费由下方“运输方案”按柜型加入，不在上方直接成本里重复计算。
  const total = costComponentTotal(costs)
    - number(components.freight)
    - number(components.cabinet);
  const costTotalRow = row;
  ws.mergeCells(row, 1, row, 3);
  writeDetailCell(ws, row, 1, '直接成本合计', { color: TEMPLATE_BLUE, bold: true, wrap: false });
  writeDetailCell(ws, row, 4, {
    formula: `SUM(D${startRow + 2}:D${row - 1})`,
    result: total,
  }, { color: TEMPLATE_RED, bold: true, numFmt: '0.0000' });

  const linkedComponent = (keys, result) => {
    const addresses = keys.flatMap(key => componentCells.get(key) || []);
    if (!addresses.length) return number(result);
    return {
      formula: addresses.length === 1 ? addresses[0] : `SUM(${addresses.join(',')})`,
      result: number(result),
    };
  };

  const cartonUnitPriceCells = [];
  const cartonMetrics = {};
  const cartonEnd = buildCartonPanel(
    ws, payloads.engineering || {}, startRow + 1, cartonUnitPriceCells, cartonMetrics
  );
  for (let r = startRow + 1; r <= cartonEnd; r++) {
    for (let c = 10; c <= 14; c++) ws.getCell(r, c).outputDepartment = 'engineering';
  }
  const cartonComponentAddress = (componentCells.get('carton') || [])[0];
  if (cartonComponentAddress && cartonUnitPriceCells.length) {
    ws.getCell(cartonComponentAddress).value = {
      formula: cartonUnitPriceCells.length === 1 ? cartonUnitPriceCells[0] : `SUM(${cartonUnitPriceCells.join(',')})`,
      result: number(components.carton),
    };
  }
  const laborTotal = number(components.injection_labor) + number(components.painting_labor) + number(components.assembly_labor);
  const lowerStart = Math.max(row, cartonEnd) + 2;
  const pricing = buildReferenceShippingPricing(
    ws, salesPayload, payloads.engineering || {}, lowerStart, costTotalRow, total
  );
  for (let r = lowerStart; r <= pricing.endRow; r++) ws.getRow(r).eachCell(c => { c.outputDepartment = 'sales'; });
  const selectedQuoteRow = pricing.quoteRows[pricing.quoteRows.length - 1];
  const firstPriceCell = ws.getCell(selectedQuoteRow, 4);
  const quotedPrice = number(
    firstPriceCell.result ?? (firstPriceCell.value && firstPriceCell.value.result),
    costs.quotedPrice
  );
  const profit = quotedPrice - total;
  const nonLabor = total - laborTotal;
  const tax13Keys = ['dom_mat', 'hardware', 'motor', 'color_box', 'battery', 'libao', 'flocking', 'other_buy', 'paint_material', 'glue_bag'];
  const tax13Total = tax13Keys.reduce((sum, key) => sum + number(components[key]), 0);
  const sewingTaxShares = require('../../frontend/sewing-tax').fractions(payloads.sewing || {}, quote.customer);
  const sewingHairTaxable = number(components.sewing_hair) * number(sewingTaxShares.sewing_hair);
  const sewingClothTaxable = number(components.sewing_cloth) * number(sewingTaxShares.sewing_cloth);
  const taxSavings = number(components.plating) * 0.0099 + number(components.slush) * 0.03
    + sewingHairTaxable * 0.115 + sewingClothTaxable * 0.115
    + number(components.suction) * 0.06 + number(components.freight) * 0.0826
    + tax13Total * 0.115 + number(components.carton) / 1.1 * 0.115;
  // 底部汇总必须沿用本张“报价明细”的报价公式链，不再跨表拉取系统汇总。
  const selectedPrice = { formula: `D${selectedQuoteRow}`, result: quotedPrice };
  const summaryStart = pricing.endRow + 2;
  const firstValueRow = summaryStart + 1;
  const secondStart = firstValueRow + 2;
  const secondValueRow = secondStart + 1;
  const thirdStart = secondValueRow + 2;
  const thirdValueRow = thirdStart + 1;
  const fourthStart = thirdValueRow + 2;
  const fourthValueRow = fourthStart + 1;
  const fourthRateRow = fourthValueRow + 1;
  const fourthDeductionRow = fourthRateRow + 1;
  const fifthStart = fourthDeductionRow + 2;
  const fifthValueRow = fifthStart + 1;
  const afterCost = total - taxSavings;
  const afterGross = quotedPrice - nonLabor + taxSavings;
  const afterProfit = profit + taxSavings;

  writeCompactSummaryBand(ws, summaryStart, '一、出厂货价核',
    ['货价', '进口料', '国内料', '吹气', '搪胶', '车发', '车衣', '五金', '电子', '马达', '吸塑', '胶袋'],
    [
      selectedPrice,
      linkedComponent(['imp_mat'], components.imp_mat),
      linkedComponent(['dom_mat'], components.dom_mat),
      linkedComponent(['blow'], components.blow),
      linkedComponent(['slush'], components.slush),
      linkedComponent(['sewing_hair'], components.sewing_hair),
      linkedComponent(['sewing_cloth'], components.sewing_cloth),
      linkedComponent(['hardware'], components.hardware),
      linkedComponent(['electronic'], components.electronic),
      linkedComponent(['motor'], components.motor),
      linkedComponent(['suction'], components.suction),
      linkedComponent(['glue_bag'], components.glue_bag),
    ], { boldValues: true, numFmt: '0.0000' });

  writeCompactSummaryBand(ws, secondStart, '二、包装 / 外购',
    ['彩盒/内咭', '未减税前码数', '减税后码数', '电池', '利宝', '电镀', '植绒', '其他外购', '纸箱', '运费', '吊柜费', '杂项'],
    [
      linkedComponent(['color_box'], components.color_box),
      { formula: `IFERROR(D${firstValueRow}/N${thirdValueRow},0)`, result: total ? quotedPrice / total : 0 },
      { formula: `IFERROR(D${firstValueRow}/E${fifthValueRow},0)`, result: afterCost ? quotedPrice / afterCost : 0 },
      linkedComponent(['battery'], components.battery),
      linkedComponent(['libao'], components.libao),
      linkedComponent(['plating'], components.plating),
      linkedComponent(['flocking'], components.flocking),
      linkedComponent(['other_buy'], components.other_buy),
      linkedComponent(['carton'], components.carton),
      linkedComponent(['freight'], components.freight),
      linkedComponent(['cabinet'], components.cabinet),
      linkedComponent(['indo_freight', 'surtax'], components.misc),
    ], { numFmt: '0.0000' });

  writeCompactSummaryBand(ws, thirdStart, '三、人工 & 成本汇总',
    ['啤工', '喷油工', '油漆', '装配工', '不含人工成本', '人工比例', '毛利', '毛利率', '利润', '利润率', '总成本'],
    [
      linkedComponent(['injection_labor'], components.injection_labor),
      linkedComponent(['painting_labor'], components.painting_labor),
      linkedComponent(['paint_material'], components.paint_material),
      linkedComponent(['assembly_labor'], components.assembly_labor),
      // 运费、吊柜费由运输方案加入，不计入产品直接成本。
      { formula: `SUM(E${firstValueRow}:O${firstValueRow},D${secondValueRow},G${secondValueRow}:L${secondValueRow},O${secondValueRow},F${thirdValueRow})`, result: nonLabor },
      { formula: `IFERROR(SUM(D${thirdValueRow},E${thirdValueRow},G${thirdValueRow})/D${firstValueRow},0)`, result: quotedPrice ? laborTotal / quotedPrice : 0 },
      { formula: `D${firstValueRow}-H${thirdValueRow}`, result: quotedPrice - nonLabor },
      { formula: `IFERROR(J${thirdValueRow}/D${firstValueRow},0)`, result: quotedPrice ? (quotedPrice - nonLabor) / quotedPrice : 0 },
      { formula: `D${firstValueRow}-N${thirdValueRow}`, result: profit },
      { formula: `IFERROR(L${thirdValueRow}/D${firstValueRow},0)`, result: quotedPrice ? profit / quotedPrice : 0 },
      { formula: `H${thirdValueRow}+D${thirdValueRow}+E${thirdValueRow}+G${thirdValueRow}`, result: total },
    ], { numFmt: '0.0000' });
  ['I', 'K', 'M'].forEach(column => { ws.getCell(`${column}${thirdValueRow}`).numFmt = '0.00%'; });

  const taxHeaders = ['含税13%类成本', '纸箱类', '含税1%', '搪胶类3%', '车发类13%', '车衣类13%', '吸塑类6%', '运费类9%', '含税13%类', '合计减税'];
  // 减税基数只引用上方三块黄色汇总，不再越过汇总区直连成本明细。
  const yellowTax13Formula = `SUM(F${firstValueRow},K${firstValueRow},M${firstValueRow},O${firstValueRow},D${secondValueRow},G${secondValueRow},H${secondValueRow},J${secondValueRow},K${secondValueRow},F${thirdValueRow})`;
  const taxBases = [
    { formula: yellowTax13Formula, result: tax13Total },
    { formula: `L${secondValueRow}`, result: number(components.carton) },
    { formula: `I${secondValueRow}`, result: number(components.plating) },
    { formula: `H${firstValueRow}`, result: number(components.slush) },
    { formula: `I${firstValueRow}*${number(sewingTaxShares.sewing_hair)}`, result: sewingHairTaxable },
    { formula: `J${firstValueRow}*${number(sewingTaxShares.sewing_cloth)}`, result: sewingClothTaxable },
    { formula: `N${firstValueRow}`, result: number(components.suction) },
    { formula: `M${secondValueRow}`, result: number(components.freight) },
    { formula: yellowTax13Formula, result: tax13Total },
  ];
  const taxRates = [null, 0.115, 0.0099, 0.03, 0.115, 0.115, 0.06, 0.0826, 0.115];

  writeDetailCell(ws, fourthStart, 3, '四、减税明细', {
    bold: true, fill: 'FFFFC000', wrap: false,
  });
  taxHeaders.forEach((header, index) => writeDetailCell(ws, fourthStart, 4 + index, header, {
    color: TEMPLATE_BLACK, fill: 'FFDCE6F1', bold: true, wrap: false,
  }));
  writeDetailCell(ws, fourthValueRow, 3, '减税基数', { wrap: false });
  taxBases.forEach((value, index) => writeDetailCell(ws, fourthValueRow, 4 + index, value, {
    color: TEMPLATE_BLUE, numFmt: '0.0000', wrap: false,
  }));
  writeDetailCell(ws, fourthValueRow, 13, '', { wrap: false });

  writeDetailCell(ws, fourthRateRow, 3, '减税率', { wrap: false });
  taxRates.forEach((rate, index) => writeDetailCell(ws, fourthRateRow, 4 + index, rate === null ? '—' : rate, {
    color: TEMPLATE_BLUE, numFmt: rate === null ? undefined : '0.00%', wrap: false,
  }));
  writeDetailCell(ws, fourthRateRow, 13, '', { wrap: false });

  writeDetailCell(ws, fourthDeductionRow, 3, '减税值', { wrap: false });
  writeDetailCell(ws, fourthDeductionRow, 4, '—', { wrap: false });
  for (let column = 5; column <= 12; column += 1) {
    const letter = ws.getColumn(column).letter;
    const divisor = column === 5 ? '/1.1' : '';
    const baseResult = number(ws.getCell(fourthValueRow, column).result
      ?? ws.getCell(fourthValueRow, column).value?.result
      ?? ws.getCell(fourthValueRow, column).value);
    const rate = taxRates[column - 4];
    writeDetailCell(ws, fourthDeductionRow, column, {
      formula: `${letter}${fourthValueRow}${divisor}*${letter}${fourthRateRow}`,
      result: baseResult / (column === 5 ? 1.1 : 1) * rate,
    }, { color: TEMPLATE_BLUE, numFmt: '0.0000', wrap: false });
  }
  writeDetailCell(ws, fourthDeductionRow, 13, {
    formula: `SUM(E${fourthDeductionRow}:L${fourthDeductionRow})`, result: taxSavings,
  }, { color: TEMPLATE_BLUE, bold: true, numFmt: '0.0000', wrap: false });

  writeCompactSummaryBand(ws, fifthStart, '减税后结果',
    ['合计减税', '减税后成本', '减税后毛利', '减税后毛利率', '减税后利润', '减税后利润率'],
    [
      { formula: `M${fourthDeductionRow}`, result: taxSavings },
      { formula: `N${thirdValueRow}-D${fifthValueRow}`, result: afterCost },
      { formula: `J${thirdValueRow}+D${fifthValueRow}`, result: afterGross },
      { formula: `IFERROR(F${fifthValueRow}/D${firstValueRow},0)`, result: quotedPrice ? afterGross / quotedPrice : 0 },
      { formula: `L${thirdValueRow}+D${fifthValueRow}`, result: afterProfit },
      { formula: `IFERROR(H${fifthValueRow}/D${firstValueRow},0)`, result: quotedPrice ? afterProfit / quotedPrice : 0 },
    ], { headerFill: 'FFDCE6F1', numFmt: '0.0000' });
  ['G', 'I'].forEach(column => { ws.getCell(`${column}${fifthValueRow}`).numFmt = '0.00%'; });

  const freightPanel = buildReferenceFreightCalculationPanel(
    ws, salesPayload, payloads.engineering || {}, fifthValueRow + 2, cartonMetrics
  );

  for (let r = fifthValueRow + 2; r <= freightPanel.endRow; r++) ws.getRow(r).eachCell(c => { c.outputDepartment = 'sales'; });

  pricing.scenarioKeys.forEach((key, index) => {
    if (!key || !freightPanel.rateCells[key]) return;
    const column = ws.getColumn(4 + index).letter;
    const results = pricing.scenarioResults[index];
    ws.getCell(`${column}${pricing.freightRow}`).value = {
      formula: `${freightPanel.rateCells[key]}*${freightPct * 100}%`,
      result: results.freight,
    };
    ws.getCell(`${column}${pricing.liftingRow}`).value = {
      formula: `${freightPanel.rateCells[key]}*${liftingPct * 100}%`,
      result: results.lifting,
    };
  });

  const directRateCell = freightPanel.rateCells[selectedFreightKey];
  if (directRateCell) {
    ws.getCell(`M${secondValueRow}`).value = {formula:`${directRateCell}*${freightPct * 100}%`,result:components.freight};
    ws.getCell(`N${secondValueRow}`).value = {formula:`${directRateCell}*${liftingPct * 100}%`,result:components.cabinet};
    ws.getCell(`K${fourthValueRow}`).value = {formula:`M${secondValueRow}`,result:components.freight};
    const freightAddress = (componentCells.get('freight') || [])[0];
    const cabinetAddress = (componentCells.get('cabinet') || [])[0];
    if (freightAddress) ws.getCell(freightAddress).value = {
      formula: `${directRateCell}*${freightPct * 100}%`, result: components.freight,
    };
    if (cabinetAddress) ws.getCell(cabinetAddress).value = {
      formula: `${directRateCell}*${liftingPct * 100}%`, result: components.cabinet,
    };
  }
  return freightPanel.endRow;
}

function configureSheet(ws) {
  const widths = [6, 16, 18, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 16, 16, 16, 16, 16];
  widths.forEach((width, index) => { ws.getColumn(index + 1).width = width; });
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 9 }];
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  ws.pageMargins = { left: 0.2, right: 0.2, top: 0.3, bottom: 0.3, header: 0.1, footer: 0.1 };
  ws.properties.showGridLines = true;
}

async function buildOutputWorkbook(args) {
  const workbook = await buildLegacyWorkbook(args);
  const payloads = parseSections(args.sections);
  if (payloads.sales?.mixed_quote?.enabled || payloads.sales?.legacy_import?.excel_model
      || require('./productMix').injectionProductGroups(payloads.molding || {}).length) {
    // These formats already have their own source-preserving calculation model.
    // Do not flatten mixed product costs or imported formulas into the single
    // product detail layout, which would discard their calculation inputs.
    workbook.outputNotice = '此报价保留原有混装、分组或历史原表计算版式；请在对应部门修改资料。';
    Object.defineProperty(workbook, 'outputEditState', {value:{
      editable:new Set(), overridden:new Set(), signatures:new Map(),
      conflicts:(args.overrides || []).map(row => ({sheet_name:row.sheet_name,cell_address:row.cell_address,
        source_department:(()=>{try{return JSON.parse(row.value_json)?.source_department || null;}catch(_){return null;}})()})),
    }});
    return workbook;
  }
  const legacy = workbook.getWorksheet('报价明细');
  if (legacy) {
    legacy.name = '系统报价汇总';
    // 旧汇总页只保留为内部兼容数据，不在最终导出的工作表标签中展示。
    legacy.state = 'veryHidden';
  }
  const detail = workbook.addWorksheet('报价明细');
  configureSheet(detail);
  const costs = calculateQuoteCosts(args.quote || {}, args.sections || []);
  const molding = payloads.molding || {};
  buildReferenceBlock(detail, molding, payloads.sales || {}, payloads.assembly || {}, payloads.engineering || {});
  const totalRow = buildQuotationDetail(detail, args.quote || {}, molding);
  buildReferenceLowerSections(detail, args.quote || {}, args.sections || [], payloads, totalRow, legacy, costs);
  // “报价明细”是最终交付给用户的主表，工作表标签必须排在最前面。
  // ExcelJS 通过 orderNo 决定标签顺序；保留其他部门工作表的相对顺序。
  const remainingSheets = workbook.worksheets.filter(sheet => sheet.id !== detail.id);
  detail.orderNo = 0;
  remainingSheets.forEach((sheet, index) => { sheet.orderNo = index + 1; });
  const detailTabIndex = workbook.worksheets.findIndex(sheet => sheet.id === detail.id);
  workbook.views = [{
    activeTab: Math.max(detailTabIndex, 0),
    firstSheet: Math.max(detailTabIndex, 0),
    visibility: 'visible',
  }];
  workbook.calcProperties = { fullCalcOnLoad: true };
  workbook.outputEditableSheets = new Set(['报价明细']);
  const outputEditState = applyWorkbookOverrides(workbook, args.overrides || []);
  Object.defineProperty(workbook, 'outputEditState', {
    value: outputEditState,
    enumerable: false,
    configurable: true,
  });
  return workbook;
}

module.exports = {
  buildOutputWorkbook,
  buildReferenceBlock,
  buildQuotationDetail,
  buildReferenceLowerSections,
  appendRemainingQuotationSections,
};
