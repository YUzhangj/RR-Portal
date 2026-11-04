import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { consolidateShipmentItems } from './shipmentConsolidation'
import { shipmentPackingAverageQty, shipmentWeightQuantity } from './shipmentWeight'
import { applyShipmentSheetEdits } from './shipmentSheet'
import { linkShipmentOutbound } from './shipmentOutboundLink'
import { linkShipmentOutboundBatches } from './shipmentOutboundBatchLink'
import { applyMergedShipmentEdits } from './shipmentMergedEditor'
import { shipmentDeclarationSaveError } from './shipmentDeclarationSaveValidation'

// Execute the actual page save handler against a mock API. No business records
// are created while verifying that the one-row view still saves both batches.
const source = readFileSync(new URL('../pages/ShipmentsPage.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('ShipmentsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const functions: string[] = []
function collect(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && ['save', 'effectiveWeighingQty'].includes(node.name.text))
    functions.push(node.getText(tree))
  ts.forEachChild(node, collect)
}
collect(tree)
const executable = ts.transpileModule(functions.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const rows = [
  { _rowKey: 1, material_id: 974, outbound_id: 74, qty: 8150, kg: 738.39, cartons: 82, carton_no: '1-82', qty_per_carton: '100', price: 2, po_no: 'PO-1', po_date: '2026-10-01' },
  { _rowKey: 2, material_id: 974, outbound_id: 75, qty: 82, kg: 7.4292, cartons: 1, carton_no: '83', qty_per_carton: '100', price: 3, po_no: 'PO-2', po_date: '2026-10-02' },
]
const materials = new Map([[974, { id: 974, name_zh: '彩盒-FSC', net_per_pc: 0.0906 }]])

it.each([true, false])('换算单价落库会改变金额时保留草稿，拒绝新建或改单及物料写入（新建=%s）', async creating => {
  const items = [{ material_id: -1, material_snapshot: { unit_kg: 'PCE' }, qty: 10000000, kg: 10000000, price: .000003996 }]
  const original = structuredClone(items)
  const api = { post: vi.fn(), put: vi.fn() }
  const state = {
    items, creating, editing: creating ? null : { id: 9 }, editorLoadState: { current: 'ready' }, sheetEditing: false,
    matMap: new Map(), dirtyMatIds: new Set([974]), api,
    form: { validateFields: vi.fn(async () => ({ container_no: 'PRICE-PRECISION-TEST' })) },
    shipmentDeclarationSaveError, resetSheetUndo: vi.fn(), setSaving: vi.fn(), setEditing: vi.fn(), setCreating: vi.fn(),
    setEditorDirty: vi.fn(), setDirtyMatIds: vi.fn(), closeEditor: vi.fn(), load: vi.fn(),
    message: { success: vi.fn(), error: vi.fn() },
  }
  const context = createContext(state)
  runInContext(executable, context)
  expect(await runInContext('save(true)', context)).toBe(false)
  expect(state.message.error).toHaveBeenCalledWith(expect.stringMatching(/39\.96.*40\.00/))
  expect(api.post).not.toHaveBeenCalled()
  expect(api.put).not.toHaveBeenCalled()
  expect(state.setEditorDirty).not.toHaveBeenCalled()
  expect(state.setDirtyMatIds).not.toHaveBeenCalled()
  expect(state.closeEditor).not.toHaveBeenCalled()
  expect(state.load).not.toHaveBeenCalled()
  expect(items).toEqual(original)
})

it.each([true, false])('汇总视图保存仍逐批保留出库数量（新建=%s）', async creating => {
  const items = structuredClone(rows)
  const consolidatedItems = consolidateShipmentItems(items, materials)
  expect(consolidatedItems).toHaveLength(1)
  expect(consolidatedItems[0].carton_no).toBe('1-82 / 83')
  const api = { post: vi.fn(async (..._args: any[]) => { void _args; return { data: { id: 9 } } }), put: vi.fn(async (..._args: any[]) => { void _args; return {} }) }
  const context = createContext({
    items, consolidatedItems, showConsolidated: true, creating, editing: creating ? null : { id: 9 }, editorLoadState: { current: 'ready' }, sheetEditing: false,
    matMap: materials, dirtyMatIds: new Set(), api,
    form: { validateFields: async () => ({ container_no: 'TEST-ONLY', customer: 'RRI' }) },
    resetSheetUndo: vi.fn(), setSaving: vi.fn(), setEditing: vi.fn(), setCreating: vi.fn(), setEditorDirty: vi.fn(),
    setDirtyMatIds: vi.fn(), closeEditor: vi.fn(), load: vi.fn(), message: { success: vi.fn() },
    shipmentPackingAverageQty, shipmentWeightQuantity, shipmentDeclarationSaveError, num: (value: any) => Number(value) || 0,
  })
  runInContext(executable, context)
  expect(await runInContext('save()', context)).toBe(true)
  const calls = creating ? api.post.mock.calls : api.put.mock.calls
  expect(calls).toHaveLength(1)
  const saved = calls[0][1].items
  expect(saved.map((row: any) => [row.outbound_id, row.qty, row.kg, row.cartons]))
    .toEqual([[74, 8150, 738.39, 82], [75, 82, 7.4292, 1]])
  expect(saved.every((row: any) => !row.sources && !row.outbound_ids)).toBe(true)
  expect(saved.map((row: any) => row.carton_no)).toEqual(['1-82', '83'])
  expect(saved.map((row: any) => [row.price, row.po_no, row.po_date]))
    .toEqual([[2, 'PO-1', '2026-10-01'], [3, 'PO-2', '2026-10-02']])
  expect(items).toEqual(rows)

  // Editing one batch changes only its allocation; display consolidation must
  // never spread a revised total over all outbound records.
  items[1] = { ...items[1], qty: 40, kg: 3.624 }
  expect(await runInContext('save()', context)).toBe(true)
  const revised = calls[1][1].items
  expect(revised.map((row: any) => [row.outbound_id, row.qty])).toEqual([[74, 8150], [75, 40]])
})

it('表格批量编辑后保存仍保留每批关联，并将导入物料修改仅写入快照', async () => {
  const snapshot = { name_zh: '导入裁片', net_per_pc: .001, unit_kg: 'KGM' }
  const input = [...structuredClone(rows), { _rowKey: 3, material_id: -3, material_snapshot: snapshot, qty: 100, kg: .1, cartons: 1, qty_per_carton: '100' }]
  const mats = new Map<number, any>([...materials, [-3, snapshot]])
  const result = applyShipmentSheetEdits(input, mats, [
    { row: 1, field: 'qty', value: '40' }, { row: 2, field: 'material:net_per_pc', value: '.002' },
  ])
  const api = { put: vi.fn(async (..._args: any[]) => { void _args; return {} }) }
  const context = createContext({
    items: result.items, creating: false, editing: { id: 9 }, editorLoadState: { current: 'ready' }, sheetEditing: false,
    matMap: result.materials, dirtyMatIds: result.dirtyMaterials, api,
    form: { validateFields: async () => ({ container_no: 'TEST-ONLY', customer: 'RRI' }) },
    resetSheetUndo: vi.fn(), setSaving: vi.fn(), setEditing: vi.fn(), setCreating: vi.fn(), setEditorDirty: vi.fn(),
    setDirtyMatIds: vi.fn(), closeEditor: vi.fn(), load: vi.fn(), message: { success: vi.fn() },
    shipmentPackingAverageQty, shipmentWeightQuantity, shipmentDeclarationSaveError, num: (value: any) => Number(value) || 0,
  })
  runInContext(executable, context)
  expect(await runInContext('save()', context)).toBe(true)
  expect(api.put.mock.calls).toHaveLength(1)
  const saved = api.put.mock.calls[0][1].items
  expect(saved.slice(0, 2).map((row: any) => [row.outbound_id, row.material_id, row.qty])).toEqual([[74, 974, 8150], [75, 974, 40]])
  expect(saved[2]).toMatchObject({ material_id: null, material_snapshot: { net_per_pc: .002 }, kg: .2 })
  expect(saved[2]._rowKey).toBeUndefined()
  expect(snapshot.net_per_pc).toBe(.001)
})

it('在合并行修改合同和箱号后，保留两批原数量重量，再打开仍为同一行', async () => {
  const mergedRows = consolidateShipmentItems(rows, materials)
  const result = applyMergedShipmentEdits(rows, materials, mergedRows, [
    { row: 0, field: 'carton_no', value: '1-83' }, { row: 0, field: 'contract_no', value: 'MERGED-CONTRACT' },
  ])
  const api = { put: vi.fn(async (..._args: any[]) => { void _args; return {} }) }
  const context = createContext({
    items: result.items, creating: false, editing: { id: 9 }, editorLoadState: { current: 'ready' }, sheetEditing: false, matMap: result.materials, dirtyMatIds: new Set(), api,
    form: { validateFields: async () => ({ container_no: 'TEST-ONLY', customer: 'RRI' }) },
    resetSheetUndo: vi.fn(), setSaving: vi.fn(), setEditing: vi.fn(), setEditorDirty: vi.fn(), load: vi.fn(), message: { success: vi.fn() },
    shipmentPackingAverageQty, shipmentWeightQuantity, shipmentDeclarationSaveError, num: (value: any) => Number(value) || 0,
  })
  runInContext(executable, context)
  expect(await runInContext('save()', context)).toBe(true)
  const saved = api.put.mock.calls[0][1].items
  expect(saved.map((row: any) => [row.outbound_id, row.qty, row.kg, row.cartons, row.po_no, row.price, row.contract_no]))
    .toEqual([[74, 8150, 738.39, 82, 'PO-1', 2, 'MERGED-CONTRACT'], [75, 82, 7.4292, 1, 'PO-2', 3, 'MERGED-CONTRACT']])
  const reloaded = consolidateShipmentItems(saved, materials)
  expect(reloaded).toHaveLength(1)
  expect(reloaded[0]).toMatchObject({ qty: 8232, kg: 745.8192, cartons: 83, carton_no: '1-83', outbound_ids: [74, 75] })
})

it('导入行确认关联后保存真实物料 ID、出库来源和装箱快照，不写回物料库', async () => {
  const snapshot = { name_zh: '导入彩盒', length: 23, net_per_pc: .2, unit_kg: 'KGM' }
  const imported = { _rowKey: 3, material_id: -3, material_snapshot: snapshot, qty: 2, kg: .4, cartons: 1, carton_no: '10', pallet: 'A' }
  const linked = linkShipmentOutbound([imported], 3, { outbound_id: 74, material_id: 974, allocatable_qty: 10, price: 0 },
    materials.get(974)!, new Map([[-3, snapshot]]))
  const api = { put: vi.fn(async (..._args: any[]) => { void _args; return {} }) }
  const context = createContext({
    items: linked, creating: false, editing: { id: 9 }, editorLoadState: { current: 'ready' }, sheetEditing: false, matMap: new Map([[-3, linked[0].material_snapshot]]), dirtyMatIds: new Set(), api,
    form: { validateFields: async () => ({ container_no: 'TEST-ONLY' }) },
    resetSheetUndo: vi.fn(), setSaving: vi.fn(), setEditing: vi.fn(), setEditorDirty: vi.fn(), load: vi.fn(), message: { success: vi.fn() },
    shipmentPackingAverageQty, shipmentWeightQuantity, shipmentDeclarationSaveError, num: (value: any) => Number(value) || 0,
  })
  runInContext(executable, context)
  expect(await runInContext('save()', context)).toBe(true)
  expect(api.put).toHaveBeenCalledTimes(1)
  expect(api.put.mock.calls[0][1].items).toEqual([expect.objectContaining({
    material_id: 974, outbound_id: 74, qty: 2, kg: .4, cartons: 1, carton_no: '10', pallet: 'A',
    material_snapshot: expect.objectContaining({ id: 974, length: 23 }),
  })])
})

it('一条导入明细多批关联后只保存原始批次，重开仍汇总且不写回物料库', async () => {
  const snapshot = { name_zh: '导入彩盒', length: 23, net_per_pc: .2, unit_kg: 'KGM' }
  const imported = { _rowKey: 1, material_id: -1, material_snapshot: snapshot, qty: 10, kg: 2.0001,
    cartons: 2, qty_per_carton: '1/4 2/6', carton_no: '1-2', pallet: '1/2卡' }
  const linked = linkShipmentOutboundBatches([imported], 1, [
    { source: { outbound_id: 74, material_id: 974, allocatable_qty: 4, price: 2, po_no: 'PO-1' }, qty: 4 },
    { source: { outbound_id: 75, material_id: 974, allocatable_qty: 6, price: 3, po_no: 'PO-2', purchase_charge_ratio: .5 }, qty: 6 },
  ], materials.get(974)!, new Map([[-1, snapshot]]), 'link-test')
  const items = linked.map((item, index) => ({ ...item, _rowKey: index + 1, material_id: -(index + 1) }))
  const mats = new Map(items.map(item => [item.material_id, item.material_snapshot]))
  const api = { put: vi.fn(async (..._args: any[]) => { void _args; return {} }) }
  const context = createContext({
    items, creating: false, editing: { id: 9 }, editorLoadState: { current: 'ready' }, sheetEditing: false,
    matMap: mats, dirtyMatIds: new Set(), api,
    form: { validateFields: async () => ({ container_no: 'TEST-ONLY' }) },
    resetSheetUndo: vi.fn(), setSaving: vi.fn(), setEditing: vi.fn(), setEditorDirty: vi.fn(), load: vi.fn(), message: { success: vi.fn() },
    shipmentPackingAverageQty, shipmentWeightQuantity, shipmentDeclarationSaveError, num: (value: any) => Number(value) || 0,
  })
  runInContext(executable, context)
  expect(await runInContext('save()', context)).toBe(true)
  expect(api.put).toHaveBeenCalledTimes(1)
  expect(api.put.mock.calls[0][0]).toBe('/shipments/9')
  const saved = api.put.mock.calls[0][1].items
  expect(saved.map((item: any) => [item.outbound_id, item.material_id, item.qty, item.price, item.po_no]))
    .toEqual([[74, 974, 4, 2, 'PO-1'], [75, 974, 6, 3, 'PO-2']])
  expect(saved.every((item: any) => !item.sources && !item.outbound_ids && !item._rowKey)).toBe(true)
  expect(saved[0].material_snapshot).toMatchObject({ id: 974, length: 23, shipment_outbound_link_group: 'link-test' })
  const reloaded = saved.map((item: any, index: number) => ({ ...item, _rowKey: index + 1, material_id: -(index + 1) }))
  const display = consolidateShipmentItems(reloaded, new Map(reloaded.map((item: any) => [item.material_id, item.material_snapshot])))
  expect(display).toHaveLength(1)
  expect(display[0]).toMatchObject({ qty: 10, kg: 2.0001, cartons: 2, outbound_ids: [74, 75] })
})
