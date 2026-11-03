import { describe, expect, it } from 'vitest'
import { resolvePurchaseCustoms } from './purchaseCustoms'
import { poCorrectHsyNumber } from './poNumber'

const hsy = '深圳市华胜益出口贸易有限公司'
const profiles = [{ id: 1, keyword: '星徽', full: '东莞市星徽纸品有限公司', customs: hsy }]
const material = { id: 10, product_code: '35874VAZJ', name_zh: '车仔厂贴贴纸-FSC1', spec: '35614-00', supplier: '星徽', customs_company: '' }
const item = { material_id: 10, product_code: material.product_code, material_name: material.name_zh, spec: material.spec }

describe('旧采购单报关资料核对', () => {
  it('uses explicit customs from the linked material before its supplier profile', () => {
    const result = resolvePurchaseCustoms([item], profiles[0].full, [{ ...material, customs_company: '其他报关公司' }], profiles)
    expect(result[0].company).toBe('其他报关公司')
    expect(() => poCorrectHsyNumber('IRRMHS0066', result.map(r => r.company), [])).toThrow('全部明细')
  })

  it('reads the exact supplier profile when the linked material customs field is empty, without writing back', () => {
    const before = JSON.stringify({ item, material, profiles })
    const result = resolvePurchaseCustoms([item], profiles[0].full, [material], profiles)
    expect(result[0]).toEqual({ company: hsy, source: '第 1 行「车仔厂贴贴纸-FSC1」：供应商档案「星徽」的报关公司' })
    expect(JSON.stringify({ item, material, profiles })).toBe(before)
  })

  it.each([undefined, 999])('recovers a unique old material with missing/stale ID %s by exact fields', material_id => {
    const result = resolvePurchaseCustoms([{ ...item, material_id }], profiles[0].full, [material], profiles)
    expect(result[0].company).toBe(hsy)
  })

  it('rejects duplicate matches even if they use the same customs company', () => {
    expect(() => resolvePurchaseCustoms([{ ...item, material_id: 999 }], '星徽', [material, { ...material, id: 11 }], profiles)).toThrow('第 1 行「车仔厂贴贴纸-FSC1」：货号 35874VAZJ 匹配到多条物料')
  })

  it.each([
    { product_code: 'OTHER' }, { material_name: '相似名称' }, { spec: '35615-00' },
  ])('does not guess product/name/spec matches: %j', changed => {
    expect(() => resolvePurchaseCustoms([{ ...item, ...changed, material_id: undefined }], '星徽', [material], profiles)).toThrow('未找到唯一物料')
  })

  it('does not match another supplier merely because its company full name is shared', () => {
    const others = [...profiles, { id: 2, keyword: '其他显示名称', full: profiles[0].full, customs: hsy }]
    expect(() => resolvePurchaseCustoms([{ ...item, material_id: undefined }], '其他显示名称', [material], others)).toThrow('未找到唯一物料')
  })

  it('checks every product in a merged line instead of trusting its first material ID', () => {
    const materials = [material, { ...material, id: 11, product_code: 'OTHER', customs_company: '自报关' }]
    const result = resolvePurchaseCustoms([{ ...item, product_code: '35874VAZJ / OTHER' }], '星徽', materials, profiles)
    expect(result.map(r => r.company)).toEqual([hsy, '自报关'])
    expect(() => poCorrectHsyNumber('IRRMHS0066', result.map(r => r.company), [])).toThrow('全部明细')
  })

  it('does not use a PO supplier alone when no material can be identified', () => {
    expect(() => resolvePurchaseCustoms([{ ...item, material_id: undefined, product_code: '' }], '星徽', [], profiles)).toThrow('物料关联失效且缺少货号')
  })

  it.each([[], [profiles[0], { ...profiles[0], id: 2 }], [{ ...profiles[0], customs: '' }]])('explains missing or ambiguous supplier customs: %j', (...entries) => {
    expect(() => resolvePurchaseCustoms([item], '星徽', [material], entries)).toThrow('供应商档案未唯一匹配或未设置报关公司')
  })
})
