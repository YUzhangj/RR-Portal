import { describe, it, expect } from 'vitest'
import { scheduleManualPlaced, toggleScheduleManual, scheduleAutoPlaced,
  scheduleProductionOverride, scheduleActualProduction } from './scheduleLineStatus'

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
