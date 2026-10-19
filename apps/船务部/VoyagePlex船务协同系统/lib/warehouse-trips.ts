import { warehouseCbm, normalizeTruckType } from "@/lib/warehouse-truck";

export const YUTAI_MAX_CBM=35; // Confirmed maximum volume per truck for 裕泰仓.
export type TripCargo=Record<string,unknown>;
export type TripAllocation={item_index:number;quantity:string;pieces:string;volume:string;pallet_count?:string};
export type WarehouseTrip={key:string;warehouse:string;vehicle_type:string;allocations:TripAllocation[]};
export type WarehouseTripPlan={confirmed:boolean;trips:WarehouseTrip[]};
export type WarehouseTripSource={items?:TripCargo[];warehouse_groups?:Array<{warehouse:string;items:TripCargo[]}>;fields?:{cargo_split_required?:unknown}};
const sharedFields=["pieces","volume","pallet_count"] as const;
const hasValue=(value:unknown)=>value!=null&&String(value).trim()!=="";
const originalValue=(item:TripCargo,key:string)=>key==="volume"&&!hasValue(item.volume)?item.cbm:item[key];
const packingKey=(item:TripCargo)=>String(item.packing_group??"")?JSON.stringify([String(item.source_file??""),String(item.packing_group)]):null;
function validNumber(value:unknown,integer=false):value is string|number {
  return (typeof value==="string"||typeof value==="number")&&hasValue(value)&&Number.isFinite(Number(value))&&Number(value)>=0&&(!integer||Number.isInteger(Number(value)));
}
export function allocatedCargo(items:TripCargo[],trip:WarehouseTrip):TripCargo[]{
  return trip.allocations.map((row,order)=>({row,order})).sort((a,b)=>a.row.item_index-b.row.item_index||a.order-b.order)
    .map(({row})=>({...items[row.item_index],quantity:row.quantity,pieces:row.pieces,volume:row.volume,cbm:row.volume,pallet_count:row.pallet_count??""}));
}
export function initialTrips(source:WarehouseTripSource):WarehouseTrip[]{
  const items=source.items||[];
  const used=new Set<number>();
  const trips:WarehouseTrip[]=[];
  for(const group of source.warehouse_groups||[]){
    const allocations:TripAllocation[]=[];
    for(const cargo of group.items){
      const index=items.findIndex((item,i)=>!used.has(i)&&["source_file","source_row","product_code"].every(key=>String(item[key]??"")===String(cargo[key]??"")));
      if(index<0)continue;
      used.add(index);const item=items[index];
      allocations.push({item_index:index,quantity:String(item.quantity??""),pieces:String(item.pieces??""),volume:String(originalValue(item,"volume")??""),pallet_count:String(item.pallet_count??"")});
    }
    if(allocations.length)trips.push({key:`trip-${trips.length+1}`,warehouse:group.warehouse,vehicle_type:"",allocations});
  }
  const rest=items.flatMap((item,index)=>used.has(index)?[]:[{item_index:index,quantity:String(item.quantity??""),pieces:String(item.pieces??""),volume:String(originalValue(item,"volume")??""),pallet_count:String(item.pallet_count??"")}]);
  if(rest.length)trips.push({key:`trip-${trips.length+1}`,warehouse:"",vehicle_type:"",allocations:rest});
  return trips;
}
export function tripErrors(items:TripCargo[],trips:WarehouseTrip[],cargoSplitRequired=false):string[]{
  const errors:string[]=[];
  const totals=items.map(()=>({quantity:0,pieces:0,volume:0,pallet_count:0,count:0}));
  const packingTrips=new Map<string,Set<number>>();
  const packingTotals=new Map<string,Partial<Record<typeof sharedFields[number],number>>>();
  const packingGrossWeights=new Map<string,number>();
  const packingScopes=new Map<string,string>();
  for(const item of items){
    const key=packingKey(item);if(key==null)continue;
    if(hasValue(item.gross_weight)){
      if(!validNumber(item.gross_weight))errors.push("混装组原资料的共享毛重无效");
      else{
        const gross=Number(item.gross_weight);
        if(packingGrossWeights.has(key)&&packingGrossWeights.get(key)!==gross)errors.push("混装组原资料的共享毛重不一致，请先核对");
        packingGrossWeights.set(key,gross);
      }
    }
    if(cargoSplitRequired){
      const scope=String(item.shipment_scope??"");
      if(!["current","waiting"].includes(scope)||(packingScopes.has(key)&&packingScopes.get(key)!==scope))errors.push("同一混装组不能拆分为本次出运和等待通知，请先人工核对");
      packingScopes.set(key,scope);
    }
    const shared=packingTotals.get(key)||{};
    for(const field of sharedFields){
      const raw=originalValue(item,field);if(!hasValue(raw))continue;
      if(!validNumber(raw,field!=="volume")){errors.push("混装组原资料的共享件数、体积或卡板数无效");continue;}
      const value=Number(raw);
      if(shared[field]!=null&&shared[field]!==value)errors.push("混装组原资料的共享件数、体积或卡板数不一致，请先核对");
      shared[field]=value;
    }
    packingTotals.set(key,shared);
  }
  if(Array.from(packingTotals.values()).some(shared=>shared.pieces==null||shared.volume==null))errors.push("混装组原资料缺少共享件数或体积，请先补齐再分车");
  const keys=new Set<string>();
  trips.forEach((trip,index)=>{
    if(!trip.key||keys.has(trip.key))errors.push("分车编号缺失或重复");keys.add(trip.key);
    if(!trip.warehouse.trim()||trip.warehouse.includes("待确认"))errors.push(`第${index+1}车请填写交仓仓库`);
    if(trip.vehicle_type.trim()&&!normalizeTruckType(trip.vehicle_type))errors.push(`第${index+1}车请填写正确吨车规格，例如1*3T`);
    if(!trip.allocations.length)errors.push(`第${index+1}车没有货物`);
    for(const row of trip.allocations){
      const item=items[row.item_index];if(!item){errors.push("货物来源已变化，请重新建立分车草稿");continue;}
      totals[row.item_index].count++;
      const packing=packingKey(item);
      for(const key of ["quantity","pieces","volume"] as const){
        if(packing!=null&&key!=="quantity")continue;
        const value=Number(row[key]);
        if(!validNumber(row[key],key!=="volume"))errors.push(`第${index+1}车数量、件数需为非负整数，体积需为有效非负数`);
        totals[row.item_index][key]+=value;
      }
      if(packing!=null){
        const shared=packingTotals.get(packing)!;
        for(const field of sharedFields){
          const raw=row[field];
          if(!hasValue(raw)){
            if(hasValue(originalValue(item,field)))errors.push("混装原资料已填写的共享件数、体积或卡板数不能在分配时清空");
          }else if(!validNumber(raw,field!=="volume")||shared[field]!==Number(raw))errors.push("混装分配的共享件数、体积或卡板数须与原组资料一致");
        }
        const assigned=packingTrips.get(packing)||new Set<number>();assigned.add(index);packingTrips.set(packing,assigned);
        if(totals[row.item_index].count>1)errors.push("已确认混装货物暂不支持拆行，请整组分配到同一车");
      }else if((item.pallet_count!=null&&String(item.pallet_count).trim()!=="")||row.pallet_count?.trim()){
        const pallets=Number(row.pallet_count);if(row.pallet_count==null||!row.pallet_count.trim()||!Number.isInteger(pallets)||pallets<0)errors.push(`第${index+1}车请填写有效整数卡板数`);
        totals[row.item_index].pallet_count+=pallets;
      }
    }
    const volume=warehouseCbm(allocatedCargo(items,trip));
    if(volume==null)errors.push(`第${index+1}车体积缺失或无效`);
    else if(volume>50&&!trip.vehicle_type.trim())errors.push(`第${index+1}车超出推荐范围，请人工填写吨车`);
    if(volume!=null&&trip.warehouse.includes("裕泰")&&volume>YUTAI_MAX_CBM+1e-9)errors.push(`第${index+1}车超过裕泰仓 ${YUTAI_MAX_CBM} CBM 上限`);
  });
  items.forEach((item,index)=>{
    if(!totals[index].count){errors.push(`第${index+1}条货物尚未分车`);return;}
    const packing=packingKey(item);
    if(packing==null&&item.pallet_count!=null&&String(item.pallet_count).trim()!==""&&totals[index].pallet_count!==Number(item.pallet_count))errors.push(`第${index+1}条货物分车后的卡板合计须与原资料一致`);
    for(const key of ["quantity","pieces","volume"] as const){
      if(packing!=null&&key!=="quantity")continue;
      const raw=originalValue(item,key);const value=Number(raw);
      if(raw==null||String(raw).trim()===""||!Number.isFinite(value)||Math.abs(totals[index][key]-value)>1e-9)errors.push(`第${index+1}条货物分车后的数量、件数、体积合计须与原资料一致`);
    }
  });
  if(Array.from(packingTrips.values()).some(set=>set.size>1))errors.push("同一已确认混装组需分配到同一车");
  if(!trips.length)errors.push("请先建立分车草稿");
  return Array.from(new Set(errors));
}
