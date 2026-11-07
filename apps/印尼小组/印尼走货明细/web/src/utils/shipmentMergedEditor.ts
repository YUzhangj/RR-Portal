import { applyShipmentSheetEdits, parseShipmentSheetValue, type SheetEdit } from './shipmentSheet'
import { parseShipmentPacking } from './shipmentWeight'
import { cartonGroupKey, shipmentScope } from './shipmentOrder'
import { shipmentStoredDeclarationPrice } from './shipmentDeclaration'

interface EditorItem {
  _rowKey?: number; material_id?: number; outbound_id?: number
  qty?: number; kg?: number; cartons?: number; purchase_unit?: string; price?: number; material_snapshot?: unknown
  carton_group?: string; supplier?: string; customs_company?: string
  qty_per_carton?: string
}
export type MergedEditorRow<T extends EditorItem> = T & { sources: T[]; outbound_ids: number[]; packing_source?: T }
export interface OutboundBalance { outbound_id: number; allocatable_qty?: number }
export const mergedReadOnlyFields = new Set(['po_no', 'po_date', 'qty', 'kg'])
const directTextFields = new Set(['formula_name', 'product_use', 'contract_no', 'invoice_no', 'supplier', 'po_no', 'pallet', 'carton_no'])
const packingOwnerFields = new Set(['pallet', 'carton_no', 'cartons', 'qty_per_carton', 'weighing_qty',
  'material:length', 'material:width', 'material:height', 'material:weight_per_carton'])
const packingMaterialFields = new Set(['material:length', 'material:width', 'material:height', 'material:weight_per_carton'])
const supplementSourceFields = new Set(['material:unit_kg', 'material:net_per_pc'])
export const supplementSourceReadOnlyHint = '此行含装箱明细和补量，申报单位及单个净重按各来源保留，不能在汇总行统一修改'
export const sharedPackingReadOnlyHint = '装箱明细与补量共用物料资料，不能在汇总行统一修改包装尺寸和每箱重量'
function sharesPackingMaterial<T extends EditorItem>(row: MergedEditorRow<T>): boolean {
  const owner = row.packing_source
  return !!owner && row.sources.some(source => source !== owner && source.material_id === owner.material_id)
}
export function mergedSnapshotEditable<T extends EditorItem>(row: MergedEditorRow<T> | undefined): boolean {
  return !!row?.sources.length && row.sources.every(source => !!source.material_snapshot
    && typeof source.material_snapshot === 'object' && source.material_id != null && source.material_id < 0)
}
export function mergedFieldEditable<T extends EditorItem>(row: MergedEditorRow<T> | undefined, field: string): boolean {
  return !!row && !(row.sources.length > 1 && mergedReadOnlyFields.has(field))
    && !(row.packing_source && supplementSourceFields.has(field))
    && !(packingMaterialFields.has(field) && sharesPackingMaterial(row))
    && (!field.startsWith('snapshot:') || mergedSnapshotEditable(row))
}

// Distribute an entered integer carton total without losing rounding remainders.
export function allocateShipmentCartons(total: number, weights: number[]): number[] {
  const ticks = total
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error('合计超出可分配范围')
  if (!weights.length) throw new Error('合并行已变化，请刷新后重试')
  const positive = weights.map(value => Math.max(0, Number(value) || 0))
  const sum = positive.reduce((a, b) => a + b, 0)
  const shares = positive.map(value => ticks * (sum ? value / sum : 1 / positive.length))
  const result = shares.map(value => Math.floor(value))
  const order = shares.map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  const remainder = ticks - result.reduce((a, b) => a + b, 0)
  for (let i = 0; i < remainder; i++) result[order[i % order.length].index]++
  return result
}

