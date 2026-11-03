const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const context={window:{},ExcelFormulas:require('../frontend/excel-formulas')};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../frontend/excel-grid.js'),'utf8'),context);
const groups=(f,s='92119')=>JSON.parse(JSON.stringify(context.window.ExcelGrid.referenceGroups(f,s)));
test('formula references include absolute and cross-sheet cells, with duplicate colors reused',()=>{
 assert.deepEqual(groups('=$J$51+J51+\'参数 表\'!$B$2'),[{label:'92119!J51',ids:['92119!J51']},{label:'参数 表!B2',ids:['参数 表!B2']}]);
});
test('ranges have one color group and include every referenced cell',()=>{
 assert.deepEqual(groups('SUM(A1:B2)+C3'),[{label:'92119!A1:B2',ids:['92119!A1','92119!B1','92119!A2','92119!B2']},{label:'92119!C3',ids:['92119!C3']}]);
});
test('constants and quoted text do not produce fake references; invalid formulas fail explicitly',()=>{
 assert.deepEqual(groups('1+2'),[]);assert.deepEqual(groups('"A1"'),[]);
 assert.throws(()=>groups('J51+'));assert.throws(()=>groups('INDIRECT("A1")'));
});
