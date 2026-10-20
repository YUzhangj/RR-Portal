const path = require('node:path');
const XLSX = require('xlsx');

const ITEM_SHEET = '货号分表';
const ORDER_SHEET = '总表';
const IMPORT_ACTOR = '[历史核价导入]';
const DETAIL_MIGRATION_SUFFIX = '_details_v4';
const DETAIL_DEPARTMENTS = Object.freeze([
  'engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly',
]);
const COMPONENT_COLUMNS = Object.freeze({
  injection_labor: 4,
  assembly_labor: 5,
  painting_labor: 6,
  imp_mat: 7,
  dom_mat: 8,
  abs_material_cost: 9,
  abs_material_share: 10,
  total_purchase_price: 11,
  color_box: 12,
  libao: 13,
  suction: 14,
  carton: 15,
  plating: 16,
  electronic: 17,
  battery: 18,
  hardware: 19,
  slush: 20,
  sewing_hair: 21,
  sewing_cloth: 22,
  paint_material: 23,
  other_buy: 24,
  misc: 25,
  freight: 26,
  cabinet: 27,
  surtax_04: 28,
});

const numberOrNull = value => value === '' || value == null || !Number.isFinite(Number(value))
  ? null : Number(value);
const numberOrZero = value => numberOrNull(value) ?? 0;
const text = value => String(value ?? '').trim();
const normalizeSheetKey = value => text(value).toUpperCase().replace(/[\s\-\_—()（）]/g, '');

function detailDepartment(name) {
  const label = text(name);
  if (/料金额|料价进口料|料价国内|啤工/.test(label)) return 'molding';
  if (/喷油|喷印|油漆|移印|炒货|散枪|边模|浸油|抹油|PP水|UV/i.test(label)) return 'painting';
  if (/搪胶|搪工|批工|烤工/.test(label)) return 'slush';
  if (/车缝|车衣|车发|毛发|布料|裁片|电绣/.test(label)) return 'sewing';
  if (/电子|PCB|PACB|IC\b|线路板|喇叭|马达/.test(label)) return 'electronic';
  if (/人工|装工|组装|包装工|混装|拆查货/.test(label)) return 'assembly';
  return 'engineering';
}

function parseLegacyDetailSheet(sheet, sheetName, options = {}) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  const moldHeaderIndex = options.moldHeaderIndex ?? rows.findIndex(row => text(row[0]) === '模号');
  if (moldHeaderIndex < 0) throw new Error(`工作表“${sheetName}”缺少模具明细表头`);

  let totalIndex = rows.findIndex((row, index) => index > moldHeaderIndex
    && row.some(value => /TOTAL.*HK/i.test(text(value)) || (options.chineseTotal && /^合计$/.test(text(value)))));
  if (totalIndex < 0) throw new Error(`工作表“${sheetName}”缺少核价明细合计行`);

  const analysisHeaderIndex = rows.findIndex((row, index) => index > totalIndex
    && row.some(value => text(value) === '货价')
    && row.filter(value => value !== null && value !== '').length >= 4);
  const pricingTailEnd = analysisHeaderIndex >= 0 ? analysisHeaderIndex : rows.length;
  const pricingTail = rows.slice(totalIndex, pricingTailEnd).flatMap((row, offset) => {
    let lastColumn = row.length - 1;
    while (lastColumn >= 0 && (row[lastColumn] === null || row[lastColumn] === '')) lastColumn -= 1;
    if (lastColumn < 0) return [];
    return [{
      source_row: totalIndex + offset + 1,
      cells: row.slice(0, lastColumn + 1).map(value => value instanceof Date ? value.toISOString() : value),
    }];
  });

  let detailHeaderIndex = options.detailHeaderIndex ?? rows.findIndex((row, index) => index > moldHeaderIndex && index < totalIndex
    && row.some(value => /核价|报价/.test(text(value))));
  if (detailHeaderIndex < 0) detailHeaderIndex = moldHeaderIndex;

  const headerProbe = rows.slice(Math.max(moldHeaderIndex + 1, detailHeaderIndex - 1), Math.min(totalIndex, detailHeaderIndex + 2));
  const currentColumns = [];
  headerProbe.forEach(row => row.forEach((value, column) => {
    if (/核价/.test(text(value))) currentColumns.push(column);
  }));
  const totalLabelColumn = rows[totalIndex].findIndex(value => /TOTAL.*HK/i.test(text(value)) || (options.chineseTotal && /^合计$/.test(text(value))));
  const fallbackCurrentColumn = rows[totalIndex].findIndex((value, column) => column > totalLabelColumn && numberOrNull(value) != null);
  const currentColumn = currentColumns.length ? Math.min(...currentColumns) : fallbackCurrentColumn;
  if (currentColumn < 0) throw new Error(`工作表“${sheetName}”无法识别核价金额列`);

  const previousCandidates = [];
  headerProbe.forEach(row => row.forEach((value, column) => {
    if (column !== currentColumn && /核价|报价/.test(text(value))) previousCandidates.push(column);
  }));
  const previousColumn = previousCandidates.sort((a, b) => Math.abs(a - currentColumn) - Math.abs(b - currentColumn))[0] ?? -1;
  const firstDetailIndex = rows.findIndex((row, index) => index > detailHeaderIndex && index < totalIndex
    && text(row[0]) && numberOrNull(row[currentColumn]) != null);
  if (firstDetailIndex < 0) throw new Error(`工作表“${sheetName}”没有可导入的核价明细`);

  const legacyItems = rows.slice(firstDetailIndex, totalIndex).flatMap((row, offset) => {
    const current = numberOrNull(row[currentColumn]);
    if (!text(row[0]) || current == null) return [];
    const quantityEnd = previousColumn >= 0 ? Math.min(currentColumn, previousColumn) : currentColumn;
    const quantityValues = row.slice(1, quantityEnd).filter(value => value !== null && value !== '');
    const afterAmount = row.slice(Math.max(currentColumn, previousColumn) + 1);
    const previous = previousColumn >= 0 ? numberOrNull(row[previousColumn]) : null;
    const explicitDifference = afterAmount.map(numberOrNull).find(value => value != null) ?? null;
    const difference = explicitDifference ?? (previous == null ? null : current - previous);
    const notes = afterAmount.filter(value => typeof value === 'string' && text(value)).map(text);
    return [{
      source_row: firstDetailIndex + offset + 1,
      source_cell: XLSX.utils.encode_cell({r:firstDetailIndex+offset,c:currentColumn}),
      name: text(row[0]),
      quantity: quantityValues.length ? quantityValues[quantityValues.length - 1] : null,
      current_hkd: current,
      previous_hkd: previous,
      difference_hkd: difference,
      note: notes.join('；'),
    }];
  });

  const moldHeader = rows[moldHeaderIndex].map(value => text(value).replace(/\s+/g, ''));
  const columnOf = pattern => moldHeader.findIndex(value => pattern.test(value));
  const materialColumn = columnOf(/^料型$|^材料$/);
  const weightColumn = columnOf(/料重\(G\)$/i);
  const materialPriceColumn = columnOf(/料价\(G\)$/i);
  const machineColumn = columnOf(/机型/);
  const cavityColumn = columnOf(/件数|出模件数/);
  const setsColumn = columnOf(/套数|出模套数/);
  const targetColumn = columnOf(/目标数/);
  const shotColumn = columnOf(/啤工/);
  const materialAmountColumn = columnOf(/料金额/);
  const usageColumn = columnOf(/^用量$/);
  const lossFactorRow = rows.find(row => row.some(value => text(value).includes('料重损耗')));
  const lossFactor = lossFactorRow ? (lossFactorRow.map(numberOrNull).find(value => value != null && value >= 1) || 1.03) : 1.03;
  const injection = [];
  for (let index = moldHeaderIndex + 1; index < firstDetailIndex; index += 1) {
    const row = rows[index];
    const rawWeight = numberOrNull(row[weightColumn]);
    const materialPrice = numberOrNull(row[materialPriceColumn]);
    const materialAmount = materialAmountColumn >= 0 ? numberOrNull(row[materialAmountColumn]) : null;
    if (rawWeight == null || materialPrice == null) continue;
    const hasNameColumn = text(row[1]);
    const sourceUsage = usageColumn >= 0 ? row[usageColumn] : null;
    const effectiveWeight = materialAmount != null && materialPrice > 0
      ? materialAmount / materialPrice / lossFactor : rawWeight;
    injection.push({
      mold_no: hasNameColumn ? text(row[0]) : '',
      name: hasNameColumn ? text(row[1]) : text(row[0]),
      material: materialColumn >= 0 ? text(row[materialColumn]) : '',
      weight_g: effectiveWeight,
      material_unit_price: materialPrice,
      machine: machineColumn >= 0 ? text(row[machineColumn]) : '',
      machine_model: machineColumn >= 0 ? text(row[machineColumn]) : '',
      cavity: cavityColumn >= 0 ? row[cavityColumn] : null,
      sets: setsColumn >= 0 ? numberOrNull(row[setsColumn]) : null,
      target: targetColumn >= 0 ? numberOrNull(row[targetColumn]) : null,
      shot_price: shotColumn >= 0 ? numberOrNull(row[shotColumn]) : null,
      source_weight_g: rawWeight,
      source_usage: sourceUsage,
      note: [sourceUsage != null ? `原表用量：${text(sourceUsage)}` : '', `来源：${sheetName}!${index + 1}`].filter(Boolean).join('；'),
    });
  }

  const materialNameRow = rows.find(row => text(row[0]) === '料型') || [];
  const materialPriceRow = rows.find(row => text(row[0]) === '单价') || [];
  const materialPrices = materialNameRow.flatMap((value, column) => {
    const price = numberOrNull(materialPriceRow[column]);
    if (column === 0 || !text(value) || price == null) return [];
    return [{ name: text(value).split(/\s+/)[0], model: text(value), price }];
  });
  const machineNameRow = rows.find(row => text(row[0]) === '机型') || [];
  const machinePriceRow = rows.find(row => text(row[0]).includes('啤工价')) || [];
  const machinePrices = machineNameRow.flatMap((value, column) => {
    const price = numberOrNull(machinePriceRow[column]);
    if (column === 0 || !text(value) || price == null) return [];
    return [{ model: text(value), normal: '', price }];
  });

  const departmentPayloads = Object.fromEntries(DETAIL_DEPARTMENTS.map(dept => [dept, { legacy_items: [] }]));
  legacyItems.forEach(item => departmentPayloads[detailDepartment(item.name)].legacy_items.push(item));
  departmentPayloads.molding = {
    ...departmentPayloads.molding,
    injection,
    injection_loss_pct: Math.max(0, (lossFactor - 1) * 100),
    material_prices: materialPrices,
    machine_prices: machinePrices,
    blow_items: [],
    product_mix_ratios: {},
  };
  return {
    sheetName,
    departmentPayloads,
    detailCount: legacyItems.length,
    moldCount: injection.length,
    pricingTail,
  };
}

