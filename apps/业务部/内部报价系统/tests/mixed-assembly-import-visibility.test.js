const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('department export preserves mixed assembly upload on initial render and observer updates',()=>{
 const source=fs.readFileSync(require.resolve('../frontend/workbench.js'),'utf8');
 const start=source.indexOf('function installDepartmentExport(');
 const end=source.indexOf('// 按产品分组的人工表',start);
 let callback;
 const control=(mixed,textContent='')=>({textContent,removed:false,closest:()=>mixed?{}:null,remove(){this.removed=true;}});
 const upload=control(true),apply=control(true,'导入装工'),oldUpload=control(false);
 const host={querySelectorAll:selector=>selector==='button'?[apply]:[upload,oldUpload],querySelector:()=>({})};
 const ctx={DEPARTMENT_EXPORT_NAMES:{assembly:'装配部'},MutationObserver:class{constructor(fn){callback=fn;}observe(){}}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 ctx.installDepartmentExport(host,'assembly',12);
 callback();
 assert.equal(upload.removed,false);assert.equal(apply.removed,false);assert.equal(oldUpload.removed,true);
});
