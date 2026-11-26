/**
 * JAZWARES PO PDF 解析器
 *
 * PDF 格式特征:
 *   - 顶部有 "Purchase Order" + "PO # :Date :" + "{PO#}{Date}"
 *   - SHIP TO 块，随后是版本 "V{N}" + 客户名 + 国家
 *   - Item 块:
 *       描述(多行)
 *       风格编号(可选, 如 "037-008-1-0003")
 *        {Qty} {Price} {Amount}     ← 数字行
 *       {原PO}(可选, 如 "JAZ283000")
 *        {PCS/CTN}                  ← 装箱数
 *       {ITEM#}                    ← 货号 (SKU)
 */

const COUNTRY_MAP = {
  'USA': '美国', 'US': '美国', 'UNITED STATES': '美国', 'AMERICA': '美国',
  'CANADA': '加拿大',
  'GERMANY': '德国', 'DEUTSCHLAND': '德国',
  'UK': '英国', 'UNITED KINGDOM': '英国', 'ENGLAND': '英国',
  'FRANCE': '法国', 'SPAIN': '西班牙', 'ITALY': '意大利',
  'MEXICO': '墨西哥', 'JAPAN': '日本', 'AUSTRALIA': '澳大利亚',
  'NETHERLANDS': '荷兰', 'BELGIUM': '比利时',
  'BRAZIL': '巴西', 'POLAND': '波兰', 'PORTUGAL': '葡萄牙',
  'CHINA': '中国', 'HONG KONG': '香港', 'JORDAN': '约旦',
  'IRELAND': '爱尔兰', 'SWEDEN': '瑞典', 'NORWAY': '挪威',
  'DENMARK': '丹麦', 'FINLAND': '芬兰', 'AUSTRIA': '奥地利',
};

function detect(text) {
  if (!/purchase order/i.test(text)) return false;
  if (!/jazwares/i.test(text)) return false;
  if (!/royal\s+regent/i.test(text)) return false;
  // PO# 字段位置固定
  return /PO\s*#\s*:.*Date\s*:/i.test(text);
}

