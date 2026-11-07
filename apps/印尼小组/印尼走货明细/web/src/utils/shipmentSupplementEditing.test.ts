import { expect, it } from 'vitest'
import type { Material } from '../api/client'
import { consolidateShipmentItems } from './shipmentConsolidation'
import { applyMergedShipmentEdits, mergedSnapshotEditable, mergedFieldEditable } from './shipmentMergedEditor'

// Fully synthetic rows matching the reported imported-pack + ordinary supplement shape.
function fixture(reverse = false) {
  const master: Material = { id: 989, name_zh: '合成彩盒', name_en: 'Synthetic box',
    product_code: 'TEST-1079', spec: '50x60CM', category: '彩盒/彩咭', unit_kg: 'KGM',
    hs_cn: '4819100000', hs_id: '48192000', net_per_pc: .10053 }
  const snapshot: Material = { ...master, name_en: 'Synthetic packed box',
    length: 100, width: 50, height: 20, weight_per_carton: 10.37, net_per_pc: .09953 }
  const common = { outbound_id: 132, price: .3411, purchase_charge_ratio: 1500 / 1515,
    currency: 'US$', purchase_unit: '个', supplier: '合成供应商', customs_company: '合成报关公司',
    po_no: 'IRRI-TEST-1079', po_date: '2026-11-07', formula_name: '合成彩盒', contract_no: '' }
  const packed = { ...common, _rowKey: 11, material_id: -11, material_snapshot: snapshot,
    qty: 1500, kg: 149.3, cartons: 15, qty_per_carton: '1-15/100', weighing_qty: 100,
    pallet: '1-15/5卡', product_use: '合成测试配件', bl_head: '華登製品實業有限公司' }
  const supplement = { ...common, _rowKey: 19, material_id: 989, qty: 15, kg: 1.51, cartons: 0 }
  const items = reverse ? [supplement, packed] : [packed, supplement]
  return { master, snapshot, packed, supplement, items,
    materials: new Map<number, Material>([[989, master], [-11, snapshot]]) }
}

it.each([false, true])('keeps the physical packing owner and original allocations when source order is reversed=%s', reverse => {
  const f = fixture(reverse), original = structuredClone(f.items)
  const rows = consolidateShipmentItems(f.items, f.materials)
  expect(rows).toHaveLength(1)
  expect(rows[0].packing_source).toBe(f.packed)
  expect(rows[0]).toMatchObject({ qty: 1515, kg: 150.81, cartons: 15, qty_per_carton: '1-15/100' })
  expect(rows[0].sources).toEqual(f.items)
  expect(f.items).toEqual(original)
  expect(f.items.every(item => !('packing_source' in item))).toBe(true)
})

const packingChanges = [
  ['pallet', 'A-NEW', 'A-NEW'], ['carton_no', '1-15', '1-15'], ['cartons', '18', 18],
  ['qty_per_carton', '150', '150'], ['qty_per_carton', '1-10/150', '1-10/150'],
  ['weighing_qty', '200', 200], ['material:length', '120', 120], ['material:width', '60', 60],
  ['material:height', '25', 25], ['material:weight_per_carton', '11', 11],
] as const
for (const reverse of [false, true]) it.each(packingChanges)(
  `edits only the packing owner for %s=%s, reversed=${reverse}`, (field, value, expected) => {
    const f = fixture(reverse), before = structuredClone(f.items), beforeMaster = structuredClone(f.master)
    const rows = consolidateShipmentItems(f.items, f.materials)
    const result = applyMergedShipmentEdits(f.items, f.materials, rows, [{ row: 0, field, value }])
    const packed = result.items.find(item => item._rowKey === 11)!
    const supplement = result.items.find(item => item._rowKey === 19)!
    expect(supplement).toEqual(f.supplement)
    expect(result.materials.get(989)).toEqual(beforeMaster)
    expect(result.dirtyMaterials.has(989)).toBe(false)
    expect(packed.qty).toBe(1500)
    expect(packed.kg).toBe(149.3)
    if (field.startsWith('material:')) {
      expect(result.materials.get(-11)?.[field.slice(9) as keyof Material]).toBe(expected)
      expect([...result.dirtyMaterials]).toEqual([-11])
    }
    else expect(packed[field as keyof typeof packed]).toBe(expected)
    if (field === 'qty_per_carton') expect(packed.cartons).toBe(10)
    expect(consolidateShipmentItems(result.items, result.materials)).toHaveLength(1)
    expect(f.items).toEqual(before)
    expect(f.master).toEqual(beforeMaster)
  },
)