/** Expand visible merged-row edits to original rows, never to persisted totals. */
export function applyMergedShipmentEdits<T extends EditorItem>(
  items: T[], materials: Map<number, any>, rows: MergedEditorRow<T>[], edits: SheetEdit[],
  balances: readonly OutboundBalance[] = [],
  options: { preserveTextWhitespace?: boolean } = {},
) {
  const sourceIndex = new Map(items.map((item, index) => [item._rowKey, index]))
  const expanded = new Map<string, SheetEdit>()
  const put = (row: number, field: string, value: unknown) => expanded.set(`${row}:${field}`, { row, field, value: String(value ?? '') })
  const parsed = edits.map(edit => {
    const group = rows[edit.row]
    if (!group) throw new Error('明细已变化，请重新选择单元格')
    const indices = group.sources.map(source => {
      const index = sourceIndex.get(source._rowKey)
      if (source._rowKey == null || index == null) throw new Error('明细已变化，请重新选择单元格')
      return index
    })
    if (new Set(indices).size !== indices.length) throw new Error('出库来源重复，请刷新后重试')
    const ownerIndex = group.packing_source ? sourceIndex.get(group.packing_source._rowKey) : undefined
    if (group.packing_source && (group.packing_source._rowKey == null || ownerIndex == null || !indices.includes(ownerIndex)))
      throw new Error('装箱来源已变化，请刷新后重试')
    if (group.packing_source && supplementSourceFields.has(edit.field)) throw new Error(supplementSourceReadOnlyHint)
    if (packingMaterialFields.has(edit.field) && sharesPackingMaterial(group)) throw new Error(sharedPackingReadOnlyHint)
    if (edit.field.startsWith('snapshot:') && !mergedSnapshotEditable(group))
      throw new Error('此行包含货号库物料，海关编码按原来源保留，不能在汇总行统一修改')
    if (indices.length > 1 && mergedReadOnlyFields.has(edit.field))
      throw new Error(['qty', 'kg'].includes(edit.field)
        ? `第 ${edit.row + 1} 行的数量和重量只显示汇总，不能直接修改`
        : `第 ${edit.row + 1} 行包含多批采购来源，采购单号和日期按原记录保留`)
    const value = parseShipmentSheetValue(edit.field, edit.value)
    if (indices.length > 1 && ownerIndex == null && edit.field === 'qty_per_carton' && !['empty', 'uniform'].includes(parseShipmentPacking(String(value)).mode))
      throw new Error('合并行的每箱数量请填写统一数量，例如 3000')
    const targets = ownerIndex != null && packingOwnerFields.has(edit.field) ? [ownerIndex] : indices
    return { ...edit, value, rawValue: edit.value, group, indices, targets }
  })
  // First propagate common cells; material edits still use the shared conflict
  // checks and recalculation in the existing spreadsheet editor.
  for (const edit of parsed) {
    if (edit.targets.length === 1 || edit.field !== 'cartons')
      edit.targets.forEach(index => put(index, edit.field, edit.value))
    if (edit.indices.length > 1 && edit.field === 'qty_per_carton'
      && !parsed.some(other => other.group.material_id === edit.group.material_id && ['material:net_per_pc', 'material:unit_kg'].includes(other.field)))
      edit.targets.forEach(index => put(index, 'kg', items[index].kg))
  }
  for (const edit of parsed.filter(edit => edit.targets.length > 1 && edit.field === 'cartons')) {
    const sources = edit.indices.map(index => items[index])
    const quantities = sources.map(source => Number(source.qty) || 0)
    const weights = sources.map(source => Number(source.cartons) || 0)
    const shares = allocateShipmentCartons(Number(edit.value),
      weights.some(value => value > 0) ? weights : quantities)
    sources.forEach((source, i) => put(edit.indices[i], 'cartons', source.carton_group ? edit.value : shares[i]))
  }
  const result = applyShipmentSheetEdits(items, materials, [...expanded.values()])
  // Controlled text inputs submit on every keystroke. Keep intermediate spaces
  // and newlines after validation so the next character does not join words.
  // Pasted and filled cells retain the shared editor's normalization.
  if (options.preserveTextWhitespace) for (const edit of parsed) {
    if (directTextFields.has(edit.field)) edit.targets.forEach(index => {
      Object.assign(result.items[index], { [edit.field]: edit.rawValue })
    })
  }
  // A common supplier/company edit may clear the legacy batch editor's group
  // marker. Keep a complete physical group intact when its final scope is still
  // uniform; splitting it needs the explicit unmerge action and carton review.
  const cartonGroups = new Map<string, number[]>()
  items.forEach((item, index) => {
    const key = cartonGroupKey(item, materials)
    if (key) cartonGroups.set(key, [...(cartonGroups.get(key) || []), index])
  })
  let restoredCartonGroup = false
  for (const indices of cartonGroups.values()) {
    if (indices.length < 2 || !indices.some(index => !result.items[index].carton_group)) continue
    if (new Set(indices.map(index => shipmentScope(result.items[index], result.materials))).size !== 1)
      throw new Error('修改供应商或报关公司会拆开共箱，请先取消箱数组合并核对实际箱数')
    indices.forEach(index => {
      result.items[index].carton_group = items[index].carton_group
      result.items[index].cartons = items[index].cartons
    })
    restoredCartonGroup = true
  }
  if (restoredCartonGroup) {
    // The same legacy group label can identify separate physical groups in
    // different scopes. Moving a whole group must not merge those identities.
    const finalOwners = new Map<string, string>()
    for (const [originalKey, indices] of cartonGroups) for (const index of indices) {
      const finalKey = cartonGroupKey(result.items[index], result.materials)
      if (!finalKey) continue
      if (finalOwners.has(finalKey) && finalOwners.get(finalKey) !== originalKey)
        throw new Error('修改后的共箱范围与另一个独立箱数组合冲突，请先取消箱数组合并核对实际箱数')
      finalOwners.set(finalKey, originalKey)
    }
    // Apply explicit carton edits again with the retained group identity so the
    // shared propagation and conflicting-total checks cover all its materials.
    result.items = applyShipmentSheetEdits(result.items, result.materials,
      [...expanded.values()].filter(edit => edit.field === 'cartons')).items
  }
  // Resolve the whole paste first: a simultaneous kg/unit edit determines the
  // visible declaration basis. Only explicit price edits change the source price.
  for (const edit of parsed.filter(edit => edit.field === 'price')) for (const index of edit.indices) {
    const item = result.items[index]
    item.price = shipmentStoredDeclarationPrice(item, Number(edit.value), result.materials.get(item.material_id!))
  }
  const changedOutbound = new Set(result.items.flatMap((item, index) =>
    item.outbound_id && Number(item.qty) > Number(items[index].qty || 0) ? [item.outbound_id] : []))
  for (const outboundId of changedOutbound) {
    const balance = balances.find(row => row.outbound_id === outboundId)
    if (!balance || !Number.isFinite(Number(balance.allocatable_qty))) throw new Error(`OUT-${outboundId} 的可分配量未加载，请重试`)
    const used = result.items.filter(item => item.outbound_id === outboundId).reduce((sum, item) => sum + Number(item.qty || 0), 0)
    if (used > Number(balance.allocatable_qty) + 0.00000001)
      throw new Error(`OUT-${outboundId} 分配后数量 ${used} 超过可分配量 ${balance.allocatable_qty}，请减少合并数量`)
  }
  return result
}
