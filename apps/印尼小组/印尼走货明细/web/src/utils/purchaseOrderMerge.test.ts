import { describe, expect, it } from 'vitest'
import { purchaseLineDeliveryDate, purchaseLineSourceKey, purchaseOrderNumbers } from './purchaseOrderMerge'

describe('merged purchase order provenance', () => {
  it('uses whole-order delivery overrides while preserving the source date, including clearing', () => {
    const item = { source_po_no: '20269001', source_delivery_date: '2026-10-23', has_delivery_date_override: true, delivery_date_override: '2026-11-01' }
    expect(purchaseLineDeliveryDate(item, '2026-10-28')).toBe('2026-11-01')
    expect(purchaseLineDeliveryDate({ ...item, delivery_date_override: null }, '2026-10-28')).toBe('')
    expect(item.source_delivery_date).toBe('2026-10-23')
  })
  it('retains each source delivery date instead of the destination header date', () => {
    expect(purchaseLineDeliveryDate({ source_po_no: '20269001', source_delivery_date: '2026-10-23T00:00:00' }, '2026-11-01')).toBe('2026-10-23')
    expect(purchaseLineDeliveryDate({ source_po_no: '20269002', source_delivery_date: null }, '2026-11-01')).toBe('')
    expect(purchaseLineDeliveryDate({}, '2026-11-01')).toBe('2026-11-01')
  })
  it('reserves archived source numbers when generating the next PO', () => {
    expect(purchaseOrderNumbers([{ po_no: '20269001', merged_po_numbers: ['20269002', '20269003'] }])).toEqual(['20269001', '20269002', '20269003'])
  })
  it('keeps same-name lines from different sources or delivery dates separate', () => {
    const first = { source_po_no: '20269001', source_delivery_date: '2026-10-23' }
    expect(purchaseLineSourceKey(first)).not.toBe(purchaseLineSourceKey({ ...first, source_po_no: '20269002' }))
    expect(purchaseLineSourceKey(first)).not.toBe(purchaseLineSourceKey({ ...first, source_delivery_date: '2026-11-01' }))
    expect(purchaseLineSourceKey(first)).toBe(purchaseLineSourceKey({ ...first }))
  })
})
