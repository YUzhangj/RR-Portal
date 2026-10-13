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

function quotedEnd(expression: string, start: number, end: number): number | undefined {
  const quote = expression[start]
  for (let index = start + 1; index < end; index++) {
    if (expression[index] !== quote) continue
    if (expression[index + 1] === quote) { index++; continue }
    return index + 1
  }
}

function balancedFormula(expression: string): boolean {
  const stack: string[] = []
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index]
    if (char === '"' || char === "'") {
      const next = quotedEnd(expression, index, expression.length)
      if (next == null) return false
      index = next - 1
    } else if ('({['.includes(char)) stack.push(char)
    else if (')}]'.includes(char)
      && stack.pop() !== ({ ')': '(', '}': '{', ']': '[' } as Record<string, string>)[char]) return false
  }
  return !stack.length
}

function lookupArguments(expression: string, open: number, end: number) {
  const arguments_: Array<[number, number]> = []
  const stack = ['(']
  let start = open + 1
  for (let index = start; index < end; index++) {
    const char = expression[index]
    if (char === '"' || char === "'") {
      const next = quotedEnd(expression, index, end)
      if (next == null) return
      index = next - 1
    } else if ('({['.includes(char)) stack.push(char)
    else if (')}]'.includes(char)) {
      if (stack.pop() !== ({ ')': '(', '}': '{', ']': '[' } as Record<string, string>)[char]) return
      if (!stack.length) {
        arguments_.push([start, index])
        return { arguments_, close: index }
      }
    } else if (char === ',' && stack.length === 1) {
      arguments_.push([start, index]); start = index + 1
    }
  }
}

function formulaSheets(expression: string): string[] {
  const sheets: string[] = []
  for (let index = 0; index < expression.length;) {
    const char = expression[index]
    if (char === '"' || char === "'") {
      const end = quotedEnd(expression, index, expression.length)
      if (end == null) return []
      if (char === "'" && /^\s*!/.test(expression.slice(end)))
        sheets.push(expression.slice(index + 1, end - 1).replace(/''/g, "'"))
      index = end
    } else if (char === '[') {
      // External-workbook and structured references are outside these templates.
      return ['\0']
    } else if (/[\w.\u0080-\uFFFF]/.test(char)) {
      const start = index
      while (index < expression.length && /[\w.\u0080-\uFFFF]/.test(expression[index])) index++
      if (/^\s*!/.test(expression.slice(index))) sheets.push(expression.slice(start, index))
    } else index++
  }
  return sheets
}

/** Keep a template LOOKUP's rules, but distinguish repeated materials by global serial. */
export function bindInvoiceLookupSerial(formula: string, mainName: string, row: number): string {
  if (!mainName || !Number.isInteger(row) || row < 1 || row > 1_048_576 || !balancedFormula(formula)) return formula
  const main = mainName.toUpperCase()
  const serial = `('${mainName.replace(/'/g, "''")}'!A:A=A${row})`
  const rewrite = (start: number, end: number): string => {
    let result = '', copied = start
    for (let index = start; index < end;) {
      const char = formula[index]
      if (char === '"' || char === "'") {
        const next = quotedEnd(formula, index, end)
        if (next == null) break
        index = next; continue
      }
      if (!/[A-Za-z_\u0080-\uFFFF]/.test(char)) { index++; continue }
      const nameStart = index
      while (index < end && /[\w.\u0080-\uFFFF]/.test(formula[index])) index++
      if (formula.slice(nameStart, index).toUpperCase() !== 'LOOKUP'
        || (nameStart > start && /[\w.$\u0080-\uFFFF]/.test(formula[nameStart - 1]))) continue
      let open = index
      while (open < end && /\s/.test(formula[open])) open++
      if (formula[open] !== '(') continue
      const call = lookupArguments(formula, open, end)
      if (!call) continue
      const original = call.arguments_.map(([from, to]) => formula.slice(from, to))
      const arguments_ = call.arguments_.map(([from, to]) => rewrite(from, to))
      const sheets = formulaSheets(original[1] || '')
      if (original.length === 3 && original[0].trim() === '1' && /^0\s*\//.test(original[1].trim())
        && sheets.length && sheets.every(sheet => sheet.toUpperCase() === main)
        && formulaSheets(original[2]).every(sheet => sheet.toUpperCase() === main))
        arguments_[1] = `(${arguments_[1]})/${serial}`
      result += formula.slice(copied, open + 1) + arguments_.join(',') + ')'
      copied = call.close + 1; index = copied
    }
    return result + formula.slice(copied, end)
  }
  return rewrite(0, formula.length)
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
