'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const E = require('../frontend/excel-formulas');
const {sourceRows, productBounds, sheetLayout, buildModel, parseExcelVerificationWorkbook} = require('../backend/services/excelVerificationImport');

test('product range includes the complete tax results but excludes the next product', () => {
  const sheet = { '!ref': 'A1:XFD90', A1:{v:'ABS'}, B1:{v:6.5},
    A12:{v:'第一款'}, B20:{v:'货价'}, C20:{v:'进口料'}, B21:{v:10}, C21:{v:4},
    M30:{v:'合计减税'}, M32:{v:1}, N32:{v:9},
    A35:{v:'第二款'}, B40:{v:'货价'}, C40:{v:'进口料'}, B41:{v:20}, C41:{v:8},
    M50:{v:'合计减税'}, M52:{v:2}, N52:{v:18} };
  assert.equal(sourceRows(sheet).length,52);
  const legacy = {source_detail_sheet:'S', source_detail_range:'A28:X49', source_item:'第二款'};
  const bounds = productBounds(sheet, legacy, 'Cepia');
  assert.deepEqual(bounds,{s:{r:34,c:0},e:{r:51,c:23}});
  const layout = sheetLayout(sheet,bounds,11);
  assert.equal(layout.rowIndices.includes(31),false);
  assert.equal(layout.rowIndices.includes(51),true);
  assert.ok(layout.columns < 30);
});

test('block imports retain original addresses, dependency formulas, borders and merges', () => {
  const line = {style:'thin',color:'#000000'};
  const sheet = {'!ref':'A1:XFD120', '!merges':[{s:{r:49,c:0},e:{r:49,c:1}}],
    '!sourceBorders':{A51:{bottom:line},A20:{bottom:line}},
    B2:{v:0.87}, A20:{v:'不相关货号'}, A50:{v:'当前货号'},
    C51:{v:2/0.87,f:'2/$B$2'}, B60:{v:'货价'},C60:{v:'进口料'},B61:{v:10},C61:{v:2/0.87,f:'C51'},
    M65:{v:'合计减税'}, M67:{v:0.2,f:'0.1*2'}, N65:{v:'减税后成本'},N67:{v:9.8,f:'B61-M67'},
    A100:{v:'下一款'}};
  const item = {salesPayload:{legacy_import:{pricing_tail:[]}},departmentPayloads:{engineering:{legacy_items:[{source_row:51}]}}};
  const model = buildModel({Sheets:{S:sheet}},'S',item,{bounds:{s:{r:49,c:0},e:{r:66,c:13}},sharedRows:9});
  assert.equal(model.cells['S!C51'].f,'2/$B$2');
  assert.equal(model.cells['S!A20'],undefined);
  assert.equal(model.cells['S!A100'],undefined);
  assert.equal(model.metrics.after_cost,'S!N67');
  assert.equal(model.layout.borders.A20,undefined);
  assert.deepEqual(model.layout.borders.A51,{bottom:line});
  assert.equal(model.layout.merges.length,1);
  assert.equal(E.createEvaluator(model,{'S!B2':{v:0.8}}).value('S!C61'),2.5);
});

for (const [customer, env, expected] of [
  ['Sky Castle','SKY_NATIVE_TEST_FILE',31],['Cepia','CEPIA_NATIVE_TEST_FILE',42],
  ['ZANZOON','ZANZOON_NATIVE_TEST_FILE',25],['嘉苏A','ZANZOON_NATIVE_TEST_FILE',2],
]) test(`${customer}: actual source values, formulas, tax metrics and layout survive import`, {skip:!process.env[env]}, () => {
  const file = process.env[env], parsed = parseExcelVerificationWorkbook(file,{customer});
  const workbook = XLSX.readFile(file,{cellFormula:true,cellNF:true,cellStyles:true});
  assert.equal(parsed.items.length,expected);
  for (const item of parsed.items) {
    const legacy = item.salesPayload.legacy_import, model = legacy.excel_model;
    assert.equal(legacy.excel_audit.differences.length,0,item.quoteNo);
    assert.ok(model.metrics.total && model.metrics.deduction && model.metrics.after_cost,item.quoteNo);
    assert.ok(Object.keys(model.layout.borders).length > 10,item.quoteNo);
    if (customer === 'Cepia' || customer === 'ZANZOON' || customer === '嘉苏A') assert.ok(model.layout.rowIndices.length < 170,item.quoteNo);
    const rows = new Set(model.layout.rowIndices || Array.from({length:model.layout.rows},(_,r)=>r));
    // Every displayed source value and formula is imported, including cells
    // unrelated to the summary calculation. Nothing is replaced by a unit price.
    for (const [address, source] of Object.entries(workbook.Sheets[model.sheet])) {
      if(address.startsWith('!') || !rows.has(XLSX.utils.decode_cell(address).r) || (source.v == null && !source.f)) continue;
      const cell = model.cells[E.key(model.sheet,address)];
      assert.ok(cell,`${item.quoteNo} ${address}`);
      assert.equal(cell.v,source.v ?? null);
      assert.equal(cell.f,source.f || undefined);
    }
    for (const [id,cell] of Object.entries(model.cells)) {
      if (!cell.f || cell.external_input) continue;
      try { for (const ref of E.references(cell.f,E.split(id)[0])) assert.ok(model.cells[ref],`${id} missing ${ref}`); }
      catch(error) { if(!/暂不支持函数|无法识别公式/.test(error.message)) throw error; }
    }
  }
  if (customer==='Cepia') {
    const fish=parsed.items.find(i=>i.quoteNo==='Z1000').salesPayload.legacy_import.excel_model;
    assert.equal(fish.metrics.deduction,'Cepia产品核价3月核价!M97');
    assert.ok(!fish.layout.rowIndices.includes(98));
    assert.ok(E.createEvaluator(fish,{'Cepia产品核价3月核价!D95':{v:0.2}}).value(fish.metrics.deduction)
      > E.createEvaluator(fish).value(fish.metrics.deduction));
  }
});
