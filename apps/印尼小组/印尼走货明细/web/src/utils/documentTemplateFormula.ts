export type DocumentTableLayout = {
  start: number
  end: number
  finalStart: number
  finalTotal: number
}

export type DocumentFormulaContext = {
  sheet: string
  main: string
  layouts: Map<string, DocumentTableLayout[]>
  detail?: { sourceRow: number; targetRow: number; mainRow: number }
}

export function documentRow(row: number, tables: DocumentTableLayout[]): number {
  let offset = 0
  for (const table of tables) {
    if (row < table.start) break
    if (row <= table.end) return table.finalStart + Math.min(row - table.start, table.finalTotal - table.finalStart - 1)
    offset = table.finalTotal - table.end - 1
  }
  return row + offset
}

// Parse references as tokens: quoted strings, sheet names and absolute anchors must
// never be changed by a blanket "replace every row number" operation.
export function rebindDocumentFormula(formula: string, context: DocumentFormulaContext): string {
  const reference = /"(?:[^"]|"")*"|(?<![\w.\u0080-\uFFFF])((?:'(?:[^']|'')+'|[\w\u0080-\uFFFF]+)!)?(\$?[A-Z]{1,3})(\$?)(\d+)?(?::(\$?[A-Z]{1,3})(\$?)(\d+)?)?(?![\w.\u0080-\uFFFF]|\s*\()/g
  return formula.replace(reference, (token, prefix = '', column, absolute, digits, endColumn, endAbsolute, endDigits) => {
    if (token.startsWith('"')) return token
    // Bare column names are names/functions, not cell references.
    if (!digits && !endColumn) return token
    const sheet = prefix ? prefix.slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'") : context.sheet
    const detail = context.detail
    if (sheet === context.main && detail) {
      // Lookup ranges are part of the template's matching rule. Do not replace
      // them with a single physical row: sorting the source must still work.
      if (endColumn) return token
      // A template's direct detail reference still follows the exported item.
      const source = (col: string, abs: string, row?: string) =>
        `${col}${abs}${row && Number(row) < 4 ? row : detail.mainRow}`
      return prefix + source(column, absolute, digits)
    }
    const tables = context.layouts.get(sheet)
    if (!tables || !digits) return token
    const row = Number(digits)
    const tableRange = endDigits && tables.find(table => row === table.start
      && Number(endDigits) >= table.start && Number(endDigits) <= table.end)
    if (tableRange) {
      return `${prefix}${column}${absolute}${tableRange.finalStart}:${endColumn}${endAbsolute}${tableRange.finalTotal - 1}`
    }
    const translate = (number: number, abs: string) => documentRow(number, tables)
      + (detail && sheet === context.sheet && !abs
        ? detail.targetRow - documentRow(detail.sourceRow, tables) : 0)
    return `${prefix}${column}${absolute}${translate(row, absolute)}`
      + (endColumn ? `:${endColumn}${endAbsolute}${endDigits ? translate(Number(endDigits), endAbsolute) : ''}` : '')
  })
}
