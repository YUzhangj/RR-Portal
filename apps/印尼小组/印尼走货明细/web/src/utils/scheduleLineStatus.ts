export interface ScheduleStatusRow {
  orderNo?: string
  code?: string
  _scheduleLineId?: string
  _legacyPlacedEligible?: boolean
  _legacyProductionEligible?: boolean
}

export const scheduleLineKey = (r: ScheduleStatusRow) => r._scheduleLineId ?? ''
export const scheduleLegacyKey = (r: ScheduleStatusRow) => `${r.orderNo ?? ''}|${r.code ?? ''}`

export function scheduleManualPlaced(r: ScheduleStatusRow, keys: Set<string>): boolean {
  return !!scheduleLineKey(r) && (keys.has(scheduleLineKey(r)) ||
    (r._legacyPlacedEligible === true && keys.has(scheduleLegacyKey(r))))
}

export function toggleScheduleManual(r: ScheduleStatusRow, keys: Set<string>): Set<string> {
  const next = new Set(keys)
  if (!scheduleLineKey(r)) return next
  if (scheduleManualPlaced(r, keys)) {
    next.delete(scheduleLineKey(r))
    if (r._legacyPlacedEligible) next.delete(scheduleLegacyKey(r))
  } else next.add(scheduleLineKey(r))
  return next
}

export function scheduleAutoPlaced(r: ScheduleStatusRow, keys: Set<string>): boolean {
  // The legacy API only knows PO + product; it must not claim a newly added duplicate.
  return !!scheduleLineKey(r) && !!r.orderNo && !!r.code && r._legacyPlacedEligible === true && keys.has(scheduleLegacyKey(r))
}

// All schedule views use the same line-level status, including purchase pickers.
export function schedulePurchasePlaced(r: ScheduleStatusRow, autoKeys: Set<string>, manualKeys: Set<string>): boolean {
  return scheduleAutoPlaced(r, autoKeys) || scheduleManualPlaced(r, manualKeys)
}

export function scheduleActualProduction(r: ScheduleStatusRow, pos: Set<string>): boolean {
  return !!scheduleLineKey(r) && !!r.orderNo && r._legacyProductionEligible === true && pos.has(r.orderNo.trim())
}

export function scheduleProductionOverride(r: ScheduleStatusRow, overrides: Map<string, boolean>): boolean | undefined {
  return overrides.get(scheduleLineKey(r)) ??
    (r._legacyPlacedEligible === true ? overrides.get(scheduleLegacyKey(r)) : undefined)
}
