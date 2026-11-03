const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { biffBorders, readWorkbookBorders } = require('../backend/services/excelBorders');
const context = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../frontend/excel-grid.js'),'utf8'), context);
const { borderStyle } = context.window.ExcelGrid;
const line = {style:'thin',color:'#000000'};
test('source-less grid cells do not acquire black borders', () => {
  assert.equal(borderStyle({},3,4), '');
  assert.equal(borderStyle({borders:{A1:{right:line}}},3,4), '');
  assert.equal(borderStyle({borders:{B2:{left:line}}},1,0), 'border-right:1px solid #000000');
  assert.equal(borderStyle({borders:{B2:{top:line}}},0,1), 'border-bottom:1px solid #000000');
});
test('merged source cells retain only the outer edges, including blank end cells', () => {
  const layout = {borders:{A1:{left:line,top:line},B1:{top:line},A2:{left:line,bottom:line},B2:{bottom:line,right:line}}};
  const css = borderStyle(layout,0,0,{s:{r:0,c:0},e:{r:1,c:1}});
  for (const side of ['left','right','top','bottom']) assert.ok(css.includes(`border-${side}:1px solid #000000`));
  assert.equal(borderStyle(layout,3,3),'');
});
test('BIFF extraction reads actual XF edges on values and blank cells without guessing filled regions', () => {
  const record = (id,b) => {const h=Buffer.alloc(4);h.writeUInt16LE(id,0);h.writeUInt16LE(b.length,2);return Buffer.concat([h,b]);};
  const bof=Buffer.from([0,6,16,0]), xf0=Buffer.alloc(20), xf1=Buffer.alloc(20);xf1.writeUInt32LE(0x1111,10);
  const bound=Buffer.from([0,0,0,0,0,0,1,0,83]);
  const global=()=>Buffer.concat([record(0x809,bof),record(0xe0,xf0),record(0xe0,xf1),record(0x85,bound),record(0xa,Buffer.alloc(0))]);
  bound.writeUInt32LE(global().length,0);
  const cell=Buffer.from([0,0,0,0,1,0]), blank=Buffer.from([1,0,0,0,1,0]), noFrame=Buffer.from([2,0,0,0,0,0]);
  const bytes=Buffer.concat([global(),record(0x809,bof),record(0xfd,cell),record(0x201,blank),record(0x201,noFrame),record(0xa,Buffer.alloc(0))]);
  const borders=biffBorders(bytes).S;
  assert.deepEqual(Object.keys(borders),['A1','A2']);
  assert.deepEqual(borders.A1,{left:line,right:line,top:line,bottom:line});
});
test('actual imported workbook distinguishes framed detail cells from unframed parameters and whitespace', {skip:!process.env.ZURU_FORMULA_TEST_FILE}, () => {
  const borders=readWorkbookBorders(process.env.ZURU_FORMULA_TEST_FILE)['92125'];
  assert.equal(borders.A1,undefined);assert.equal(borders.A5,undefined);
  assert.deepEqual(borders.A38,{left:line,right:line,top:line,bottom:line});
  assert.deepEqual(borders.C38,{left:line,right:line,top:line,bottom:line});
});
