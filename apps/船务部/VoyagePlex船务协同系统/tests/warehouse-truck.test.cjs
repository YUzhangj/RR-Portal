const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const ts=require('typescript');
const source=fs.readFileSync('lib/warehouse-truck.ts','utf8');
const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
const ref={exports:{}};
new Function('module','exports','require',javascript)(ref,ref.exports,()=>require('../services/email-parser/app/truck-rules.json'));
const {recommendTruck,applyWarehouseTruckSuggestion:apply}=ref.exports;
test('吨车连续区间及无效数据',()=>{
 for(const [volume,tonnes] of [[10,3],[10.5,5],[16,5],[16.1,8],[20,8],[20.1,10],[30,10],[30.1,12],[39,12],[39.1,18],[50,18]])assert.equal(recommendTruck([{volume}]),`1*${tonnes}T`);
 for(const volume of ['',null,0,-1,51,NaN,'bad'])assert.equal(recommendTruck([{volume}]),'');
});
test('推荐随体积更新，人工选择保留，厂区与任务隔离',()=>{
 const task={company:'Xingxin',containerType:'1*40HQ',exportDetails:{shipmentMode:'Warehouse'},warehouseGroups:[],items:[{volume:3}]};
 const automatic=apply(task);assert.equal(automatic.containerType,'1*3T');
 assert.equal(apply({...automatic,items:[{volume:40}]}).containerType,'1*18T');
 assert.equal(apply({...automatic,containerType:'1*5T',exportDetails:{shipmentMode:'Warehouse',truckTypeSource:'manual'},items:[{volume:40}]}).containerType,'1*5T');
 assert.equal(apply({...task,company:'Huadeng'}).containerType,'1*40HQ');
 assert.equal(apply({...task,exportDetails:{shipmentMode:'Container'}}).containerType,'1*40HQ');
});