function rowsFromSheet(workbook, name) {
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error(`工作簿缺少“${name}”工作表`);
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
}

function buildPricingSummary(row) {
  const get = key => numberOrZero(row[COMPONENT_COLUMNS[key]]);
  const price = numberOrZero(row[1]);
  const cost = numberOrZero(row[2]);
  return {
    t1: {
      base_price: price,
      imp_mat: get('imp_mat'),
      dom_mat: get('dom_mat'),
      blow: 0,
      slush: get('slush'),
      sewing_hair: get('sewing_hair'),
      sewing_cloth: get('sewing_cloth'),
      hardware: get('hardware'),
      electronic: get('electronic'),
      motor: 0,
      suction: get('suction'),
      glue_bag: 0,
    },
    t2: {
      color_box: get('color_box'),
      inner_card: 0,
      code_before: cost ? price / cost : 0,
      code_after: 0,
      battery: get('battery'),
      libao: get('libao'),
      plating: get('plating'),
      other_buy: get('other_buy'),
      carton: get('carton'),
      freight: get('freight'),
      cabinet: get('cabinet'),
      misc: get('misc'),
    },
    t3: {
      abs_cost: get('abs_material_cost'),
      injection_labor: get('injection_labor'),
      painting_labor: get('painting_labor'),
      paint_material: get('paint_material'),
      assembly_labor: get('assembly_labor'),
    },
  };
}

function normalizedHeader(value) {
  return text(value).replace(/[\s\r\n（）()：:]/g, '').toUpperCase();
}

function columnByHeader(header, ...labels) {
  const wanted = labels.map(normalizedHeader);
  return header.findIndex(value => wanted.includes(normalizedHeader(value)));
}

function valueByHeader(row, header, ...labels) {
  const column = columnByHeader(header, ...labels);
  return column < 0 ? 0 : numberOrZero(row[column]);
}

function buildZuruPricingSummary(row, header, confirmedPrice) {
  const get = (...labels) => valueByHeader(row, header, ...labels);
  const cost = get('成本(含人工)', '成本（含人工）');
  return {
    t1: {
      base_price: confirmedPrice,
      imp_mat: get('料价进口料'),
      dom_mat: get('料价国内料'),
      blow: 0,
      slush: get('搪胶'),
      sewing_hair: get('车发'),
      sewing_cloth: get('车衣'),
      hardware: get('五金'),
      electronic: get('电子'),
      motor: get('马达'),
      suction: get('吸塑'),
      glue_bag: 0,
    },
    t2: {
      color_box: get('彩盒'),
      inner_card: 0,
      code_before: cost ? confirmedPrice / cost : 0,
      code_after: 0,
      battery: get('电池'),
      libao: get('利宝'),
      plating: get('电镀'),
      other_buy: get('其他外购', '其他外购件') + get('贴纸'),
      carton: get('纸箱'),
      freight: get('运费'),
      cabinet: get('吊柜费'),
      misc: get('杂项'),
    },
    t3: {
      abs_cost: get('ABS料价成本'),
      injection_labor: get('啤工'),
      painting_labor: get('喷印工', '喷油工'),
      paint_material: get('油漆'),
      assembly_labor: get('装工'),
    },
  };
}

