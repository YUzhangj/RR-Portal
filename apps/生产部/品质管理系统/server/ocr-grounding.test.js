'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Execute actual production declarations, with only a synthetic model provider.
// Do not start server.js or read its AI configuration/database/environment.
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const block = source.slice(source.indexOf('const OCR_READ_PROMPT ='), source.indexOf('/* ── 记录表列顺序'));
const plain = value => JSON.parse(JSON.stringify(value));
function runtime(responses = []) {
  const calls = [];
  const ctx = vm.createContext({
    AI: { ready: true, baseURL: 'https://fixture.invalid/v1', apiKey: 'fixture', ocrModel: 'fixture-model' },
    console: { warn() {} }, setTimeout: fn => fn(),
    fetch: async (_url, request) => {
      calls.push(JSON.parse(request.body));
      assert(responses.length, 'Unexpected extra provider call');
      const response = responses.shift();
      const data = typeof response === 'string' ? { choices: [{ message: { content: response } }] } : response;
      return { status: 200, text: async () => JSON.stringify(data) };
    },
  });
  vm.runInContext(block + ';globalThis.actual={_parseGrounding,parseDeliveryNote,aiVisionExtract};', ctx);
  return { ground: text => plain(ctx.actual._parseGrounding(text)), parse: text => plain(ctx.actual.parseDeliveryNote(text)),
    extract: async () => plain(await ctx.actual.aiVisionExtract('data:image/png;base64,fixture')), calls };
}
const goods = '|货号|品名|数量|单位|\n|SKU001|合成零件|100|个|';
const box = (angle, text, textFirst = false) => textFirst ? { text, rotate_rect: [-1, -2, 10, 20, angle] } : { rotate_rect: [-1, -2, 10, 20, angle], text };
const pending = (fields, original) => {
  assert.equal(fields.items.length, 1);
  assert.equal(fields.items[0].quantityNeedsReview, true);
  assert.equal(fields.items[0].qty, ''); assert.equal(fields.items[0].productNo, '');
  assert.equal(fields.items[0].productName, '待核对原文：' + original);
};

test('ordinary goods containing rotate_rect as text are not mistaken for grounding JSON', () => {
  const r=runtime(),text='|货号|品名|数量|单位|\n|SKU001|rotate_rect零件|100|PCS|';
  assert.equal(r.ground(text),null);
  const fields=r.parse(text);assert.equal(fields.items.length,1);assert.equal(fields.items[0].qty,'100');
  assert.equal(fields.items[0].quantityNeedsReview,undefined);
});

test('grounding uses complete JSON, independent keys, unicode and exact backslash/newline decoding', () => {
  const r = runtime(), text = '品名\nC:\\new\\tools\t"原文"';
  const encoded = JSON.stringify({ blocks: [box(0, text, true)] }).replace('品名', '\\u54c1\\u540d');
  const parsed = r.ground(encoded);
  assert.equal(parsed.invalid, false); assert.equal(parsed.text, text); assert.equal(parsed.angle, 0);
  const fenced = '```json\n' + JSON.stringify([box(0, goods)]) + '\n```';
  assert.equal(r.parse(fenced).items[0].qty, '100');
});

test('all fragments contribute to rotation threshold, including reverse key order and unknown-angle text', () => {
  const r = runtime();
  const input = JSON.stringify([...Array.from({length:8},(_,i)=>box(0,'直立'+i,true)),box(90,'旋转1'),box(90,'旋转2')]);
  const result = r.ground(input);
  assert.equal(result.angle, 0); assert.equal(result.text.split('\n').length, 10);
  const unknown = JSON.stringify([...Array.from({length:6},(_,i)=>box(90,'旋转'+i)),...Array.from({length:4},(_,i)=>({text:'未知'+i}))]);
  assert.equal(r.ground(unknown).angle, 0);
  assert.equal(r.ground(JSON.stringify(Array.from({length:10},(_,i)=>box(44,i+'斜字')))).angle, 0);
});

for (const [angle, expected] of [[90,90],[-90,270],[180,180],[270,270],[450,90],[540,180]]) {
  test('signed/normalized grounding angle '+angle+' has a full 70% threshold', () => {
    const r = runtime();
    assert.equal(r.ground(JSON.stringify(Array.from({length:10},(_,i)=>box(i<7?angle:0,'文字'+i)))).angle, expected);
    assert.equal(r.ground(JSON.stringify(Array.from({length:10},(_,i)=>box(i<6?angle:0,'文字'+i)))).angle, 0);
  });
}

test('truncated, malformed and nonfinite grounding cannot turn partial content into a normal quantity', () => {
  const r = runtime();
  for (const input of [
    '[{"rotate_rect":[0,0,1,1,0],"text":"|货号|品名|数量|\\n| SKU001 | 合成零件 |100|"',
    'prefix ' + JSON.stringify([box(0,goods)]),
    JSON.stringify([{rotate_rect:'品名和数量100'}]),
    '[{"rotate_rect":[0,0,1,1,1e999],"text":"数量100"}]',
    JSON.stringify([box(0,goods),{rotate_rect:[0,0,1,1,'90'],text:'不完整片段'}]),
    JSON.stringify([box(0,goods),{rotate_rect:[0,0,1,1,90]}]),
  ]) { assert.equal(r.ground(input).invalid,true); pending(r.parse(input),input); }
});

