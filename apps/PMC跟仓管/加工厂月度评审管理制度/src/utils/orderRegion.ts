import { regionOf, type Region } from '../constants/roles'
import type { Order } from '../types/order'

// 订单管理厂区与加工厂所在地是两个维度；旧数据回退到加工厂厂区。
export function orderRegion(order: Pick<Order, 'region' | 'expand'>): Region {
  return order.region || regionOf(order.expand?.factory)
}
