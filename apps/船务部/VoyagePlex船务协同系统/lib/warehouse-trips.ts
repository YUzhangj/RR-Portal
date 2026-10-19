import { warehouseCbm, normalizeTruckType } from "@/lib/warehouse-truck";

export const YUTAI_MAX_CBM=35; // Confirmed maximum volume per truck for 裕泰仓.
export type TripCargo=Record<string,unknown>;
export type TripAllocation={item_index:number;quantity:string;pieces:string;volume:string;pallet_count?:string};
export type WarehouseTrip={key:string;warehouse:string;vehicle_type:string;allocations:TripAllocation[]};
export type WarehouseTripPlan={confirmed:boolean;trips:WarehouseTrip[]};
export type WarehouseTripSource={items?:TripCargo[];warehouse_groups?:Array<{warehouse:string;items:TripCargo[]}>};
export function allocatedCargo(items:TripCargo[],trip:WarehouseTrip):TripCargo[]{
  return trip.allocations.map(row=>({...items[row.item_index],quantity:row.quantity,pieces:row.pieces,volume:row.volume,cbm:row.volume,pallet_count:row.pallet_count??""}));
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
      allocations.push({item_index:index,quantity:String(item.quantity??""),pieces:String(item.pieces??""),volume:String(item.volume??item.cbm??""),pallet_count:String(item.pallet_count??"")});
    }
    if(allocations.length)trips.push({key:`trip-${trips.length+1}`,warehouse:group.warehouse,vehicle_type:"",allocations});
  }
  const rest=items.flatMap((item,index)=>used.has(index)?[]:[{item_index:index,quantity:String(item.quantity??""),pieces:String(item.pieces??""),volume:String(item.volume??item.cbm??""),pallet_count:String(item.pallet_count??"")}]);
  if(rest.length)trips.push({key:`trip-${trips.length+1}`,warehouse:"",vehicle_type:"",allocations:rest});
  return trips;
}
export function tripErrors(items:TripCargo[],trips:WarehouseTrip[]):string[]{
  const errors:string[]=[];
  const totals=items.map(()=>({quantity:0,pieces:0,volume:0,pallet_count:0,count:0}));
  const packingTrips=new Map<string,Set<number>>();
  trips.forEach((trip,index)=>{
    if(!trip.warehouse.trim()||trip.warehouse.includes("待确认"))errors.push(`第${index+1}车请填写交仓仓库`);
    if(trip.vehicle_type.trim()&&!normalizeTruckType(trip.vehicle_type))errors.push(`第${index+1}车请填写正确吨车规格，例如1*3T`);
    if(!trip.allocations.length)errors.push(`第${index+1}车没有货物`);
    for(const row of trip.allocations){
      const item=items[row.item_index];if(!item){errors.push("货物来源已变化，请重新建立分车草稿");continue;}
      totals[row.item_index].count++;
      for(const key of ["quantity","pieces","volume"] as const){
        const value=Number(row[key]);
        if(!row[key].trim()||!Number.isFinite(value)||value<0||(key!=="volume"&&!Number.isInteger(value)))errors.push(`第${index+1}车数量、件数需为非负整数，体积需为有效非负数`);
        totals[row.item_index][key]+=value;
      }
      if((item.pallet_count!=null&&String(item.pallet_count).trim()!=="")||row.pallet_count?.trim()){
        const pallets=Number(row.pallet_count);if(row.pallet_count==null||!row.pallet_count.trim()||!Number.isInteger(pallets)||pallets<0)errors.push(`第${index+1}车请填写有效整数卡板数`);
        totals[row.item_index].pallet_count+=pallets;
      }
      if(item.packing_group){const key=JSON.stringify([item.source_file||"",item.packing_group]);const assigned=packingTrips.get(key)||new Set<number>();assigned.add(index);packingTrips.set(key,assigned);if(totals[row.item_index].count>1)errors.push("已确认混装货物暂不支持拆行，请整组分配到同一车");}
    }
    const volume=warehouseCbm(allocatedCargo(items,trip));
    if(volume==null)errors.push(`第${index+1}车体积缺失或无效`);
    else if(volume>50&&!trip.vehicle_type.trim())errors.push(`第${index+1}车超出推荐范围，请人工填写吨车`);
    if(volume!=null&&trip.warehouse.includes("裕泰")&&volume>YUTAI_MAX_CBM+1e-9)errors.push(`第${index+1}车超过裕泰仓 ${YUTAI_MAX_CBM} CBM 上限`);
  });
  items.forEach((item,index)=>{
    if(!totals[index].count){errors.push(`第${index+1}条货物尚未分车`);return;}
    if(item.pallet_count!=null&&String(item.pallet_count).trim()!==""&&totals[index].pallet_count!==Number(item.pallet_count))errors.push(`第${index+1}条货物分车后的卡板合计须与原资料一致`);
    for(const key of ["quantity","pieces","volume"] as const){
      const raw=key==="volume"?(item.volume??item.cbm):item[key];const value=Number(raw);
      if(raw==null||String(raw).trim()===""||!Number.isFinite(value)||Math.abs(totals[index][key]-value)>1e-9)errors.push(`第${index+1}条货物分车后的数量、件数、体积合计须与原资料一致`);
    }
  });
  if(Array.from(packingTrips.values()).some(set=>set.size>1))errors.push("同一已确认混装组需分配到同一车");
  if(!trips.length)errors.push("请先建立分车草稿");
  return Array.from(new Set(errors));
}