function parse(text, filename) {
  const result = {
    client: 'JAZ',
    poNumber: '',
    poVersion: '',
    poDate: '',
    shipDate: '',
    customerName: '',
    country: '',
    packaging: '',
    notes: '',
    items: [],
    filename,
  };

  const lines = text.split('\n');

  // -- 1. PO # + Date --
  // pdf-parse 输出: "PO # :Date :" 下一行 "{PO#}{Date}"
  // e.g., "JAZ28317512/17/2025", "POGE000067022/12/2026", "INT2934913/10/2026"
  // 日期校验月 1-12、日 1-31，避免把 "POGE0000670+22/12/2026" 错拆成 "POGE0000670+22"
  for (let i = 0; i < lines.length - 1; i++) {
    if (/PO\s*#\s*:.*Date\s*:/i.test(lines[i])) {
      const next = (lines[i + 1] || '').trim();
      const m = next.match(/^(.+?)((?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/\d{4})$/);
      if (m) {
        result.poNumber = m[1].trim();
        result.poDate = parseDate(m[2]);
      }
      break;
    }
  }

  // -- 2. Version + Customer + Country --
  // V{N} 后紧跟 Customer Name (和 Country，若有)
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^V\d+$/.test(t)) {
      result.poVersion = t;
      let ci = i + 1;
      while (ci < lines.length && lines[ci].trim() === '') ci++;
      if (ci < lines.length) {
        result.customerName = lines[ci].trim();
        let cj = ci + 1;
        while (cj < lines.length && lines[cj].trim() === '') cj++;
        if (cj < lines.length) {
          const next = lines[cj].trim();
          // 不是 "Fty Code." 且长度合理 → 视为国家
          if (!/^Fty/i.test(next) && next.length > 0 && next.length < 40 && !/\d{4}/.test(next)) {
            result.country = mapCountry(next);
          }
        }
      }
      break;
    }
  }

  // Customer name 里也可能带 "CANADA" / "US" 等暗示国家
  if (!result.country && result.customerName) {
    const cn = result.customerName.toUpperCase();
    for (const [en, cn2] of Object.entries(COUNTRY_MAP)) {
      if (cn.includes(en)) { result.country = cn2; break; }
    }
    // 兜底：ECOM DOM / DOMESTIC 通常是 US
    if (!result.country && /\b(ECOM\s*DOM|DOMESTIC|\bUS\b|AMZ)/i.test(cn)) result.country = '美国';
  }

  // -- 3. Ship Date (走货期) --
  // "TERMSSHIP DATEINTERNAL REFFOB" 后面一行是日期
  for (let i = 0; i < lines.length - 1; i++) {
    if (/SHIP\s*DATE/i.test(lines[i])) {
      // 在后面 6 行内找日期
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const dm = lines[j].match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
        if (dm) { result.shipDate = parseDate(dm[1]); break; }
      }
      break;
    }
  }

  // -- 3.5 INTERNAL REF (客户 PO 号) --
  // "ASST" 后一行格式: "{INTERNAL_REF}{PORT}"，PORT 常见为 Yantian/Shanghai 等
  // 例如: "WCT-26030536802Yantian" / "0092533278Yantian"
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*ASST\s*$/i.test(lines[i])) {
      let next = (lines[i + 1] || '').trim();
      next = next.replace(/(Yantian|YANTIAN|Shanghai|SHANGHAI|Ningbo|NINGBO|Shenzhen|SHENZHEN|HK|HongKong)\s*$/i, '').trim();
      if (next) result.internalRef = next;
      break;
    }
  }

  // 对 Re:FOB 类型的 PDF（"PO #" 字段是 FOB 开头），真正的客户 PO 号是 INTERNAL REF。
  // 例：PDF 头部 PO # 显示 "FOB291654"（RR 内部 FOB 号，不入排期），
  //     INTERNAL REF 显示 "0092533278"（这才是客户实际 PO 号）。
  const isReFOB = /\(Re:FOB\)/i.test(text) || /^FOB\d+/i.test(result.poNumber);
  if (isReFOB && result.internalRef) {
    result.fobNumber = result.poNumber;       // 保留原 FOB 号备查
    result.poNumber = result.internalRef;     // 用 INTERNAL REF 作为 PO 号
  }

  // -- 4. Notes / Packaging (REMARKS 块) --
  const remarksIdx = text.search(/REMARKS:/i);
  if (remarksIdx >= 0) {
    const afterRemarks = text.substring(remarksIdx, remarksIdx + 800);
    result.notes = afterRemarks.split(/The Purchase Order will be deemed|USD\s*\n\s*Total|Order Questions/)[0].trim();

    // 包装版本：找 NL PACKAGING 或 NL - LANG 模式
    //   "2) 4L PACKAGING (ENGLISH/FRENCH/SPANISH...)"
    //   "2) INTL. 7L PACKAGING (..."
    //   "2) 3L – ENGLISH/FRENCH/SPANISH"
    let pkgMatch = afterRemarks.match(/(\d+L)\s+PACKAGING\b/i);
    if (!pkgMatch) pkgMatch = afterRemarks.match(/\b(\d+L)\s*[-–—]\s*[A-Z]+/i);
    // 排期表历史命名习惯: "7L包装"、"2L包装" 等
    if (pkgMatch) result.packaging = pkgMatch[1].toUpperCase() + '包装';
  }

  // -- 5. Items --
  // 数字行: " {qty} {price} {amount}"，price 通常 4 位小数，amount 通常 2 位小数
  const qtyPricePattern = /^\s+([\d,]+)\s+([\d.]+)\s+([\d,]+\.\d{2})\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(qtyPricePattern);
    if (!m) continue;

    const quantity = parseInt(m[1].replace(/,/g, ''), 10);
    const unitPrice = parseFloat(m[2]);
    const amount = parseFloat(m[3].replace(/,/g, ''));
    if (isNaN(quantity) || isNaN(unitPrice) || isNaN(amount)) continue;
    if (quantity === 0) continue;  // 跳过 0 数量的占位行（常见于被扣完的历史行）

    // 向后找: 原PO (可选) / 装箱数 / 货号
    let idx = i + 1;
    let originalPO = '';
    let cartonPack = 0;
    let partNo = '';

    const skipBlank = () => { while (idx < lines.length && lines[idx].trim() === '') idx++; };

    skipBlank();
    // 原PO: JAZ/POGE/POUK/INT/FOB + 数字
    if (idx < lines.length) {
      const t = lines[idx].trim();
      if (/^(JAZ|POGE|POUK|INT|FOB|PO[A-Z]*)\d{3,}$/i.test(t)) {
        originalPO = t;
        idx++;
        skipBlank();
      }
    }

    // PCS/CTN (装箱数): 单独一行纯整数
    if (idx < lines.length) {
      const t = lines[idx].trim();
      const nm = t.match(/^(\d{1,4})$/);
      if (nm) {
        cartonPack = parseInt(nm[1], 10);
        idx++;
        skipBlank();
      }
    }

    // ITEM# (货号): 单独一行字母开头的 SKU
    if (idx < lines.length) {
      const t = lines[idx].trim();
      const skuM = t.match(/^([A-Z][A-Z0-9]*\d[A-Z0-9\-]*)$/);
      if (skuM) partNo = skuM[1];
    }

    // 向前找描述（越过 style ref，遇到 header 关键词就停）
    const descLines = [];
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const pj = lines[j].trim();
      if (!pj) continue;
      // 跳过 style ref
      if (/^\d{3}-\d{3}-\d+-?\d*$/.test(pj)) continue;
      // 遇到 header 关键词就停（"GLOBAL", "PO", "ATTRIBUTES", "ASST", "TERMS", "FOB" 等都不是描述）
      if (/^(GLOBAL|PO|ATTRIBUTES|ASST|TERMS|FOB|YANTIAN)$/i.test(pj)) break;
      // 上一个 item 的 qty 行
      if (qtyPricePattern.test(lines[j])) break;
      // 上一个 item 的 SKU
      if (/^[A-Z][A-Z0-9]*\d+$/.test(pj) && pj.length < 20) break;
      descLines.unshift(pj);
      if (descLines.length >= 3) break;
    }
    const description = descLines.join(' ').trim();

    if (partNo) {
      const item = {
        partNo,
        description,
        quantity,
        unitPrice,
        amount,
        cartonPack: cartonPack || 0,
        dueDate: result.shipDate,
        country: result.country,
      };
      if (originalPO) {
        // 原PO → 转单 (本 PO 接收了其他 PO 转来的数量)
        item.divertedFrom = { sourcePO: originalPO, qty: quantity };
      }
      result.items.push(item);
    }
  }

  return result;
}

function parseDate(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return s;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function mapCountry(s) {
  if (!s) return '';
  const upper = s.trim().toUpperCase();
  if (COUNTRY_MAP[upper]) return COUNTRY_MAP[upper];
  for (const [en, cn] of Object.entries(COUNTRY_MAP)) {
    if (upper.includes(en)) return cn;
  }
  return s.trim();
}

module.exports = { detect, parse };
