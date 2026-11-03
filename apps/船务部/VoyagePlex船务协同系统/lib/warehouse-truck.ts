import rules from "@/services/email-parser/app/truck-rules.json";

type Cargo = Record<string,unknown>;
type TruckTask = {company?:string;containerType:string;exportDetails?:Record<string,string>;items:Cargo[];warehouseGroups:Array<{warehouse?:string}>};
export function isXingxinWarehouse(task:TruckTask):boolean {
  return task.company==="Xingxin"&&(task.exportDetails?.shipmentMode ? task.exportDetails.shipmentMode==="Warehouse" : task.warehouseGroups.length>0);
}
export function normalizeTruckType(value:string):string {
  const match=value.trim().match(/^(?:(\d+)\s*[*x×]\s*)?(\d+(?:\.\d+)?)\s*(?:T|吨(?:车)?)$/i);
  if(!match||Number(match[1]||1)<=0||Number(match[2])<=0)return "";
  return `${Number(match[1]||1)}*${Number(match[2])}T`;
}
export function warehouseCbm(items:Cargo[]):number|null {
  if(!items.length)return null;
  const groups=new Map<string,number|null>();
  for(let index=0;index<items.length;index++){
    const item=items[index];
    const group=String(item.packing_group||"");
    const key=group?JSON.stringify([item.source_file||"",group]):`row:${index}`;
    if(!groups.has(key))groups.set(key,null);
    const raw=item.volume==null||item.volume===""?item.cbm:item.volume;
    if(raw==null||raw===""){if(!group)return null;continue;}
    if(typeof raw!=="number"&&typeof raw!=="string")return null;
    if(typeof raw==="string"&&!raw.trim())return null;
    const value=Number(raw);
    if(!Number.isFinite(value)||value<0)return null;
    const previous=groups.get(key);
    if(previous!=null&&previous!==value)return null;
    groups.set(key,value);
  }
  let total=0;
  for(const value of Array.from(groups.values())){if(value==null)return null;total+=value;}
  return Number.isFinite(total)&&total>0?total:null;
}
export function recommendTruck(items:Cargo[]):string {
  const volume=warehouseCbm(items);
  if(volume==null)return "";
  // Ignore only binary floating-point summation noise at a band boundary.
  const band=rules.volumeBands.find(b=>volume<=b.maximumCbm+Number.EPSILON*Math.max(volume,b.maximumCbm)*items.length);
  return band?`1*${band.tonnes}T`:"";
}
export function applyWarehouseTruckSuggestion<T extends TruckTask>(task:T):T {
  if(!isXingxinWarehouse(task))return task;
  const details=task.exportDetails||{};
  if(details.truckTypeSource==="manual")return task;
  if(details.truckTypeSource!=="recommended"){
    const provided=normalizeTruckType(task.containerType)||normalizeTruckType(details.vehicleType||"");
    if(provided)return {...task,containerType:provided};
  }
  return {...task,containerType:recommendTruck(task.items),exportDetails:{...details,truckTypeSource:"recommended"}};
}
