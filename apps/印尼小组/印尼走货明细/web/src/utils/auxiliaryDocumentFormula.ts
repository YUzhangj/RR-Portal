// Formula patterns from the approved 清溪柜 workbook. Keep the invoice serial
// lookup (not a physical row link): the invoice contains company subtotal rows.
export const AUXILIARY_TABLES = [
  { name: '销售合同', start: 16, total: 53, lastColumn: 'J' },
  { name: '装箱单 (2)', start: 10, total: 47, lastColumn: 'H' },
  { name: '草稿大单-1', start: 21, total: 52, lastColumn: 'Q' },
] as const

export function auxiliaryDetailFormulas(name: string, row: number) {
  const lookup = (column: string, fallback = false) =>
    `_xlfn.XLOOKUP($A${row},'发票'!$B:$B,'发票'!${fallback && ['I', 'K'].includes(column) ? `${column}:${column}` : `$${column}:$${column}`}${fallback ? ',""' : ''})`
  if (name === '销售合同') return {
    B: { formula: `_xlfn.HSTACK(${['C', 'D', 'E', 'F', 'G'].map(c => lookup(c)).join(',')})`, sources: ['C', 'D', 'E', 'F', 'G'] },
    I: { formula: lookup('I', true), sources: ['I'] },
  }
  if (name === '装箱单 (2)') return {
    B: { formula: `_xlfn.HSTACK(${['D', 'L', 'M', 'F', 'G', 'J', 'K'].map(c => lookup(c)).join(',')})`, sources: ['D', 'L', 'M', 'F', 'G', 'J', 'K'] },
  }
  return Object.fromEntries(Object.entries({ B: 'C', D: 'D', E: 'E', G: 'F', H: 'G', L: 'H', N: 'I', Q: 'K' })
    .map(([column, source]) => [column, { formula: lookup(source, true), sources: [source] }]))
}