function firstTextColumn(row, beforeColumn = row.length) {
  for (let column = 0; column < Math.min(beforeColumn, row.length); column += 1) {
    if (typeof row[column] === 'string' && text(row[column])) return column;
  }
  return -1;
}

function trimmedSourceCells(row) {
  let lastColumn = row.length - 1;
  while (lastColumn >= 0 && (row[lastColumn] === null || row[lastColumn] === '')) lastColumn -= 1;
  if (lastColumn < 0) return [];
  return row.slice(0, lastColumn + 1).map(value => value instanceof Date ? value.toISOString() : value);
}

function findCustomerDetailSheet(workbook, quoteNo, productName) {
  const quote = normalizeSheetKey(quoteNo);
  const product = normalizeSheetKey(productName);
  const candidates = workbook.SheetNames.filter(name => normalizeSheetKey(name).includes(quote));
  if (!candidates.length) return null;
  return candidates.map(name => {
    const normalized = normalizeSheetKey(name);
    let score = normalized === quote ? 1000 : (normalized.startsWith(quote) ? 300 : 100);
    if (product && normalized.includes(product)) score += 1200;
    if (/外发|湖南价|东莞价/.test(name)) score -= 250;
    return { name, score };
  }).sort((a, b) => b.score - a.score)[0].name;
}

function findPriceInDetailSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex];
    for (let column = 0; column < row.length; column += 1) {
      if (normalizedHeader(row[column]) !== '货价') continue;
      for (let offset = 1; offset <= 3 && rowIndex + offset < rows.length; offset += 1) {
        const candidate = numberOrNull(rows[rowIndex + offset][column]);
        if (candidate != null && candidate > 0) return candidate;
      }
    }
  }
  for (const row of rows) {
    const labelColumn = row.findIndex(value => /货价.*HK/i.test(normalizedHeader(value)));
    if (labelColumn < 0) continue;
    for (let column = labelColumn + 1; column < Math.min(row.length, labelColumn + 4); column += 1) {
      const candidate = numberOrNull(row[column]);
      if (candidate != null && candidate > 0) return candidate;
    }
  }
  return null;
}

function detailAnalysisSummary(sheet, fallbackPrice) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  const headerIndex = rows.map((row, index) => ({ row, index })).reverse().find(({ row }) => (
    row.some(value => normalizedHeader(value) === '货价')
    && row.filter(value => value !== null && value !== '').length >= 4
  ))?.index ?? -1;
  if (headerIndex < 0 || headerIndex + 1 >= rows.length) return null;
  const baseHeader = rows[headerIndex];
  const baseValues = rows[headerIndex + 1];
  const get = (header, values, ...labels) => {
    const column = columnByHeader(header, ...labels);
    return column < 0 ? 0 : numberOrZero(values[column]);
  };
  const packHeaderIndex = rows.findIndex((row, index) => index > headerIndex
    && row.some(value => normalizedHeader(value) === '不含人工成本'));
  const laborHeaderIndex = rows.findIndex((row, index) => index > headerIndex
    && row.some(value => normalizedHeader(value) === '总成本')
    && row.some(value => /ABS.*成本/.test(normalizedHeader(value))));
  const packHeader = packHeaderIndex >= 0 ? rows[packHeaderIndex] : [];
  const packValues = packHeaderIndex >= 0 ? rows[packHeaderIndex + 1] || [] : [];
  const laborHeader = laborHeaderIndex >= 0 ? rows[laborHeaderIndex] : [];
  const laborValues = laborHeaderIndex >= 0 ? rows[laborHeaderIndex + 1] || [] : [];
  const price = get(baseHeader, baseValues, '货价') || fallbackPrice;
  const totalCost = get(laborHeader, laborValues, '总成本');
  const costWithoutLabor = get(packHeader, packValues, '不含人工成本');
  return {
    pricingSummary: {
      t1: {
        base_price: price,
        imp_mat: get(baseHeader, baseValues, '进口料'),
        dom_mat: get(baseHeader, baseValues, '国内料'),
        blow: get(baseHeader, baseValues, '吹气'),
        slush: get(baseHeader, baseValues, '搪胶'),
        sewing_hair: get(baseHeader, baseValues, '车发'),
        sewing_cloth: get(baseHeader, baseValues, '车衣', '车缝'),
        hardware: get(baseHeader, baseValues, '五金'),
        electronic: get(baseHeader, baseValues, '电子'),
        motor: get(baseHeader, baseValues, '马达'),
        suction: get(baseHeader, baseValues, '吸塑'),
        glue_bag: 0,
      },
      t2: {
        color_box: get(packHeader, packValues, '彩盒/内咭', '彩盒/说明书'),
        inner_card: 0,
        code_before: totalCost ? price / totalCost : 0,
        code_after: get(packHeader, packValues, '减税后码数'),
        battery: get(packHeader, packValues, '电池'),
        libao: get(packHeader, packValues, '利宝'),
        plating: get(packHeader, packValues, '电镀'),
        other_buy: get(packHeader, packValues, '其他外购'),
        carton: get(packHeader, packValues, '纸箱'),
        freight: get(packHeader, packValues, '运费'),
        cabinet: get(packHeader, packValues, '吊柜费'),
        misc: get(packHeader, packValues, '杂项'),
      },
      t3: {
        abs_cost: get(laborHeader, laborValues, 'ABS料价成本'),
        injection_labor: get(laborHeader, laborValues, '啤工'),
        painting_labor: get(laborHeader, laborValues, '喷油工', '喷印工'),
        paint_material: get(laborHeader, laborValues, '油漆'),
        assembly_labor: get(laborHeader, laborValues, '装配工', '装工'),
      },
    },
    totalCost,
    costWithoutLabor,
  };
}