it('preserves interactive whitespace only on the physical packing owner', () => {
  const f = fixture(), rows = consolidateShipmentItems(f.items, f.materials)
  const result = applyMergedShipmentEdits(f.items, f.materials, rows,
    [{ row: 0, field: 'pallet', value: 'A  B\n' }], [], { preserveTextWhitespace: true })
  expect(result.items.find(item => item._rowKey === 11)).toHaveProperty('pallet', 'A  B\n')
  expect(result.items.find(item => item._rowKey === 19)).toEqual(f.supplement)
  expect(consolidateShipmentItems(result.items, result.materials)).toHaveLength(1)
})

it('still applies a common contract to both original allocations without copying packing', () => {
  const f = fixture(), rows = consolidateShipmentItems(f.items, f.materials)
  const result = applyMergedShipmentEdits(f.items, f.materials, rows,
    [{ row: 0, field: 'contract_no', value: 'TEST-CONTRACT' }])
  expect(result.items).toEqual(f.items.map(item => ({ ...item, contract_no: 'TEST-CONTRACT' })))
  expect(result.dirtyMaterials.size).toBe(0)
  expect(consolidateShipmentItems(result.items, result.materials)).toHaveLength(1)
})

it('keeps an explicitly linked supplementary batch with its original physical group', () => {
  const f = fixture()
  const linked = { ...f.master, shipment_outbound_link_group: 'TEST-EXPLICIT-LINK' }
  const partA = { ...f.supplement, material_id: -19, material_snapshot: linked }
  const partB = { ...partA, _rowKey: 20, material_id: -20, outbound_id: 133, qty: 5, kg: .50265 }
  const materials = new Map([...f.materials, [-19, linked], [-20, linked]])
  const rows = consolidateShipmentItems([f.packed, partA, partB], materials)
  expect(rows).toHaveLength(2)
  expect(rows.find(row => row.sources.some(source => source._rowKey === 11))?.sources).toEqual([f.packed])
  const group = rows.find(row => row.sources.some(source => source._rowKey === 19))!
  expect(group.sources).toEqual([partA, partB])
  expect(group.qty).toBe(20)
  expect(group.packing_source).toBeUndefined()
})

it('does not join different related product codes even when material and outbound IDs match', () => {
  const f = fixture()
  const materials = new Map(f.materials)
  materials.set(989, { ...f.master, related_product_code: 'OTHER-PRODUCT' })
  expect(consolidateShipmentItems(f.items, materials)).toHaveLength(2)
})

it('blocks mixed imported/catalogue HS editing before any other pasted field changes', () => {
  const f = fixture(), rows = consolidateShipmentItems(f.items, f.materials)
  const original = structuredClone(f.items), originalMaterials = structuredClone(f.materials)
  expect(mergedSnapshotEditable(rows[0])).toBe(false)
  expect(() => applyMergedShipmentEdits(f.items, f.materials, rows, [
    { row: 0, field: 'contract_no', value: 'MUST-NOT-APPLY' },
    { row: 0, field: 'snapshot:hs_cn', value: '0012345678' },
  ])).toThrow(/海关|导入|只读/)
  expect(f.items).toEqual(original)
  expect(f.materials).toEqual(originalMaterials)
})

