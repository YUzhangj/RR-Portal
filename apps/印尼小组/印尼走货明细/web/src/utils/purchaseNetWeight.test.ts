import { describe, expect, it } from 'vitest'
import { autoLinkPurchaseMaterials, planPurchaseNetWeight } from './purchaseNetWeight'
import { purchaseMaterialLine, purchaseMaterialChoices } from './purchaseMaterialSelection'

const profiles = [{ keyword: '星徽', full: '东莞市星徽纸品有限公司' }]
const material = { id: 10, product_code: '35874VAZJ', name_zh: '贴纸-FSC2', spec: '35615-00', supplier: '星徽', net_per_pc: 0.0004, unit_kg: 'TNE' }
const line = { material_id: 10, product_code: material.product_code, material_name: material.name_zh, spec: material.spec,
  net_per_pc: 0, ship_unit: 'TNE', qty: 20200, price: 0.07, received_qty: 100, tomy_po: 'PO1', eta: '2026-10-28', notes: '保留' }
const plan = (items = [line], materials = [material]) => planPurchaseNetWeight(items, materials, profiles[0].full, profiles)

describe('采购净重回填', () => {
  it('fills both linked and newly added lines without changing any business quantities or prices', () => {
    const added = { ...line, material_id: undefined }
    const rows = planPurchaseNetWeight([line, added], [material], profiles[0].full, profiles)
    expect(rows.every(r => r.ready)).toBe(true)
    for (const row of rows) expect(row.next).toEqual({ ...line, net_per_pc: 0.0004 })
    expect(line.net_per_pc).toBe(0)
    expect(added.material_id).toBeUndefined()
    expect(material.net_per_pc).toBe(0.0004)
  })
  it('recovers stale IDs only with a unique exact match', () => {
    const row = plan([{ ...line, material_id: 999 }])[0]
    expect(row.ready).toBe(true)
    expect(row.next.material_id).toBe(10)
  })
  it.each([0, -1, NaN, Infinity])('explains unusable source net weight %s and preserves previous data', net_per_pc => {
    const original = { ...line, net_per_pc: 0.0009 }
    const row = plan([original], [{ ...material, net_per_pc }])[0]
    expect(row.ready).toBe(false)
    expect(row.reason).toContain('单净重')
    expect(row.next).toBe(original)
  })
  it('does not borrow weight from another material when linked weight is zero', () => {
    const row = plan([line], [{ ...material, net_per_pc: 0 }, { ...material, id: 11 }])[0]
    expect(row.ready).toBe(false)
  })
  it('rejects duplicate fallback matches', () => {
    const row = plan([{ ...line, material_id: 999 }], [material, { ...material, id: 11 }])[0]
    expect(row.reason).toContain('多条')
  })
  it.each([{ product_code: '35874VAZ' }, { material_name: '贴纸-FSC1' }, { spec: '35614-00' }])('does not fuzzy-match %j', change => {
    expect(plan([{ ...line, material_id: 999, ...change }])[0].ready).toBe(false)
  })
  it('honours selected material ID for schedule codes with customer suffixes, but rejects merged rows', () => {
    expect(plan([{ ...line, product_code: '35874VAZJ-CUSTOMER' }])[0].ready).toBe(true)
    expect(plan([{ ...line, product_code: '35874VAZJ / OTHER' }])[0].reason).toContain('合并')
  })
  it('rejects another supplier and ambiguous full-name aliases', () => {
    const added = { ...line, material_id: undefined }
    expect(planPurchaseNetWeight([added], [material], '其他供应商', profiles)[0].ready).toBe(false)
    expect(planPurchaseNetWeight([added], [material], profiles[0].full,
      [...profiles, { keyword: '其他星徽', full: profiles[0].full }])[0].ready).toBe(false)
  })
  it('keeps existing shipment unit when master unit is blank', () => {
    expect(plan([line], [{ ...material, unit_kg: '' }])[0].next.ship_unit).toBe('TNE')
  })
  it('automatically restores identity even when weight is missing, without modifying other fields', () => {
    const missing = { ...line, material_id: undefined, net_per_pc: 0.009 }
    const result = autoLinkPurchaseMaterials([missing], [{ ...material, net_per_pc: 0 }], '星徽', profiles)
    expect(result.linked).toBe(1)
    expect(result.items[0]).toEqual({ ...missing, material_id: 10 })
    expect(autoLinkPurchaseMaterials(result.items, [material], '星徽', profiles).linked).toBe(0)
  })
  it('does not auto-link ambiguous materials', () => {
    const missing = { ...line, material_id: undefined }
    const result = autoLinkPurchaseMaterials([missing], [material, { ...material, id: 11 }], '星徽', profiles)
    expect(result.linked).toBe(0)
    expect(result.items[0]).toBe(missing)
    expect(result.issues[0]).toContain('多条')
  })
  it('preserves IDs and weight from both library and schedule selection through JSON save payload', () => {
    for (const group of [undefined, { key: 'schedule', code: '35874VAZJ-CUSTOMER', label: 'PO1', quantity: 20000 }]) {
      const choice = purchaseMaterialChoices([material], material.product_code, group)[0]
      const selected = purchaseMaterialLine(choice, '¥')
      const saved = JSON.parse(JSON.stringify(autoLinkPurchaseMaterials([selected], [material], '星徽', profiles).items))[0]
      expect(saved.material_id).toBe(10)
      expect(saved.net_per_pc).toBe(0.0004)
      expect(planPurchaseNetWeight([saved], [material], '星徽', profiles)[0].ready).toBe(true)
    }
  })
})