function parseFlexibleLegacyDetailSheet(sheet, sheetName) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  const moldHeaderIndex = rows.findIndex(row => row.some(value => /^(模号|模具编号)$/.test(text(value)))
    && row.some(value => /^(名称|工模名称)$/.test(text(value))));
  if (moldHeaderIndex < 0) throw new Error(`工作表“${sheetName}”缺少模具明细表头`);

  const moldHeader = rows[moldHeaderIndex].map(value => normalizedHeader(value));
  const columnOf = (...patterns) => moldHeader.findIndex(value => patterns.some(pattern => pattern.test(value)));
  const moldColumn = columnOf(/^模号$/, /^模具编号$/);
  const nameColumn = columnOf(/^名称$/, /^工模名称$/);
  const materialColumn = columnOf(/^料型$/, /^材料$/);
  const machineColumn = columnOf(/^PP核价机型$/, /^机型A$/, /^机型$/);
  let weightColumn = columnOf(/^核价实际料重$/, /^核价料重$/);
  if (weightColumn < 0) weightColumn = columnOf(/^料重G$/, /^料重\/G$/, /^料重$/);
  const materialPriceCandidates = moldHeader.flatMap((value, column) => (
    /^(核价料价|料价G|料单价)$/.test(value) ? [column] : []
  ));
  const materialPriceColumn = materialPriceCandidates.find(column => machineColumn < 0 || column < machineColumn)
    ?? materialPriceCandidates[0] ?? -1;
  const cavityColumn = columnOf(/件数/, /1出几套/, /出模件数/);
  const setsColumn = columnOf(/^套数$/, /出模套数/);
  const targetColumn = columnOf(/核价目标数/, /目标啤数/, /目标数/, /日产量22H/);
  let shotColumn = columnOf(/^核价啤工$/, /^啤工价$/);
  if (shotColumn < 0) shotColumn = columnOf(/^报价啤工$/, /^啤工$/);

  const comparisonCandidates = [];
  for (let index = moldHeaderIndex + 1; index < rows.length; index += 1) {
    let exactCurrent = rows[index].findIndex(value => /^核[價价]$/.test(text(value)));
    if (exactCurrent < 0 && rows[index].some(value => /用量|报[價价]|報價/.test(text(value)))) {
      exactCurrent = rows[index].findIndex(value => /^(合計|合计)$/.test(text(value)));
    }
    if (exactCurrent >= 0) comparisonCandidates.push({ index, column: exactCurrent });
  }
  let comparison = comparisonCandidates[0] || null;
  let moldEndIndex = rows.findIndex((row, index) => index > moldHeaderIndex
    && row.some(value => /^TOTAL[：:]?$/i.test(text(value))));
  if (moldEndIndex < 0) moldEndIndex = comparison?.index ?? rows.length;
  if (comparison && comparison.index < moldEndIndex) moldEndIndex = comparison.index;

  const injection = [];
  let inherited = { moldNo: '', material: '', machine: '', materialPrice: null };
  for (let index = moldHeaderIndex + 1; index < moldEndIndex; index += 1) {
    const row = rows[index];
    const rowMold = moldColumn >= 0 ? text(row[moldColumn]) : '';
    const rowMaterial = materialColumn >= 0 ? text(row[materialColumn]) : '';
    const rowMachine = machineColumn >= 0 ? text(row[machineColumn]) : '';
    const rowPrice = materialPriceColumn >= 0 ? numberOrNull(row[materialPriceColumn]) : null;
    if (rowMold) inherited.moldNo = rowMold;
    if (rowMaterial) inherited.material = rowMaterial;
    if (rowMachine) inherited.machine = rowMachine;
    if (rowPrice != null) inherited.materialPrice = rowPrice;
    const weight = weightColumn >= 0 ? numberOrNull(row[weightColumn]) : null;
    const name = nameColumn >= 0 ? text(row[nameColumn]) : '';
    if (!name || weight == null || inherited.materialPrice == null) continue;
    injection.push({
      mold_no: rowMold || inherited.moldNo,
      name,
      material: rowMaterial || inherited.material,
      weight_g: weight,
      material_unit_price: inherited.materialPrice,
      machine: rowMachine || inherited.machine,
      machine_model: rowMachine || inherited.machine,
      cavity: cavityColumn >= 0 ? row[cavityColumn] : null,
      sets: setsColumn >= 0 ? numberOrNull(row[setsColumn]) : null,
      target: targetColumn >= 0 ? numberOrNull(row[targetColumn]) : null,
      shot_price: shotColumn >= 0 ? numberOrNull(row[shotColumn]) : null,
      source_weight_g: weight,
      source_usage: null,
      source_excel_cells: Object.fromEntries(Object.entries({
        weight_g: weightColumn, material_unit_price: materialPriceColumn,
        cavity: cavityColumn, sets: setsColumn, target: targetColumn, shot_price: shotColumn,
      }).filter(([, column]) => column >= 0).map(([field, column]) =>
        [field, XLSX.utils.encode_cell({ r: index, c: column })])),
      note: `来源：${sheetName}!${index + 1}`,
    });
  }

  if (!comparison) {
    comparison = { index: moldEndIndex, column: Math.max(1, moldColumn) };
  }
  const currentColumn = comparison.column;
  let previousColumn = -1;
  const headerStart = Math.max(moldEndIndex, comparison.index - 2);
  const headerEnd = Math.min(rows.length, comparison.index + 3);
  for (let index = headerStart; index < headerEnd && previousColumn < 0; index += 1) {
    const originalColumn = rows[index].findIndex(value => /原来?报[價价]|原報價/.test(text(value)));
    if (originalColumn >= 0) previousColumn = originalColumn + 1;
    else previousColumn = rows[index].findIndex((value, column) => column !== currentColumn && /^(报价|報價)$/.test(text(value)));
  }

  let totalIndex = rows.findIndex((row, index) => index > comparison.index
    && row.some(value => /TOTAL.*HK/i.test(text(value))));
  if (totalIndex < 0) {
    totalIndex = rows.findIndex((row, index) => index > comparison.index
      && row.some(value => /^(合計|合计)$/.test(text(value))));
  }
  if (totalIndex < 0) throw new Error(`工作表“${sheetName}”缺少核价明细合计行`);

  const legacyItems = [];
  for (let index = comparison.index + 1; index < totalIndex; index += 1) {
    const row = rows[index];
    const current = numberOrNull(row[currentColumn]);
    const labelColumn = firstTextColumn(row, Math.max(1, currentColumn));
    if (current == null || labelColumn < 0) continue;
    const label = text(row[labelColumn]);
    if (/^(核价|报价|報價|TOTAL|小计|合计)/i.test(label)) continue;
    const previous = previousColumn >= 0 ? numberOrNull(row[previousColumn]) : null;
    const quantityValues = row.slice(labelColumn + 1, currentColumn).filter(value => value !== null && value !== '');
    const rawCells = trimmedSourceCells(row);
    const sourceCell = XLSX.utils.encode_cell({ r: index, c: currentColumn });
    const sourceFormula = sheet[sourceCell]?.f || '';
    const fxMatch = sourceFormula.match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*\$?D\$?10\s*$/i);
    const fxValue = numberOrNull(sheet.D10?.v);
    const linkedFx = fxMatch && fxValue > 0
      && Math.abs(Number(fxMatch[1]) / fxValue - current) < 0.000001;
    legacyItems.push({
      source_row: index + 1,
      name: label,
      quantity: quantityValues.length ? quantityValues[quantityValues.length - 1] : null,
      current_hkd: current,
      previous_hkd: previous,
      difference_hkd: previous == null ? null : current - previous,
      note: `原表：${rawCells.map(value => text(value)).filter(Boolean).join(' | ')}`,
      source_cells: rawCells,
      source_cell: sourceCell,
      ...(sourceFormula ? { source_formula: sourceFormula, source_formula_cell: sourceCell } : {}),
      ...(linkedFx ? { source_formula_basis: 'rmb_hkd', source_formula_ref_value: fxValue } : {}),
    });
  }

  const analysisHeaderIndex = rows.findIndex((row, index) => index > totalIndex
    && row.some(value => normalizedHeader(value) === '货价')
    && row.filter(value => value !== null && value !== '').length >= 4);
  const pricingTailEnd = analysisHeaderIndex >= 0 ? analysisHeaderIndex : rows.length;
  const pricingTail = rows.slice(totalIndex, pricingTailEnd).flatMap((row, offset) => {
    const cells = trimmedSourceCells(row);
    return cells.length ? [{ source_row: totalIndex + offset + 1, cells }] : [];
  });

  const materialNameIndex = rows.findIndex(row => row.some(value => normalizedHeader(value) === '料型'));
  const materialNameRow = materialNameIndex >= 0 ? rows[materialNameIndex] : [];
  const materialPriceRow = materialNameIndex >= 0
    ? rows.slice(materialNameIndex + 1, materialNameIndex + 4).find(row => row.some(value => /单价|料价/.test(text(value)))) || []
    : [];
  const materialPrices = materialNameRow.flatMap((value, column) => {
    const price = numberOrNull(materialPriceRow[column]);
    if (!text(value) || normalizedHeader(value) === '料型' || price == null) return [];
    return [{ name: text(value).split(/\s+/)[0], model: text(value), price }];
  });
  const machineNameIndex = rows.findIndex(row => row.some(value => normalizedHeader(value) === '机型'));
  const machineNameRow = machineNameIndex >= 0 ? rows[machineNameIndex] : [];
  const machinePriceRow = machineNameIndex >= 0
    ? rows.slice(machineNameIndex + 1, machineNameIndex + 4).find(row => row.some(value => /啤工价|机型单价/.test(text(value)))) || []
    : [];
  const machinePrices = machineNameRow.flatMap((value, column) => {
    const price = numberOrNull(machinePriceRow[column]);
    if (!text(value) || normalizedHeader(value) === '机型' || price == null) return [];
    return [{ model: text(value), normal: '', price }];
  });

  const departmentPayloads = Object.fromEntries(DETAIL_DEPARTMENTS.map(dept => [dept, { legacy_items: [] }]));
  legacyItems.forEach(item => departmentPayloads[detailDepartment(item.name)].legacy_items.push(item));
  departmentPayloads.molding = {
    ...departmentPayloads.molding,
    injection,
    injection_loss_pct: 3,
    material_prices: materialPrices,
    machine_prices: machinePrices,
    blow_items: [],
    product_mix_ratios: {},
  };
  return {
    sheetName,
    departmentPayloads,
    detailCount: legacyItems.length,
    moldCount: injection.length,
    pricingTail,
  };
}