test('column blocks retain short names, every PO and bare numbers for manual review without count pairing', () => {
  const r = runtime();
  for (const text of [
    'Description\n胶套外壳\n鸭子\nQty\n1,000',
    'Description\n胶套外壳\n鸭子\nQty\n1,000\n2,000',
    'Description\n胶套外壳\n1,000',
    'Description\n胶套外壳\nPO No: PO12345\n鸭子\nPO No: PO67890\nQty\n1,000\n2,000',
  ]) { const fields=r.parse(text);pending(fields,text);assert.equal(fields.orderNo,''); }
});

test('manual original rows containing company and NOTE are never deleted as global footer keywords', () => {
  const r=runtime();
  for (const name of ['公司标牌','有限长胶条','NOTEBOOK外壳']) {
    const raw='1.0 PO100001 SKU001 '+name+' 1000 10*20 650 KG';
    const fields=r.parse('序号 PO 货号 品名 数量 尺寸 重量\n'+raw);
    assert.equal(fields.items.length,1);assert.equal(fields.items[0].quantityNeedsReview,true);
    assert.equal(fields.items[0].productName,'待核对原行：'+raw);assert.equal(fields.items[0].qty,'');
  }
});

test('an existing manual original row stops retries and retains its original text instead of another SKU', async () => {
  const text='序号 PO 货号 品名 数量 尺寸 重量\n1.0 PO100001 SKU001 公司标牌 1000 10*20 650 KG';
  const r=runtime([text,goods]);const result=await r.extract();
  assert.equal(r.calls.length,1);assert.equal(result.rawText,text);assert.equal(result.needsManualReview,true);
  assert.equal(result.fields.items[0].quantityNeedsReview,true);assert(result.fields.items[0].productName.includes('SKU001'));
});

test('upstream truncation preserves complete available text, marks manual review and does not retry or suggest rotation', async () => {
  for(const content of [goods,'\n  '+goods+'\n ',JSON.stringify([box(90,goods)]),'']) {
    const r=runtime([{choices:[{finish_reason:'length',message:{content}}]},goods]);const result=await r.extract();
    assert.equal(r.calls.length,1);assert.equal(result.rawText,content);assert.equal(result.needRotate,0);assert.equal(result.needsManualReview,true);
    if(content)pending(result.fields,content);else assert.equal(result.fields.items.length,0);
  }
});

test('complete upright grounding without explicit goods rows is preserved for manual entry', async () => {
  const text=JSON.stringify([box(0,'Description'),box(0,'胶套外壳'),box(0,'鸭子'),box(0,'Qty'),box(0,'1,000')]);
  const r=runtime([text]);const result=await r.extract();
  assert.equal(result.rawText,text);assert.equal(result.needsManualReview,true);assert.equal(r.calls.length,1);
  pending(result.fields,'Description\n胶套外壳\n鸭子\nQty\n1,000');
});

test('only truly empty results retry; a successful table preserves metadata and stops at the bounded attempt', async () => {
  const r=runtime(['供应商：合成公司\n日期：2026-11-03\n没有货品行', '没有明细', goods]);
  const result=await r.extract();assert.equal(r.calls.length,3);assert.equal(result.fields.items[0].qty,'100');
  assert.equal(result.fields.date,'2026-11-03');assert.equal(result.needsManualReview,false);assert.equal(result.rawText,goods);
});

test('manual retry results cannot inherit an old header PO or other identity metadata from the previous response', async () => {
  const first='供应商：首次供应商有限公司\n日期：2026-11-03\n送货单号：DN1234\n订单号：PO-INITIAL\n没有货品行';
  const second='Description\n胶套外壳\nPO No: PO-A\n鸭子\nPO No: PO-B\nQty\n1,000\n2,000';
  const r=runtime([first,second]);assert.equal(r.parse(first).items.length,0);
  const expected=r.parse(second),result=await r.extract();
  assert.equal(r.calls.length,2);assert.equal(result.needsManualReview,true);assert.equal(result.rawText,second);
  assert.deepEqual(result.fields,expected);assert.equal(result.fields.orderNo,'');
  pending(result.fields,second);
});

test('rotation discovered on a retry returns that full response and no automatic goods', async () => {
  const text=JSON.stringify([box(-90,goods)]),r=runtime(['没有货品行',text]);const result=await r.extract();
  assert.equal(r.calls.length,2);assert.equal(result.needRotate,270);assert.equal(result.rawText,text);
  assert.equal(result.fields.items.length,0);assert.equal(result.needsManualReview,false);
});

test('delivery 編號 labels are independent from purchase order 編號', () => {
  const r=runtime();
  assert.equal(r.parse('送貨單編號：DN12').deliveryNo,'DN12');
  assert.equal(r.parse('發貨單編號：1ABC').deliveryNo,'1ABC');
  const fields=r.parse('訂單編號：PO1234');assert.equal(fields.deliveryNo,'');assert.equal(fields.orderNo,'PO1234');
});
