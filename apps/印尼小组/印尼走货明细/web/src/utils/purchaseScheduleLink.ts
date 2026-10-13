import { purchaseSelectionSource } from './purchaseMaterialSelection'

export interface LinkableSchedule {
  code?: string; orderNo?: string; eta?: string; source?: string
  qty?: number; customer?: string; productName?: string
}
interface LinkableLine { product_code?: string; tomy_po?: string; eta?: string }
const norm = (value?: string) => (value || '').trim().toUpperCase()
const codes = (value?: string) => (value || '').split(/\s*\/\s*/).map(norm).filter(Boolean)

export function matchingLineSchedules(line: LinkableLine, schedules: LinkableSchedule[]) {
  const lineCodes = codes(line.product_code)
  // A merged row cannot safely replace several products' associations with one order.
  return lineCodes.length === 1 ? schedules.filter(row => !!row.orderNo?.trim() && norm(row.code) === lineCodes[0]) : []
}

export function linkPurchaseLine<T extends LinkableLine>(line: T, schedule: LinkableSchedule,
  schedules: LinkableSchedule[], allLines: LinkableLine[], poNo: string): T {
  if (!matchingLineSchedules(line, schedules).includes(schedule))
    throw new Error('请选择与该行货号完全一致的排期订单；多货号合并行请先拆分。')
  const existingSources = allLines.flatMap(item => (item.tomy_po || '').split(/[;；]/).filter(v => v.trim()).flatMap(order => {
    const matches = schedules.filter(row => row.orderNo?.trim() === order.trim() && codes(item.product_code).includes(norm(row.code)))
    return matches.length ? matches.map(row => row.source?.trim() || 'RRI') : [undefined]
  }))
  purchaseSelectionSource([{ key: 'link', groupKey: 'link', productCode: line.product_code || '', label: '', material: {}, quantity: 0 }],
    { link: schedule.source }, poNo, existingSources)
  // Only association and shipment date change. Quantities, prices, units and material identity remain untouched.
  return { ...line, tomy_po: schedule.orderNo!.trim(), eta: schedule.eta?.trim() || line.eta || '' }
}