function parseZuruVerificationWorkbook(workbookPath, options = {}) {
  const sourceDate = options.sourceDate || '2026-09-09';
  const sourceFile = options.sourceFile || path.basename(workbookPath);
  const workbook = XLSX.readFile(workbookPath, { cellDates: true, cellFormula: true });
  const summaryName = workbook.SheetNames.find(name => /^(總表|总表)$/.test(text(name)));
  if (!summaryName) throw new Error('工作簿缺少“總表”工作表');
  const rows = rowsFromSheet(workbook, summaryName);
  const headerIndex = rows.findIndex(row => row.some(value => normalizedHeader(value) === '货号')
    && row.some(value => /货价HK\$/i.test(normalizedHeader(value))));
  if (headerIndex < 0) throw new Error('“總表”缺少货号/货价表头');
  const header = rows[headerIndex];
  const customerColumn = columnByHeader(header, '客名');
  const quoteColumn = columnByHeader(header, '货号');
  const productColumn = columnByHeader(header, '货品名称');
  const qtyColumn = header.findIndex(value => /接单数量/.test(text(value)));
  const priceColumn = header.findIndex(value => /货价.*HK/i.test(normalizedHeader(value)));
  const costWithLaborColumn = columnByHeader(header, '成本(含人工)', '成本（含人工）');
  const costWithoutLaborColumn = columnByHeader(header, '成本(不含人工)', '成本（不含人工）');

  const items = rows.slice(headerIndex + 1).flatMap(row => {
    const quoteNo = text(row[quoteColumn]);
    const customer = customerColumn >= 0 ? text(row[customerColumn]).toUpperCase() : '';
    if (!quoteNo || (customer && customer !== 'ZURU')) return [];
    const productName = text(row[productColumn]) || quoteNo;
    const detailSheetName = findCustomerDetailSheet(workbook, quoteNo, productName);
    if (!detailSheetName) throw new Error(`找不到货号 ${quoteNo} 对应的明细工作表`);
    const detailSheet = workbook.Sheets[detailSheetName];
    const summaryPrice = numberOrNull(row[priceColumn]);
    const confirmedPrice = summaryPrice ?? findPriceInDetailSheet(detailSheet);
    if (confirmedPrice == null || confirmedPrice <= 0) throw new Error(`货号 ${quoteNo} 无法识别有效货价`);
    const detail = parseFlexibleLegacyDetailSheet(detailSheet, detailSheetName);
    const analysis = summaryPrice == null ? detailAnalysisSummary(detailSheet, confirmedPrice) : null;
    const pricingSummary = analysis?.pricingSummary || buildZuruPricingSummary(row, header, confirmedPrice);
    return [{
      quoteNo,
      productName,
      qty: qtyColumn >= 0 ? numberOrNull(row[qtyColumn]) : null,
      confirmedPrice,
      departmentPayloads: detail.departmentPayloads,
      salesPayload: {
        header: { currency: 'HKD', fx_hkd_usd: 7.75, fx_rmb_hkd: 0.87 },
        pricing_summary: pricingSummary,
        legacy_import: {
          summary_only: true,
          detail_imported: true,
          confirmed_currency: 'HKD',
          source_file: sourceFile,
          source_sheet: summaryName,
          source_detail_sheet: detail.sheetName,
          source_detail_rows: detail.detailCount,
          source_mold_rows: detail.moldCount,
          source_detail_tail_rows: detail.pricingTail.length,
          pricing_tail: detail.pricingTail,
          source_item: quoteNo,
          source_date: sourceDate,
          source_price_from_detail: summaryPrice == null,
          source_cost_including_labor: analysis?.totalCost
            || (costWithLaborColumn >= 0 ? numberOrZero(row[costWithLaborColumn]) : 0),
          source_cost_excluding_labor: analysis?.costWithoutLabor
            || (costWithoutLaborColumn >= 0 ? numberOrZero(row[costWithoutLaborColumn]) : 0),
          source_abs_material_cost: valueByHeader(row, header, 'ABS料价成本'),
          source_abs_material_share: valueByHeader(row, header, 'ABS占货价%'),
          source_total_purchase_price: valueByHeader(row, header, '总采购价'),
          source_surtax_04: valueByHeader(row, header, '附加税0.4%', '附件税0.4%'),
        },
      },
    }];
  });

  const unique = new Set(items.map(item => item.quoteNo));
  if (unique.size !== items.length) throw new Error('“總表”存在重复货号');
  return {
    sourceDate,
    sourceFile,
    items,
    withQty: items.filter(item => item.qty != null).length,
    withoutQty: items.filter(item => item.qty == null).length,
    totalQty: items.reduce((sum, item) => sum + (item.qty || 0), 0),
  };
}

