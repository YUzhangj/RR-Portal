import { describe, it, expect } from 'vitest'
import { scheduleManualPlaced, toggleScheduleManual, scheduleAutoPlaced,
  scheduleProductionOverride, scheduleActualProduction, schedulePurchasePlaced } from './scheduleLineStatus'

const oldRow = { orderNo: 'MA', code: '47712A', _scheduleLineId: 'line:old',
  _legacyPlacedEligible: true, _legacyProductionEligible: true }
const newRow = { ...oldRow, _scheduleLineId: 'line:new',
  _legacyPlacedEligible: false, _legacyProductionEligible: false }

describe('schedule line status isolation', () => {
  it('legacy manual flag only follows the historical row', () => {
    const keys = new Set(['MA|47712A'])
    expect(scheduleManualPlaced(oldRow, keys)).toBe(true)
    expect(scheduleManualPlaced(newRow, keys)).toBe(false)
  })
  it('new line can be independently marked and cancelled', () => {
    const original = new Set(['MA|47712A'])
    const marked = toggleScheduleManual(newRow, original)
    expect(scheduleManualPlaced(oldRow, marked)).toBe(true)
    expect(scheduleManualPlaced(newRow, marked)).toBe(true)
    const cancelled = toggleScheduleManual(newRow, marked)
    expect(scheduleManualPlaced(oldRow, cancelled)).toBe(true)
    expect(scheduleManualPlaced(newRow, cancelled)).toBe(false)
    expect(original).toEqual(new Set(['MA|47712A']))
  })
  it('cancelling old legacy flag leaves a marked new line unchanged', () => {
    const keys = toggleScheduleManual(oldRow, new Set(['MA|47712A', 'line:new']))
    expect(scheduleManualPlaced(oldRow, keys)).toBe(false)
    expect(scheduleManualPlaced(newRow, keys)).toBe(true)
  })
  it('automatic PO match cannot mark the new duplicate', () => {
    const keys = new Set(['MA|47712A'])
    expect(scheduleAutoPlaced(oldRow, keys)).toBe(true)
    expect(scheduleAutoPlaced(newRow, keys)).toBe(false)
  })
  it('production PO and manual overrides do not leak to new row', () => {
    const overrides = new Map([['MA|47712A', true]])
    expect(scheduleProductionOverride(oldRow, overrides)).toBe(true)
    expect(scheduleProductionOverride(newRow, overrides)).toBeUndefined()
    expect(scheduleActualProduction(oldRow, new Set(['MA']))).toBe(true)
    expect(scheduleActualProduction(newRow, new Set(['MA']))).toBe(false)
    overrides.set('line:old', false)
    expect(scheduleProductionOverride(oldRow, overrides)).toBe(false)
  })
  it('missing row identity fails closed', () => {
    const row = { orderNo: 'MA', code: '47712A' }
    const keys = new Set(['MA|47712A'])
    expect(scheduleManualPlaced(row, keys)).toBe(false)
    expect(scheduleAutoPlaced(row, keys)).toBe(false)
    expect(toggleScheduleManual(row, keys)).toEqual(keys)
  })
})


describe('shared schedule and order picker status', () => {
  it('line-level manual marks are counted and hidden by the purchase picker', () => {
    const manual = toggleScheduleManual(newRow, new Set())
    const rows = [oldRow, newRow]
    const placed = (r: typeof oldRow) => schedulePurchasePlaced(r, new Set(), manual)
    expect(rows.filter(placed)).toEqual([newRow])
    expect(rows.filter(r => !placed(r))).toEqual([oldRow])
    expect(schedulePurchasePlaced(newRow, new Set(), toggleScheduleManual(newRow, manual))).toBe(false)
  })
  it('legacy manual and actual purchase keys never hide a newly added duplicate', () => {
    const legacy = new Set(['MA|47712A'])
    for (const [auto, manual] of [[legacy, new Set<string>()], [new Set<string>(), legacy]]) {
      expect([oldRow, newRow].filter(r => !schedulePurchasePlaced(r, auto, manual))).toEqual([newRow])
    }
  })
  it('a separately marked new duplicate does not inherit status after cancellation', () => {
    const legacy = new Set(['MA|47712A'])
    const marked = toggleScheduleManual(newRow, legacy)
    expect([oldRow, newRow].filter(r => schedulePurchasePlaced(r, new Set(), marked))).toHaveLength(2)
    const cancelled = toggleScheduleManual(newRow, marked)
    expect([oldRow, newRow].filter(r => !schedulePurchasePlaced(r, new Set(), cancelled))).toEqual([newRow])
  })
  it('production picker keeps new duplicate visible when an old MA production order exists', () => {
    const actual = new Set(['MA'])
    expect([oldRow, newRow].filter(r => !scheduleActualProduction(r, actual))).toEqual([newRow])
  })
})