it('allows HS editing only when every original source is a local negative-ID snapshot', () => {
  const f = fixture()
  const supplement = { ...f.supplement, material_id: -19, material_snapshot: { ...f.master } }
  const items = [f.packed, supplement], materials = new Map([...f.materials, [-19, supplement.material_snapshot]])
  const rows = consolidateShipmentItems(items, materials)
  expect(rows).toHaveLength(1)
  expect(mergedSnapshotEditable(rows[0])).toBe(true)
  const result = applyMergedShipmentEdits(items, materials, rows,
    [{ row: 0, field: 'snapshot:hs_cn', value: '0012345678' }])
  expect(result.items.map(item => item.material_snapshot.hs_cn)).toEqual(['0012345678', '0012345678'])
  expect(result.materials.get(989)?.hs_cn).toBe(f.master.hs_cn)
  expect(result.dirtyMaterials.size).toBe(0)
  expect(consolidateShipmentItems(result.items, result.materials)).toHaveLength(1)
  expect(mergedSnapshotEditable({ ...rows[0], sources: [] })).toBe(false)
  expect(mergedSnapshotEditable({ ...rows[0], sources: [f.packed, { ...supplement, material_id: 989 }] })).toBe(false)
})

it.each([['material:unit_kg', 'PCE'], ['material:net_per_pc', '.2']])(
  'rejects mixed-source %s before applying any other pasted changes', (field, value) => {
    const f = fixture(), rows = consolidateShipmentItems(f.items, f.materials)
    const before = structuredClone(f.items), beforeMaterials = structuredClone(f.materials)
    expect(mergedFieldEditable(rows[0], field)).toBe(false)
    expect(() => applyMergedShipmentEdits(f.items, f.materials, rows, [
      { row: 0, field: 'pallet', value: 'MUST-NOT-APPLY' }, { row: 0, field, value },
    ])).toThrow(/来源|不能.*修改/)
    expect(f.items).toEqual(before)
    expect(f.materials).toEqual(beforeMaterials)
  },
)

it.each([['material:unit_kg', 'PCE'], ['material:net_per_pc', '.2']])(
  'retains existing ordinary single-row %s editing', (field, value) => {
    const f = fixture(), items = [f.supplement], rows = consolidateShipmentItems(items, f.materials)
    expect(mergedFieldEditable(rows[0], field)).toBe(true)
    const result = applyMergedShipmentEdits(items, f.materials, rows, [{ row: 0, field, value }])
    expect(result.materials.get(989)?.[field.slice(9) as keyof Material]).toBe(field.endsWith('unit_kg') ? 'PCE' : .2)
    expect(result.items[0].kg).toBe(field.endsWith('unit_kg') ? 15 : 3)
    expect(result.dirtyMaterials.has(989)).toBe(true)
  },
)

it.each(['material:length', 'material:width', 'material:height', 'material:weight_per_carton'])(
  'rejects %s when ordinary packed and supplement rows share the catalogue record', field => {
    const f = fixture(), packed = { ...f.packed, material_id: 989, material_snapshot: undefined }
    const items = [packed, f.supplement], before = structuredClone(items), beforeMaterials = structuredClone(f.materials)
    const rows = consolidateShipmentItems(items, f.materials)
    expect(rows).toHaveLength(1)
    expect(mergedFieldEditable(rows[0], field)).toBe(false)
    expect(() => applyMergedShipmentEdits(items, f.materials, rows, [
      { row: 0, field: 'contract_no', value: 'MUST-NOT-APPLY' }, { row: 0, field, value: '100' },
    ])).toThrow(/共用|不能.*修改/)
    expect(items).toEqual(before)
    expect(f.materials).toEqual(beforeMaterials)
    expect(mergedFieldEditable(rows[0], 'pallet')).toBe(true)
    const result = applyMergedShipmentEdits(items, f.materials, rows, [{ row: 0, field: 'pallet', value: 'NEW-PALLET' }])
    expect(result.items[0]).toHaveProperty('pallet', 'NEW-PALLET')
    expect(result.items[1]).toEqual(f.supplement)
    expect(result.dirtyMaterials.size).toBe(0)
  },
)