function parseLegacyVerificationWorkbook(workbookPath, options = {}) {
  const sourceDate = options.sourceDate || '2026-09-08';
  const sourceFile = options.sourceFile || path.basename(workbookPath);
  const workbook = XLSX.readFile(workbookPath, { cellDates: true });
  const itemRows = rowsFromSheet(workbook, ITEM_SHEET);
  const orderRows = rowsFromSheet(workbook, ORDER_SHEET);
  const detailSheets = new Map(workbook.SheetNames.map(name => [normalizeSheetKey(name), name]));
  const orders = new Map();
  for (const row of orderRows.slice(1)) {
    if (text(row[0]).toUpperCase() !== 'SKY' || !text(row[1])) continue;
    orders.set(text(row[1]), {
      qty: numberOrNull(row[3]),
      price: numberOrNull(row[4]),
    });
  }

  const items = itemRows.slice(1).filter(row => text(row[0])).map(row => {
    const quoteNo = text(row[0]);
    const price = numberOrNull(row[1]);
    if (price == null || price < 0) throw new Error(`货号 ${quoteNo} 的货价无效`);
    const order = orders.get(quoteNo);
    if (order?.price != null && Math.abs(order.price - price) > 0.000001) {
      throw new Error(`货号 ${quoteNo} 在“货号分表”和“总表”的货价不一致`);
    }
    const pricingSummary = buildPricingSummary(row);
    const detailSheetName = detailSheets.get(normalizeSheetKey(quoteNo));
    if (!detailSheetName) throw new Error(`找不到货号 ${quoteNo} 对应的明细工作表`);
    const detail = parseLegacyDetailSheet(workbook.Sheets[detailSheetName], detailSheetName);
    return {
      quoteNo,
      productName: quoteNo,
      qty: order?.qty ?? null,
      confirmedPrice: price,
      departmentPayloads: detail.departmentPayloads,
      salesPayload: {
        header: { currency: 'HKD', fx_hkd_usd: 7.8, fx_rmb_hkd: 0.87 },
        pricing_summary: pricingSummary,
        legacy_import: {
          summary_only: true,
          detail_imported: true,
          confirmed_currency: 'HKD',
          source_file: sourceFile,
          source_sheet: ITEM_SHEET,
          source_detail_sheet: detail.sheetName,
          source_detail_rows: detail.detailCount,
          source_mold_rows: detail.moldCount,
          source_detail_tail_rows: detail.pricingTail.length,
          pricing_tail: detail.pricingTail,
          source_item: quoteNo,
          source_date: sourceDate,
          source_cost_including_labor: numberOrZero(row[2]),
          source_cost_excluding_labor: numberOrZero(row[3]),
          source_abs_material_cost: numberOrZero(row[COMPONENT_COLUMNS.abs_material_cost]),
          source_abs_material_share: numberOrZero(row[COMPONENT_COLUMNS.abs_material_share]),
          source_total_purchase_price: numberOrZero(row[COMPONENT_COLUMNS.total_purchase_price]),
          source_surtax_04: numberOrZero(row[COMPONENT_COLUMNS.surtax_04]),
        },
      },
    };
  });

  const unique = new Set(items.map(item => item.quoteNo));
  if (unique.size !== items.length) throw new Error('“货号分表”存在重复货号');
  return {
    sourceDate,
    sourceFile,
    items,
    withQty: items.filter(item => item.qty != null).length,
    withoutQty: items.filter(item => item.qty == null).length,
    totalQty: items.reduce((sum, item) => sum + (item.qty || 0), 0),
  };
}

function baselineFor(quote, departments, salesPayload, importedAt, departmentPayloads = {}, sectionStatus = 'approved') {
  return {
    quote,
    sections: departments.map(department => ({
      dept: department.code,
      dept_name: department.name_cn,
      status: sectionStatus,
      payload: department.code === 'sales' ? salesPayload : (departmentPayloads[department.code] || {}),
    })),
    frozen_at: importedAt,
  };
}

async function backfillLegacyVerificationDetails(db, parsed, options = {}) {
  const customer = options.customer || 'Sky Castle';
  const factoryCode = options.factoryCode || 'qingxi';
  const actor = options.actor || IMPORT_ACTOR;
  const importedAt = options.importedAt || `${parsed.sourceDate}T00:00:00+08:00`;
  const migrationKey = options.migrationKey || `legacy_verification_sky_castle_${parsed.sourceDate.replaceAll('-', '')}`;
  const detailMigrationKey = `${migrationKey}${DETAIL_MIGRATION_SUFFIX}`;
  if (await db.prepare('SELECT key FROM app_migrations WHERE key=?').get(detailMigrationKey)) {
    return { status: 'already_applied', migrationKey: detailMigrationKey, itemCount: parsed.items.length };
  }
  const tx = db.transaction(async () => {
    for (const item of parsed.items) {
      if (!item.departmentPayloads) throw new Error(`货号 ${item.quoteNo} 缺少部门明细数据`);
      const quote = await db.prepare(`SELECT id FROM quotes
        WHERE factory_code=? AND customer=? AND quote_no=? AND deleted_at IS NULL`)
        .get(factoryCode, customer, item.quoteNo);
      if (!quote) throw new Error(`找不到已导入的货号 ${item.quoteNo}`);
      const version = await db.prepare('SELECT id FROM quote_verification_versions WHERE quote_id=? AND version_no=1')
        .get(quote.id);
      if (!version) throw new Error(`货号 ${item.quoteNo} 缺少 V1 核价版本`);

      const payloads = { sales: item.salesPayload, ...item.departmentPayloads };
      for (const [dept, payload] of Object.entries(payloads)) {
        const payloadJson = JSON.stringify(payload);
        await db.prepare('UPDATE quote_sections SET payload_json=? WHERE quote_id=? AND dept=?')
          .run(payloadJson, quote.id, dept);
        await db.prepare('UPDATE quote_verification_sections SET payload_json=?, review_comment=? WHERE version_id=? AND dept=?')
          .run(payloadJson, '历史核价明细导入', version.id, dept);
      }

      const verification = await db.prepare('SELECT baseline_json FROM quote_verifications WHERE quote_id=?').get(quote.id);
      if (verification?.baseline_json) {
        const baseline = JSON.parse(verification.baseline_json);
        baseline.sections = (baseline.sections || []).map(section => ({
          ...section,
          payload: payloads[section.dept] || section.payload || {},
        }));
        await db.prepare('UPDATE quote_verifications SET baseline_json=?, note=?, updated_by=?, updated_at=? WHERE quote_id=?')
        .run(JSON.stringify(baseline), `${customer} 历史核价明细导入`, actor, importedAt, quote.id);
      }
      await db.prepare(`INSERT INTO audit_log (quote_id, dept, actor, action, detail, at)
        VALUES (?, 'sales', ?, 'legacy_verification_detail_import', ?, ?)`)
        .run(quote.id, actor, JSON.stringify({
          customer, source_file: parsed.sourceFile, source_sheet: item.salesPayload.legacy_import.source_detail_sheet,
          quote_no: item.quoteNo,
        }), importedAt);
    }
    await db.prepare('INSERT INTO app_migrations (key, applied_at) VALUES (?, ?)').run(detailMigrationKey, importedAt);
  });
  await tx();
  return { status: 'details_applied', migrationKey: detailMigrationKey, itemCount: parsed.items.length };
}

