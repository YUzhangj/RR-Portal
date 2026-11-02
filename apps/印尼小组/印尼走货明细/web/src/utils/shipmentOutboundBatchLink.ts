import type { Material } from '../api/client'
import { linkShipmentOutbound, remainingOutboundQuantity, shipmentQuantityUnit, type LinkableShipmentRow, type ShipmentOutboundSource } from './shipmentOutboundLink'
import { shipmentKgWeight } from './shipmentWeight'
import { shipmentScope } from './shipmentOrder'

interface BatchRow extends LinkableShipmentRow {
  id?: number; kg?: number; cartons?: number; qty_per_carton?: string
}
export interface ShipmentOutboundAllocation { source: ShipmentOutboundSource; qty: number }

// Both database quantities and declaration weights retain four decimal places.
// Allocate integer ticks and assign remainders deterministically, so Save/reload
// cannot increase the original total through independent batch rounding.
function splitWeight(total: number, quantities: number[]): number[] {
  const ticks = Math.round(total * 10000)
  if (!Number.isSafeInteger(ticks) || ticks < 0 || Math.abs(ticks / 10000 - total) > 1e-8)
    throw new Error('本行重量超出可分配精度，请核对后关联')
  const sum = quantities.reduce((a, b) => a + b, 0)
  const shares = quantities.map(qty => ticks * qty / sum)
  const result = shares.map(Math.floor)
  const order = shares.map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  const remainder = ticks - result.reduce((a, b) => a + b, 0)
  for (let i = 0; i < remainder; i++) result[order[i % order.length].index]++
  return result.map(value => value / 10000)
}

/** One visible packing row, original allocations and purchase sources per batch. */
export function linkShipmentOutboundBatches<T extends BatchRow>(
  rows: readonly T[], rowKey: number, allocations: readonly ShipmentOutboundAllocation[],
  material: Material, materials: ReadonlyMap<number, Material>, groupId: string,
): T[] {
  const row = rows.find(item => item._rowKey === rowKey)
  if (!row) throw new Error('明细已变化，请重新打开关联出库')
  if (row.outbound_id) throw new Error('该行已有出库关联，请勿重复关联')
  if (!allocations.length) throw new Error('请勾选出库批次并填写分配数量')
  if (new Set(allocations.map(item => item.source.outbound_id)).size !== allocations.length)
    throw new Error('出库批次重复，请重新选择')
  if (allocations.some(({ source }) => source.material_id !== material.id))
    throw new Error('只能关联同一物料 ID 的多个出库批次')
  const currentMaterial = materials.get(row.material_id!) || row.material_snapshot || material
  const quantities = allocations.map(({ source, qty }) => {
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isSafeInteger(Math.round(qty * 10000)) || Math.abs(qty * 10000 - Math.round(qty * 10000)) > 1e-6)
      throw new Error(`OUT-${source.outbound_id} 的分配数量须大于 0，最多保留 4 位小数`)
    const remaining = remainingOutboundQuantity(rows, rowKey, source)
    if (!Number.isFinite(remaining) || qty > remaining + 1e-8)
      throw new Error(`OUT-${source.outbound_id} 的分配数量超过本行可分配量，请重新核对`)
    if (allocations.length > 1 && source.price == null)
      throw new Error(`OUT-${source.outbound_id} 缺少采购单价，请补齐后关联`)
    return qty
  })
  const total = Number(quantities.reduce((a, b) => a + b, 0).toFixed(4))
  if (!Number.isSafeInteger(Math.round(total * 10000))) throw new Error('分配合计超出有效范围，请核对数量')
  if (!Number.isFinite(row.qty ?? 0) || Number(row.qty || 0) < 0)
    throw new Error('本行送货数量无效，请核对后关联')
  if (Number(row.qty) > 0 && Math.abs(total - Number(row.qty)) > 1e-8)
    throw new Error(`分配数量合计 ${total} 必须等于当前送货数量 ${row.qty}`)
  const weight = Number(row.kg ?? 0)
  if (!Number.isFinite(weight) || weight < 0) throw new Error('本行重量无效，请核对后关联')
  const declarationUnit = shipmentQuantityUnit(currentMaterial.unit_kg || 'KGM')
  if (['PCE', 'SET', 'MTR'].includes(declarationUnit) && weight > 0 && Math.abs(weight - total) > 1e-8)
    throw new Error('本行按件数申报，申报数量与送货数量不一致，请先核对')
  const totalWeight = weight > 0 ? weight
    : shipmentKgWeight(currentMaterial.unit_kg, total, currentMaterial.net_per_pc, currentMaterial.name_zh)
  const weights = splitWeight(totalWeight, quantities)
  const linked = allocations.map(({ source }, index) => {
    const part = { ...row, qty: quantities[index], kg: weights[index] }
    return linkShipmentOutbound(rows.map(item => item._rowKey === rowKey ? part : item), rowKey,
      source, material, materials).find(item => item._rowKey === rowKey)!
  })
  // Company/supplier/currency are document boundaries. Never silently apply one
  // supplier's declaration or one currency's arithmetic to another source.
  if (new Set(linked.map(item => shipmentScope(item, materials))).size > 1
    || new Set(linked.map(item => item.currency || '¥')).size > 1)
    throw new Error('所选批次的供应商、报关公司或币种不同，请分别关联')
  const partitions = new Set([...rows.filter(item => item._rowKey !== rowKey), ...linked]
    .map(item => item.po_no?.trim().toUpperCase().match(/^IRR[IM]/)?.[0]).filter(Boolean))
  if (partitions.size > 1) throw new Error('关联后会混合 RRI 与 RRM 的 PO，请拆柜处理')
  if (linked.length > 1) {
    if (!groupId || groupId.length > 64) throw new Error('关联分组无效，请重新打开关联出库')
    const snapshot = linked[0].material_snapshot || currentMaterial
    linked.forEach((item, index) => {
      // The snapshot persists this explicitly confirmed grouping through reload.
      // All batches share the same physical cartons and packing schedule.
      item.material_snapshot = { ...snapshot, id: material.id, name_zh: material.name_zh,
        product_code: material.product_code || material.related_product_code, spec: material.spec,
        ...(!row.material_snapshot ? { shipment_hs_product_fallback: true } : {}),
        shipment_outbound_link_group: groupId }
      item.carton_group = row.carton_group || (Number(row.cartons) > 0 ? groupId : undefined)
      if (index) { item._rowKey = undefined; item.id = undefined }
    })
  }
  return rows.flatMap(item => item._rowKey === rowKey ? linked : [item])
}
