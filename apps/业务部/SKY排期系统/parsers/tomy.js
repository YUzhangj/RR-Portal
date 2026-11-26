/**
 * TOMY PO PDF 解析器
 *
 * pdf-parse提取后行项目格式(无空格):
 *   47280A00-RR28 Jan 20261,210EA11.276013,643.96
 *   即: PartNo + 00-RR + Date + Qty + EA + UnitPrice(4位小数) + Amount(2位小数)
 */

function detect(text) {
  return text.includes('TOMY (HONG KONG) LIMITED') || text.includes('TOMY(HONG KONG)');
}

function parse(text, filename) {
  const result = {
    client: 'TOMY',
    poNumber: '',
    poDate: '',
    customerPO: '',
    customerID: '',
    items: [],
    filename,
  };

  // Extract header
  const poNoMatch = text.match(/Purchase Order No\s*[:\n]\s*(\d+)/);
  if (poNoMatch) result.poNumber = poNoMatch[1];

  const poDateMatch = text.match(/Purchase Order Date\s*[:\n]\s*(\d{1,2}\s+\w+\s+\d{4})/);
  if (poDateMatch) result.poDate = parseDate(poDateMatch[1]);

  const custPOMatch = text.match(/Customer PO No[:\s]+(\S+)/);
  if (custPOMatch) result.customerPO = custPOMatch[1];

  const custIDMatch = text.match(/Customer ID\s*[:\n]\s*(\S+)/);
  if (custIDMatch) result.customerID = custIDMatch[1];

  // 客跟单 (Handle By)
  const handleMatch = text.match(/Handle By\s*[:\n]\s*(\w+),\s*(\w+)/);
  if (handleMatch) result.handleBy = handleMatch[2]; // 取名（Nancy, Toby, Gary等）

  // 客名 (Customer Name from Shipment Info)
  const custNameMatch = text.match(/Customer Name:\s*(.+?)(?:\n|Ship)/);
  if (custNameMatch) result.customerName = custNameMatch[1].trim();

  // Parse line items
  // 货号行格式（PartNo + 00-RR + Date + Qty + EA），后面跟价格金额，有两种形式：
  //   (a) 标准:  Price(4dec) + Amount(2dec)              如 "11.276013,643.96"
  //   (b) 待定价: "TO BE\nADVISED\n" + Amount(2dec=0.00)  如 "TO BE ADVISED\n0.00"
  const linePattern = /(\w[\w-]*)00-RR(\d{1,2}\s+\w{3}\s+\d{4})([\d,]+)EA/g;

  let match;
  while ((match = linePattern.exec(text)) !== null) {
    const partNo = match[1];
    const dueDate = parseDate(match[2]);
    const quantity = parseInt(match[3].replace(/,/g, ''), 10);

    // 在 EA 后面 200 字符内找价格 + 金额
    const afterEA = text.substring(match.index + match[0].length, match.index + match[0].length + 200);
    let unitPrice = 0;
    let amount = 0;
    let isTBA = false;
    const stdMatch = afterEA.match(/^(\d+\.\d{4})([\d,]+\.\d{2})/);
    if (stdMatch) {
      unitPrice = parseFloat(stdMatch[1]);
      amount = parseFloat(stdMatch[2].replace(/,/g, ''));
    } else {
      const tbaMatch = afterEA.match(/^\s*TO\s+BE\s*\n?\s*ADVISED\s*\n?\s*([\d,]+\.\d{2})/i);
      if (tbaMatch) {
        unitPrice = 0;
        amount = parseFloat(tbaMatch[1].replace(/,/g, ''));
        isTBA = true;
      }
    }

    // Look for context after this match
    const afterMatch = text.substring(match.index, Math.min(text.length, match.index + 600));

    // Find destination country
    const countryMatch = afterMatch.match(/Destination Country:\s*\n?\s*([A-Z][A-Z ]+)/);
    const country = countryMatch ? countryMatch[1].trim() : '';

    // Find purchase point (RR01 or RR02)
    const ppMatch = afterMatch.match(/\n(RR0[12])\n/);
    const purchasePoint = ppMatch ? ppMatch[1] : '';

    // Find product description (after purchase point line)
    const descMatch = afterMatch.match(/\n(?:RR0[12])\n(.+?)(?:\n)/);
    const description = descMatch ? descMatch[1].trim() : '';

    // Check for diversion: "Xxxpcs from PO#YYYY" or "Xxxpcs to PO#YYYY"
    const packingContext = text.substring(match.index, Math.min(text.length, match.index + 1000));
    const fromPO = packingContext.match(/(\d[\d,]*)\s*pcs?\s+from\s+PO#?(\d+)/i);
    const toPO = packingContext.match(/(\d[\d,]*)\s*pcs?\s+to\s+PO#?(\d+)/i);

    const itemData = {
      partNo,
      custPartNo: partNo,
      description,
      dueDate,
      quantity,
      unitPrice,
      amount,
      country: mapCountry(country),
      purchasePoint,
      factory: purchasePoint === 'RR01' ? '东莞' : purchasePoint === 'RR02' ? '印尼' : '',
    };
    if (isTBA) itemData.priceTBA = true;

    // 扣数信息
    if (fromPO) {
      // 本PO的数量是从旧PO扣过来的
      itemData.divertedFrom = {
        sourcePO: fromPO[2],
        qty: parseInt(fromPO[1].replace(/,/g, ''), 10),
      };
    }
    if (toPO) {
      // 本PO的数量被扣到新PO去了（本行已是扣后数量）
      itemData.divertedTo = {
        targetPO: toPO[2],
        qty: parseInt(toPO[1].replace(/,/g, ''), 10),
      };
    }

    result.items.push(itemData);
  }

  // 补全缺失国家：用同PO内其他行的国家填充（跨页导致个别行漏识别）
  const knownCountry = result.items.find(i => i.country)?.country || '';
  result.items.forEach(i => { if (!i.country) i.country = knownCountry; });

  // 补全缺失工厂
  const knownFactory = result.items.find(i => i.factory)?.factory || '';
  result.items.forEach(i => { if (!i.factory) i.factory = knownFactory; });

  return result;
}

function parseDate(dateStr) {
  if (!dateStr) return '';
  const months = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
  };
  const m = dateStr.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (m) {
    return `${m[3]}-${months[m[2]] || '01'}-${m[1].padStart(2, '0')}`;
  }
  return dateStr;
}

function mapCountry(country) {
  const map = {
    'BELGIUM': '比利时', 'UNITED STATES': '美国', 'USA': '美国',
    'UNITED KINGDOM': '英国', 'AUSTRALIA': '澳大利亚', 'FRANCE': '法国',
    'GERMANY': '德国', 'NETHERLANDS': '荷兰', 'SPAIN': '西班牙',
    'ITALY': '意大利', 'JAPAN': '日本', 'CANADA': '加拿大',
    'TURKEY': '土耳其', 'BRAZIL': '巴西', 'URUGUAY': '乌拉圭',
    'ROMANIA': '罗马尼亚', 'INDONESIA': '印尼', 'GREECE': '希腊',
    'MEXICO': '墨西哥', 'CHINA': '中国', 'POLAND': '波兰',
    'SERBIA': '塞尔维亚', 'IRELAND': '爱尔兰', 'INDIA': '印度',
    'SOUTH KOREA': '韩国', 'KOREA': '韩国', 'THAILAND': '泰国',
    'VIETNAM': '越南', 'MALAYSIA': '马来西亚', 'SINGAPORE': '新加坡',
    'PHILIPPINES': '菲律宾', 'MONGOLIA': '蒙古', 'NEW ZEALAND': '新西兰',
    'SOUTH AFRICA': '南非', 'SWEDEN': '瑞典', 'NORWAY': '挪威',
    'DENMARK': '丹麦', 'FINLAND': '芬兰', 'AUSTRIA': '奥地利',
    'SWITZERLAND': '瑞士', 'PORTUGAL': '葡萄牙', 'CZECH REPUBLIC': '捷克',
    'HUNGARY': '匈牙利', 'CROATIA': '克罗地亚',
  };
  return map[country] || country || '';
}

module.exports = { detect, parse };