async function importLegacyVerificationItems(db, parsed, options = {}) {
  if (!options.skipReady) await db.ready;
  const customer = options.customer || 'Sky Castle';
  const factoryCode = options.factoryCode || 'qingxi';
  const workshop = options.workshop || 'huadeng';
  const apply = Boolean(options.apply);
  const actor = options.actor || IMPORT_ACTOR;
  const importedAt = options.importedAt || `${parsed.sourceDate}T00:00:00+08:00`;
  const migrationKey = options.migrationKey || `legacy_verification_sky_castle_${parsed.sourceDate.replaceAll('-', '')}`;
  const existingMigration = await db.prepare('SELECT key FROM app_migrations WHERE key=?').get(migrationKey);
  for (const item of parsed.items) {
    if (item.verificationStatus != null && !['drafting', 'completed'].includes(item.verificationStatus)) {
      throw new Error(`货号 ${item.quoteNo} 的导入核价状态无效`);
    }
  }
  if (existingMigration) {
    if (!apply) return { status: 'already_applied', migrationKey, itemCount: parsed.items.length };
    return backfillLegacyVerificationDetails(db, parsed, { ...options, migrationKey, importedAt });
  }

  const conflicts = [];
  for (const item of parsed.items) {
    const existing = await db.prepare('SELECT id, customer, deleted_at FROM quotes WHERE factory_code=? AND quote_no=?')
      .get(factoryCode, item.quoteNo);
    if (existing) conflicts.push({ quoteNo: item.quoteNo, customer: existing.customer, deleted: Boolean(existing.deleted_at) });
  }
  if (conflicts.length) {
    const error = new Error(`发现 ${conflicts.length} 个同货号记录，已停止导入`);
    error.conflicts = conflicts;
    throw error;
  }
  if (!apply) {
    return {
      status: 'dry_run', migrationKey, itemCount: parsed.items.length,
      withQty: parsed.withQty, withoutQty: parsed.withoutQty, totalQty: parsed.totalQty,
    };
  }

  const departments = await db.prepare('SELECT code, name_cn FROM departments ORDER BY sort_order').all();
  if (!departments.length) throw new Error('系统没有部门配置，不能创建核价版本');
  const tx = db.transaction(async () => {
    for (const item of parsed.items) {
      const completed = item.verificationStatus !== 'drafting';
      const sectionStatus = completed ? 'approved' : 'filled';
      const reviewActor = completed ? actor : null;
      const reviewedAt = completed ? importedAt : null;
      const departmentPayloads = item.departmentPayloads || {};
      const salesPayloadJson = JSON.stringify(item.salesPayload);
      const info = await db.prepare(`INSERT INTO quotes
        (quote_no, product_name, customer, qty, created_by_dept, created_by_name, created_at, status, version, factory_code)
        VALUES (?, ?, ?, ?, 'sales', ?, ?, ?, '历史V1', ?)`)
        .run(item.quoteNo, item.productName, customer, item.qty, actor, importedAt,
          completed ? 'fully_approved' : 'drafting', factoryCode);
      const quoteId = Number(info.lastInsertRowid);
      const quote = await db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId);

      for (const department of departments) {
        const payloadJson = department.code === 'sales'
          ? salesPayloadJson : JSON.stringify(departmentPayloads[department.code] || {});
        await db.prepare(`INSERT INTO quote_sections
          (quote_id, dept, payload_json, status, filled_by, filled_at, reviewed_by, reviewed_at, review_comment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(quoteId, department.code, payloadJson, sectionStatus, actor, importedAt, reviewActor, reviewedAt,
            completed ? '历史核价汇总导入' : '历史核价导入，待复核');
      }

      const confirmationNote = item.qty == null
        ? `历史核价导入（${parsed.sourceDate}）；原表无接单数量；价格币种 HKD`
        : `历史核价导入（${parsed.sourceDate}）；价格币种 HKD`;
      await db.prepare(`INSERT INTO quote_customer_confirmations
        (quote_id, status, workshops_json, confirmed_price, confirmed_qty, note, confirmed_by, confirmed_at, updated_at)
        VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)`)
        .run(quoteId, JSON.stringify([workshop]), item.confirmedPrice, item.qty, confirmationNote, actor, importedAt, importedAt);

      const baselineQuote = { ...quote, confirmed_price: item.confirmedPrice, confirmed_qty: item.qty };
      const baseline = baselineFor(baselineQuote, departments, item.salesPayload, importedAt, departmentPayloads, sectionStatus);
      await db.prepare(`INSERT INTO quote_verifications
        (quote_id, baseline_json, verified_values_json, verified_sections_json, status, note, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, '{}', '{}', ?, ?, ?, ?, ?, ?)`)
        .run(quoteId, JSON.stringify(baseline), completed ? 'completed' : 'in_progress',
          `${customer} 历史核价汇总导入`, actor, importedAt, actor, importedAt);
      const versionInfo = await db.prepare(`INSERT INTO quote_verification_versions
        (quote_id, version_no, label, source_type, status, note, created_by, created_at, completed_by, completed_at, updated_at)
        VALUES (?, 1, 'V1', 'quote', ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(quoteId, completed ? 'completed' : 'drafting', '历史核价汇总导入', actor, importedAt,
          reviewActor, reviewedAt, importedAt);
      const versionId = Number(versionInfo.id);
      for (const department of departments) {
        const payloadJson = department.code === 'sales'
          ? salesPayloadJson : JSON.stringify(departmentPayloads[department.code] || {});
        await db.prepare(`INSERT INTO quote_verification_sections
          (version_id, dept, payload_json, status, filled_by, filled_at, reviewed_by, reviewed_at, review_comment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(versionId, department.code, payloadJson, sectionStatus, actor, importedAt, reviewActor, reviewedAt,
            completed ? '历史核价汇总导入' : '历史核价导入，待复核');
      }
      await db.prepare(`INSERT INTO audit_log (quote_id, dept, actor, action, detail, at)
        VALUES (?, 'sales', ?, 'legacy_verification_import', ?, ?)`)
        .run(quoteId, actor, JSON.stringify({
          customer, source_file: parsed.sourceFile, source_date: parsed.sourceDate,
          quote_no: item.quoteNo, confirmed_price_hkd: item.confirmedPrice, confirmed_qty: item.qty,
        }), importedAt);
    }
    await db.prepare('INSERT INTO app_migrations (key, applied_at) VALUES (?, ?)').run(migrationKey, importedAt);
    if (parsed.items.every(item => item.departmentPayloads)) {
      await db.prepare('INSERT INTO app_migrations (key, applied_at) VALUES (?, ?)')
        .run(`${migrationKey}${DETAIL_MIGRATION_SUFFIX}`, importedAt);
    }
  });
  await tx();
  return {
    status: 'applied', migrationKey, itemCount: parsed.items.length,
    withQty: parsed.withQty, withoutQty: parsed.withoutQty, totalQty: parsed.totalQty,
  };
}

async function createLegacyVerificationBatchVersion(db, parsed, options = {}) {
  if (!options.skipReady) await db.ready;
  const customer = options.customer || 'Sky Castle';
  const factoryCode = options.factoryCode || 'qingxi';
  const actor = options.actor || IMPORT_ACTOR;
  const importedAt = options.importedAt || new Date().toISOString();
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  if (!items.length) throw new Error('核价总表没有可同步的货号');

  const departments = await db.prepare('SELECT code, name_cn FROM departments ORDER BY sort_order').all();
  if (!departments.length) throw new Error('系统没有部门配置，不能创建核价版本');
  const departmentCodes = new Set(departments.map(department => department.code));
  const prepared = [];
  const missing = [];
  const unfinished = [];

  for (const item of items) {
    const quote = await db.prepare(`SELECT id, quote_no FROM quotes
      WHERE factory_code=? AND customer=? AND quote_no=? AND deleted_at IS NULL`)
      .get(factoryCode, customer, item.quoteNo);
    if (!quote) {
      missing.push(item.quoteNo);
      continue;
    }
    const latest = await db.prepare(`SELECT * FROM quote_verification_versions
      WHERE quote_id=? ORDER BY version_no DESC LIMIT 1`).get(quote.id);
    if (!latest || latest.status !== 'completed') {
      unfinished.push({ quoteNo: item.quoteNo, label: latest?.label || '尚未创建', status: latest?.status || 'not_started' });
      continue;
    }
    if (!item.departmentPayloads || !item.salesPayload) {
      throw new Error(`货号 ${item.quoteNo} 缺少部门核价明细`);
    }
    const payloads = { sales: item.salesPayload, ...item.departmentPayloads };
    const missingDepartments = departments.filter(department => !Object.hasOwn(payloads, department.code));
    if (missingDepartments.length) {
      throw new Error(`货号 ${item.quoteNo} 缺少部门：${missingDepartments.map(row => row.name_cn).join('、')}`);
    }
    const extraDepartments = Object.keys(payloads).filter(dept => !departmentCodes.has(dept));
    if (extraDepartments.length) throw new Error(`货号 ${item.quoteNo} 含未知部门：${extraDepartments.join('、')}`);
    prepared.push({ item, quote, latest, payloads });
  }

  if (missing.length || unfinished.length) {
    const error = new Error([
      missing.length ? `找不到 ${missing.length} 个货号：${missing.join('、')}` : '',
      unfinished.length ? `${unfinished.length} 个货号的当前版本尚未完成：${unfinished.map(row => `${row.quoteNo} ${row.label}`).join('、')}` : '',
      '本次未写入任何数据。',
    ].filter(Boolean).join('；'));
    error.code = 'LEGACY_BATCH_CONFLICT';
    error.missing = missing;
    error.unfinished = unfinished;
    throw error;
  }

  const tx = db.transaction(async () => {
    const versions = [];
    // Share the quote-first lock order with the other lifecycle writers. The
    // parse/preflight happens before BEGIN, so recheck it after taking locks.
    for (const { quote } of [...prepared].sort((a, b) => Number(a.quote.id) - Number(b.quote.id))) {
      const locked = await db.prepare(`SELECT id, deleted_at FROM quotes WHERE id=?${db.pool ? ' FOR UPDATE' : ''}`).get(quote.id);
      if (!locked || locked.deleted_at) {
        throw Object.assign(new Error(`货号 ${quote.quote_no} 已更新，请刷新后重新同步`), { code: 'LEGACY_BATCH_CONFLICT' });
      }
    }
    for (const { quote, latest } of prepared) {
      const current = await db.prepare(`SELECT id, status FROM quote_verification_versions
        WHERE quote_id=? ORDER BY version_no DESC LIMIT 1${db.pool ? ' FOR UPDATE' : ''}`).get(quote.id);
      if (!current || Number(current.id) !== Number(latest.id) || current.status !== 'completed') {
        throw Object.assign(new Error(`货号 ${quote.quote_no} 的核价版本已更新，请刷新后重新同步`), { code: 'LEGACY_BATCH_CONFLICT' });
      }
    }
    for (const { item, quote, latest, payloads } of prepared) {
      const versionNo = Number(latest.version_no) + 1;
      const label = `V${versionNo}`;
      const note = `Sky Castle 核价基准同步（${parsed.sourceDate}），来源：${parsed.sourceFile}`.slice(0, 1000);
      const versionInfo = await db.prepare(`INSERT INTO quote_verification_versions
        (quote_id, version_no, label, parent_version_id, source_type, status, note,
         created_by, created_at, completed_by, completed_at, updated_at)
        VALUES (?, ?, ?, ?, 'legacy_workbook', 'completed', ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(quote.id, versionNo, label, latest.id, note, actor, importedAt, actor, importedAt, importedAt);
      const versionId = Number(versionInfo.id);
      for (const department of departments) {
        await db.prepare(`INSERT INTO quote_verification_sections
          (version_id, dept, payload_json, status, filled_by, filled_at, reviewed_by, reviewed_at, review_comment)
          VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?)`)
          .run(versionId, department.code, JSON.stringify(payloads[department.code]), actor, importedAt,
            actor, importedAt, `核价基准总表同步：${parsed.sourceDate}`);
      }
      await db.prepare(`UPDATE quote_verifications
        SET status='completed', note=?, updated_by=?, updated_at=? WHERE quote_id=?`)
        .run(note, actor, importedAt, quote.id);
      await db.prepare(`INSERT INTO audit_log (quote_id, dept, actor, action, detail, at)
        VALUES (?, 'sales', ?, 'legacy_verification_batch_version', ?, ?)`)
        .run(quote.id, actor, JSON.stringify({
          customer,
          source_file: parsed.sourceFile,
          source_date: parsed.sourceDate,
          quote_no: item.quoteNo,
          parent_version: latest.label,
          version: label,
        }), importedAt);
      versions.push({ quoteId: Number(quote.id), quoteNo: item.quoteNo, versionId, versionNo, label });
    }
    return versions;
  });
  const versions = await tx();
  return {
    status: 'applied',
    customer,
    sourceDate: parsed.sourceDate,
    sourceFile: parsed.sourceFile,
    itemCount: versions.length,
    versions,
  };
}

module.exports = {
  COMPONENT_COLUMNS,
  buildPricingSummary,
  buildZuruPricingSummary,
  detailAnalysisSummary,
  parseLegacyDetailSheet,
  parseFlexibleLegacyDetailSheet,
  parseLegacyVerificationWorkbook,
  parseZuruVerificationWorkbook,
  backfillLegacyVerificationDetails,
  importLegacyVerificationItems,
  createLegacyVerificationBatchVersion,
};
