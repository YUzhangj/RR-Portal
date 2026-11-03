export function templateLayoutLabel(layout:string){
  return ({Standard:"普通表",SkyCastle:"多柜特殊表",CustomerItem:"客户 ITEM 特殊表",CartonMarks:"箱唛尺寸特殊表"} as Record<string,string>)[layout]||layout;
}
export function templateWeightLabel(rule:string,company?:string){
  return ({DisplayInteger:"直接相乘 · 显示整数（底层保留小数）",Truncate:"INT 向下取整",Exact:"直接相乘 · 显示两位小数",Template:company==="Huadeng"?"按样表公式及显示格式":"按已确认模板规则"} as Record<string,string>)[rule]||rule;
}
