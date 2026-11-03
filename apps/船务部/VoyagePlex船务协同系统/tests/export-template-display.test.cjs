const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const ts=require('typescript');
const ref={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync('lib/export-template-display.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(ref,ref.exports);
test('导出选择明确区分保留精度的整数显示和INT取整',()=>{
 const {templateWeightLabel,templateLayoutLabel}=ref.exports;
 assert.match(templateWeightLabel('DisplayInteger','Huadeng'),/底层保留小数/);
 assert.match(templateWeightLabel('Truncate','Huadeng'),/INT/);
 assert.match(templateWeightLabel('Exact'),/两位小数/);
 assert.equal(templateLayoutLabel('CustomerItem'),'客户 ITEM 特殊表');
 assert.equal(templateLayoutLabel('CartonMarks'),'箱唛尺寸特殊表');
});
