const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {buildWorkbook}=require('../backend/services/exportInternal');
const {buildQuoteSummary}=require('../backend/services/quoteSummary');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const sections=p=>Object.entries(p).map(([dept,data])=>({dept,payload_json:JSON.stringify(data)}));
const carton={cartons:[{cl:10,cw:10,ch:10,qty:10}],paper_rate:2.75};
const quote={id:1,quote_no:'CARTON-RULE',product_name:'纸箱测试',qty:100,customer:'TOMY',factory_code:'qingxi'};

test('详情页纸箱按原成本除以1.1乘11.5%，保留原成本金额',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../frontend/workbench.js'),'utf8'),nodes=new Map();
 const host={innerHTML:'',querySelector:key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);}};
 const context=vm.createContext({window:{},num:v=>Number(v)||0,formatNum:String});
 vm.runInContext(source.slice(source.indexOf('function renderTaxDeductionBlock('),source.indexOf('\nfunction hasSlushCostingInputs(')),context);
 const sales={};context.renderTaxDeductionBlock(host,sales,null,{}, {base_price:40,carton:11});
 assert.equal(sales.pricing_summary.t4.carton.amt,11);
 near(Number(nodes.get('#tk-ded-carton').textContent),1.15);near(Number(nodes.get('#tk-total-ded').textContent),1.15);
});

for (const mixed of [false,true]) test(`${mixed?'混装':'单品'}完整Excel的纸箱减税公式和缓存与汇总一致`,async()=>{
 const sales={header:{fx_rmb_hkd:1,fx_hkd_usd:7.8},shipping:{markup_x:1.2,divisor:.98,scenarios:[{name:'出厂价',is_factory:true}]}};
 const payload={sales,engineering:{carton_calc:carton}};
 if(mixed){
  sales.mixed_quote={enabled:true,na_direct:true,mode:'ratio',units_per_pack:1,products:[{id:'a',code:'A',name:'A',ratio:.5,na_ratio:.5},{id:'b',code:'B',name:'B',ratio:.5,na_ratio:.5}]};
  payload.engineering={mixed_shared:{carton_calc:carton}};payload.molding={mixed_molds:[]};
  const sewing={tax_label:'不含税',sewing_groups:[{items:[{fabric:'布料',usage:1,mat_price:1}]}]};
  payload.sewing={mixed_products:{a:sewing,b:sewing}};
 }
 const s=sections(payload),summary=buildQuoteSummary(quote,s),expected=summary.components_before_tax.carton/1.1*.115;
 const wb=await buildWorkbook({quote,sections:s}),saved=new(require('exceljs').Workbook)();await saved.xlsx.load(await wb.xlsx.writeBuffer());
 const ws=saved.getWorksheet(mixed?'总报价表':'报价明细');let heading;ws.eachRow(row=>{if(row.getCell(1).value==='四、减税明细')heading=row.number;});assert.ok(heading);
 const deduction=ws.getCell(heading+4,2),amount=ws.getCell(heading+2,2);
 near(amount.result,summary.components_before_tax.carton);near(deduction.result,expected);
 assert.match(deduction.formula,/\/1\.1\*/);
 near(summary.components_before_tax.carton-summary.components.carton,expected);
});

test('旧核价表已知纸箱旧减税时，合计退税和成本也随统一规则更新',async()=>{
 const {buildVerificationRow,buildVerificationWorkbook}=require('../backend/services/verificationSummary');
 const cells={},groups=[];
 const add=(title,row,labels,values)=>{const h=labels.map((_,i)=>'s!'+String.fromCharCode(65+i)+row),v=h.map(id=>id.replace(String(row),String(row+1)));h.forEach((id,i)=>cells[id]={v:labels[i]});v.forEach((id,i)=>cells[id]={v:values[i]});groups.push({title,rows:[h,v]});};
 add('货价与材料',1,['货价'],[30]);add('包装与外购',4,['纸箱'],[11]);
 add('人工与成本',7,['总成本','不含人工成本'],[11,11]);add('减税与税后结果',10,['纸箱类'],[.1]);
 groups[3].rows.push(['s!A13']);cells['s!A13']={v:1.1};cells['s!K1']={v:1.1};cells['s!K2']={v:9.9};
 const model={cells,groups,metrics:{price:'s!A2',total:'s!A8',no_labor:'s!B8',deduction:'s!K1',after_cost:'s!K2'}};
 const row=buildVerificationRow(quote,{id:1,label:'V1',status:'drafting'},sections({sales:{legacy_import:{excel_model:model}}}),[{customer:'TOMY',sku:'CARTON-RULE',qty:100,source:'test'}]);
 near(row.values.AO,9.85);near(row.values.CY,1.15);near(row.values.CZ,9.85);
 const saved=new(require('exceljs').Workbook)();await saved.xlsx.load(await buildVerificationWorkbook([row]).xlsx.writeBuffer());
 const ws=saved.getWorksheet('TOMY');near(ws.getCell('CY5').result,1.15);near(ws.getCell('CZ5').result,9.85);assert.match(ws.getCell('CY5').formula,/AN5\/1\.1\*11.5%/);
});
