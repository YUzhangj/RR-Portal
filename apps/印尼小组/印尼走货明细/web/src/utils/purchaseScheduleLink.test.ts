import { describe, expect, it } from 'vitest'
import { linkPurchaseLine, matchingLineSchedules } from './purchaseScheduleLink'

const schedule = { code: '35874VAZJ', orderNo: '10130001', eta: '2026-12-23', qty: 5000, source: 'RRM' }
const line = { id: 12, material_id: 81, product_code: '35874VAZJ', material_name: '贴纸',
  tomy_po: '', eta: '2026-10-28', ordered_qty: 20004, purchase_qty: 20200, material_qty: 20004,
  spoilage_qty: 196, price: 0.08, currency: '¥', ship_unit: 'TNE', net_per_pc: 0.0004, notes: '保留备注' }

describe('purchase line schedule association', () => {
  it('only changes order association and shipment date, without adding a line or overwriting money/quantities', () => {
    const linked = linkPurchaseLine(line, schedule, [schedule], [line], 'IRRMHS0066')
    expect(linked).toEqual({ ...line, tomy_po: '10130001', eta: '2026-12-23' })
    expect(line.eta).toBe('2026-10-28')
    expect(line.tomy_po).toBe('')
  })
  it('retains the manually entered date when the schedule has none', () => {
    const missingDate = { ...schedule, eta: '  ' }
    expect(linkPurchaseLine(line, missingDate, [missingDate], [line], '').eta).toBe(line.eta)
  })
  it('matches exact product codes, including suffixes, and requires an order number', () => {
    const unrelated = [{ ...schedule, code: '35874VAZ' }, { ...schedule, code: '35874VAZJ2' }, { ...schedule, orderNo: '' }]
    expect(matchingLineSchedules({ product_code: ' 35874vazj ' }, [...unrelated, schedule])).toEqual([schedule])
    expect(() => linkPurchaseLine(line, unrelated[0], unrelated, [line], '')).toThrow('完全一致')
  })
  it('does not replace associations of merged multi-product rows', () => {
    expect(matchingLineSchedules({ product_code: '35874VAZJ / 47669' }, [schedule])).toEqual([])
  })
  it('retains RRI/RRM contract source safeguards, including HSY orders', () => {
    expect(() => linkPurchaseLine(line, schedule, [schedule], [line], 'IRRIHS0410')).toThrow('当前 RRI')
    const existing = { ...line, product_code: '47669', tomy_po: 'OTHER' }
    const otherSchedule = { code: '47669', orderNo: 'OTHER', source: 'RRI' }
    expect(() => linkPurchaseLine(line, schedule, [schedule, otherSchedule], [line, existing], '2026900172')).toThrow('当前 RRI')
    expect(() => linkPurchaseLine(line, schedule, [schedule], [line, existing], '2026900172')).toThrow('未能确认')
  })
  it('replaces the selected row association only and can be reapplied without cumulative changes', () => {
    const existing = { ...line, tomy_po: schedule.orderNo }
    const newSchedule = { ...schedule, orderNo: '10130002', eta: '2026-12-30' }
    const linked = linkPurchaseLine(existing, newSchedule, [schedule, newSchedule], [existing], 'IRRMHS0066')
    expect(linked.tomy_po).toBe(newSchedule.orderNo)
    expect(linkPurchaseLine(linked, newSchedule, [schedule, newSchedule], [linked], 'IRRMHS0066')).toEqual(linked)
  })
})
