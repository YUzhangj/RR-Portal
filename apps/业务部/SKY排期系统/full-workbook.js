const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const path = require('node:path').posix;
const fs = require('node:fs/promises');

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const children = (node, name) => Array.from(node.childNodes).filter(n => n.nodeType === 1 && n.localName === name);
const elements = (node, name) => Array.from(node.getElementsByTagNameNS(NS, name));
const column = address => address.replace(/[0-9]/g, '');
const colNum = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const xml = new XMLSerializer();
async function readXml(zip, name) {
  const file = zip.file(name);
  if (!file) throw new Error('原表缺少工作簿组件 ' + name);
  return new DOMParser().parseFromString(await file.async('string'), 'application/xml');
}
function keyColumns(type, order) {
  if (type === 'skycastle') return order ? [4, 5] : [7, 8];
  if (type === 'tomy') return order ? [3, 5] : [6, 8];
  if (type === 'jaz_plastic') return order ? [5, 6] : [7, 8];
  return order ? [6, 7] : [8, 9];
}
function key(po, sku) {
  if (!String(po ?? '').trim() || !String(sku ?? '').trim()) throw new Error('订单缺少 PO 号或货号');
  return JSON.stringify([String(po).trim(), String(sku).trim()]);
}
function originalValue(cell, strings) {
  if (!cell) return '';
  if (cell.getAttribute('t') === 'inlineStr') return elements(cell,'t').map(n=>n.textContent).join('');
  const value = children(cell,'v')[0]?.textContent || '';
  return cell.getAttribute('t') === 's' ? strings[Number(value)] : value;
}
function writeCell(doc, row, source) {
  const letters = column(source.address);
  const cells = children(row, 'c');
  let cell = cells.find(c=>column(c.getAttribute('r')) === letters);
  if (cell && children(cell,'f').length) return;
  if (!cell) {
    cell = doc.createElementNS(NS,'c');
    cell.setAttribute('r',letters + row.getAttribute('r'));
    row.insertBefore(cell, cells.find(c=>colNum(column(c.getAttribute('r'))) > colNum(letters)) || null);
  }
  for (const child of [...children(cell,'v'), ...children(cell,'is')]) cell.removeChild(child);
  const number = typeof source.value === 'number';
  const date = number && source.numFmt?.startsWith('yyyy/');
  cell.setAttribute('t', date ? 'd' : number ? 'n' : 'inlineStr');
  const child = doc.createElementNS(NS, number ? 'v' : 'is');
  if (number) child.appendChild(doc.createTextNode(date ? new Date((source.value - 25569) * 86400000).toISOString().slice(0,10) : String(source.value)));
  else {
    const t = doc.createElementNS(NS,'t');
    t.setAttribute('xml:space','preserve');
    t.appendChild(doc.createTextNode(String(source.value)));
    child.appendChild(t);
  }
  cell.insertBefore(child,children(cell,'extLst')[0] || null);
}
async function addDiversionSheet(zip, book, rels, generatedSheet, names) {
  const sheets = elements(book, 'sheets')[0];
  const sheetIds = elements(book,'sheet').map(sheet=>Number(sheet.getAttribute('sheetId')));
  let id = Math.max(0,...sheetIds) + 1;
  while (zip.file(`xl/worksheets/sheet${id}.xml`) ||
    Array.from(rels.documentElement.childNodes).some(r=>r.getAttribute?.('Id') === `skyHint${id}`)) id++;
  let name = '扣数提示';
  for (let n = 2; names.has(name); n++) name = '扣数提示' + n;
  const sheet = book.createElementNS(NS,'sheet');
  const relationshipNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  sheet.setAttribute('name',name);
  sheet.setAttribute('sheetId',String(id));
  sheet.setAttributeNS(relationshipNS,'r:id',`skyHint${id}`);
  sheets.appendChild(sheet);
  const rel = rels.createElementNS(rels.documentElement.namespaceURI,'Relationship');
  rel.setAttribute('Id',`skyHint${id}`);
  rel.setAttribute('Type',relationshipNS + '/worksheet');
  rel.setAttribute('Target',`worksheets/sheet${id}.xml`);
  rels.documentElement.appendChild(rel);
  const types = await readXml(zip,'[Content_Types].xml');
  const override = types.createElementNS(types.documentElement.namespaceURI,'Override');
  override.setAttribute('PartName',`/xl/worksheets/sheet${id}.xml`);
  override.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
  types.documentElement.appendChild(override);
  const doc = new DOMParser().parseFromString(`<worksheet xmlns="${NS}"><sheetData/></worksheet>`,'application/xml');
  const data = elements(doc,'sheetData')[0];
  generatedSheet.eachRow(source=>{
    const row = doc.createElementNS(NS,'row');
    row.setAttribute('r',String(source.number));
    source.eachCell(cell=>writeCell(doc,row,cell));
    data.appendChild(row);
  });
  zip.file(`xl/worksheets/sheet${id}.xml`,xml.serializeToString(doc));
  zip.file('[Content_Types].xml',xml.serializeToString(types));
  zip.file('xl/_rels/workbook.xml.rels',xml.serializeToString(rels));
}
async function writeFullWorkbook(original, output, generated, type, orders) {
  const zip = await JSZip.loadAsync(await fs.readFile(original));
  const book = await readXml(zip,'xl/workbook.xml');
  const rels = await readXml(zip,'xl/_rels/workbook.xml.rels');
  const strings = zip.file('xl/sharedStrings.xml') ? elements(await readXml(zip,'xl/sharedStrings.xml'),'si').map(s=>elements(s,'t').map(t=>t.textContent).join('')) : [];
  const src = new Map(elements(book,'sheet').map(s=>[s.getAttribute('name'),s]));
  const ids = new Map(Array.from(rels.documentElement.childNodes).filter(n=>n.nodeType===1).map(r=>[r.getAttribute('Id'),r.getAttribute('Target')]));
  const expected = new Set();
  const client = {skycastle:'Sky Castle',tomy:'TOMY',jaz_plastic:'JAZ',jaz_costume:'JAZ'}[type];
  for (const po of orders) {
    if (po.error || po.client !== client || !po.items?.length) throw new Error('PO 解析结果与排期模板不匹配，请核对');
    for (const item of po.items) {
      const id = key(po.poNumber,item.partNo);
      if (expected.has(id)) throw new Error('本批 PO 号与货号重复，请核对分批明细');
      expected.add(id);
    }
  }
  const written = [new Set(), new Set()];
  if (!expected.size) throw new Error('没有可写入的订单');
  for (const sheet of generated.worksheets) {
    if (sheet.name === '扣数提示') {
      await addDiversionSheet(zip,book,rels,sheet,src);
      continue;
    }
    const name = sheet.name.replace(/-粘贴用$/,'');
    const order = name.endsWith('接单');
    const [pc, sc] = keyColumns(type,order);
    const updates = [];
    sheet.eachRow(row=>{
      const po = row.getCell(pc).value, sku = row.getCell(sc).value;
      if (po && sku && expected.has(key(po,sku))) updates.push(row);
    });
    const target = src.get(name);
    if (!target && !updates.length) continue;
    if (!target) throw new Error('原表缺少工作表 ' + name);
    const rel = ids.get(target.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id'));
    const file = rel.startsWith('/') ? rel.slice(1) : path.join('xl',rel);
    const doc = await readXml(zip,file);
    const data = elements(doc,'sheetData')[0];
    const indexed = new Map();
    let last = 0;
    for (const row of children(data,'row')) {
      last = Math.max(last,Number(row.getAttribute('r')));
      const cells = new Map(children(row,'c').map(c=>[colNum(column(c.getAttribute('r'))),originalValue(c,strings)]));
      if (!cells.get(pc) || !cells.get(sc)) continue;
      const id = key(cells.get(pc),cells.get(sc));
      if (indexed.has(id) && expected.has(id)) throw new Error(name+' 有多条同 PO、同货号记录，无法确定修改行');
      indexed.set(id,row);
    }
    const routed = new Set(updates.map(r=>key(r.getCell(pc).value,r.getCell(sc).value)));
    if (!order && [...indexed.keys()].some(id=>expected.has(id) && !routed.has(id))) {
      throw new Error('原排期与本次选择的目标工作表不同，请先核对历史行');
    }
    if (!updates.length) continue;
    for (const delta of updates) {
      const id = key(delta.getCell(pc).value,delta.getCell(sc).value);
      const processed = written[order ? 0 : 1];
      if (processed.has(id)) throw new Error('同一订单重复写入，请核对');
      processed.add(id);
      let row = indexed.get(id);
      const existing = Boolean(row);
      if (!row) {
        if (++last > 1048576) throw new Error('原表已达到行数上限');
        row = doc.createElementNS(NS,'row');
        row.setAttribute('r',String(last));
        data.appendChild(row);
      }
      const revisionColumns = type === 'skycastle' ? (order ? [2,6,78,79,80] : [10,15,16,40,41,42])
        : type === 'tomy' ? (order ? [6,7,55,56,57] : [10,13,...(src.has('KIK总排期') || src.has('RRM总排期') ? [25,26,27] : [23,24,25])])
        : type === 'jaz_plastic' ? (order ? [2,3,7,42,43,44] : [5,10,13,14,26,27,28])
        : (order ? [2,3,8,212,213,214] : [5,11,14,15,28,29,30]);
      // Product quantity columns are populated by the template header lookup.
      const firstProduct = type === 'tomy' ? 8 : type === 'skycastle' ? 9 : 10;
      const lastProduct = {tomy:51,skycastle:74,jaz_plastic:39,jaz_costume:205}[type];
      delta.eachCell((c,n)=>{
        const productQty = order && n >= firstProduct && n <= lastProduct;
        if (!existing || productQty || revisionColumns.includes(n)) writeCell(doc,row,c);
      });
    }
    const dim = elements(doc,'dimension')[0];
    if (dim) dim.parentNode.removeChild(dim);
    zip.file(file,xml.serializeToString(doc));
  }
  if (written.some(s=>s.size !== expected.size)) throw new Error('部分 PO 明细没有对应的接单或排期工作表，请核对模板');
  const calc = elements(book,'calcPr')[0];
  if (calc) calc.setAttribute('fullCalcOnLoad','1');
  zip.file('xl/workbook.xml',xml.serializeToString(book));
  await fs.writeFile(output,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
}
module.exports = { writeFullWorkbook };
