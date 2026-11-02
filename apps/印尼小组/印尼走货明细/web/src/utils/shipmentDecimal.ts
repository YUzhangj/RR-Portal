/** Exact four-decimal ticks of a JSON/Number value, within lossless integer range. */
export function shipmentDecimalTicks(value: number): number | undefined {
  const decimal = String(value).match(/^(-?)(\d+)(?:\.(\d{1,4}))?$/)
  if (!decimal) return undefined
  // Multiplication can introduce a whole tick of binary rounding near the
  // safe-integer boundary. Parse the actual serialized decimal instead.
  const ticks = BigInt(`${decimal[1]}${decimal[2]}${(decimal[3] || '').padEnd(4, '0')}`)
  const limit = BigInt(Number.MAX_SAFE_INTEGER)
  return ticks >= -limit && ticks <= limit ? Number(ticks) : undefined
}
