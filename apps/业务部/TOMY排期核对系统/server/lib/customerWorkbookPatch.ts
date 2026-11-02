import path from 'node:path'
import { loadBoundedWorkbookArchive, readBoundedXml } from './prepareScheduleWorkbook.js'

export interface CellAnnotation { status: string; detail: string; fields: Map<number, string> }
const fail = (): never => { throw new Error('客户排期工作簿结构不支持安全注解，原文件未修改') }
const attr = (xml: string, key: string): string | undefined => new RegExp(`\\b${key}=(?:"([^"]*)"|'([^']*)')`).exec(xml.slice(0, xml.indexOf('>') + 1))?.slice(1).find(v => v !== undefined)
const setAttr = (xml: string, key: string, value: string): string => {
  const re = new RegExp(`\\s${key}=(?:"[^"]*"|'[^']*')`)
  const split = xml.indexOf('>') + 1, head = xml.slice(0, split)
  return (re.test(head) ? head.replace(re, ` ${key}="${value}"`) : head.replace(/\s*\/?>(?=[\s\S]*$)/, tag => ` ${key}="${value}"${tag}`)) + xml.slice(split)
}
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
function colNumber(name: string): number { return [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) }
function colName(value: number): string { let out = ''; for (; value; value = Math.floor((value - 1) / 26)) out = String.fromCharCode(65 + (value - 1) % 26) + out; return out }

/** Patch only the original target worksheet and styles part. All unrelated ZIP
 * bodies, formulas, rich text, original comments/VML, links and media stay intact.
 * New diagnostics use separate inline-string columns so existing notes survive. */
export async function patchCustomerWorkbook(buffer: Buffer, sheetId: number, annotations: Map<number, CellAnnotation>): Promise<Buffer> {
  const zip = await loadBoundedWorkbookArchive(buffer)
  const read = async (name: string) => { const entry = zip.file(name); return entry ? readBoundedXml(entry) : fail() }
  const book = await read('xl/workbook.xml'), rels = await read('xl/_rels/workbook.xml.rels')
  const sheet = [...book.matchAll(/<sheet\b[^>]*\/?\s*>/g)].find(m => attr(m[0], 'sheetId') === String(sheetId))?.[0]
  const relation = [...rels.matchAll(/<Relationship\b[^>]*\/?\s*>/g)].find(m => attr(m[0], 'Id') === (sheet && attr(sheet, 'r:id')))?.[0]
  const target = relation && attr(relation, 'Target')
  if (!target || /[\\?#]|^[a-z]+:/i.test(target)) return fail()
  const sheetPath = path.posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target)
  if (!/^xl\/worksheets\/[^/]+\.xml$/.test(sheetPath)) return fail()
  let xml = await read(sheetPath), styles = await read('xl/styles.xml')
  if (/<!DOCTYPE|<!ENTITY/.test(xml) || !/<sheetData\b/.test(xml)) return fail()
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)
  const sections = xml.matchAll(/<sheetData\b/g)
  if (!data || sections.next().done || !sections.next().done) return fail()
  for (const comment of data[1].matchAll(/<!--[\s\S]*?-->/g)) if (/<(?:c|row)\b/.test(comment[0])) return fail()
  for (const comment of styles.matchAll(/<!--[\s\S]*?-->/g)) if (/<(?:xf|fill)\b/.test(comment[0])) return fail()
  let lastColumn = 0
  for (const cell of data[1].matchAll(/<c\b[^>]*\br=["']([A-Z]+)\d+["']/g)) lastColumn = Math.max(lastColumn, colNumber(cell[1]))
  if (lastColumn + 2 > 16384) throw new Error('客户排期表已占用 Excel 最后列，无法追加核对状态和说明')
  const statusCol = lastColumn + 1, detailCol = statusCol + 1
  const columnStyles = [...(xml.match(/<cols\b[^>]*>[\s\S]*?<\/cols>/)?.[0] ?? '').matchAll(/<col\b[^>]*\/>/g)]
    .map(m => ({ min: Number(attr(m[0], 'min')), max: Number(attr(m[0], 'max')), style: Number(attr(m[0], 'style') ?? 0) }))
  const fills = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(styles)
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)
  if (!fills || !xfs) return fail()
  const originalXfs = [...xfs[1].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map(m => m[0])
  const fillCount = [...fills[1].matchAll(/<fill\b/g)].length
  if (!originalXfs.length || attr(fills[0], 'count') !== undefined && Number(attr(fills[0], 'count')) !== fillCount || attr(xfs[0], 'count') !== undefined && Number(attr(xfs[0], 'count')) !== originalXfs.length) return fail()
  const colors = ['FFC6EFCE', 'FFFFC7CE', 'FFFFEB9C', 'FFD9EAF7']
  const appendedStyles: string[] = [], styleIds = new Map<string, number>()
  const styleFor = (id: number, color: string) => {
    const key = `${id}:${color}`; const cached = styleIds.get(key)
    if (cached !== undefined) return cached
    if (!Number.isInteger(id) || !originalXfs[id] || !colors.includes(color)) return fail()
    const value = originalXfs.length + appendedStyles.length
    appendedStyles.push(setAttr(setAttr(originalXfs[id], 'fillId', String(fillCount + colors.indexOf(color))), 'applyFill', '1'))
    styleIds.set(key, value); return value
  }
  const inline = (column: number, row: number, value: string, style?: number) => {
    if (value.length > 32767 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('客户排期核对说明超出 Excel 文本限制')
    return `<c r="${colName(column)}${row}"${style === undefined ? '' : ` s="${style}"`} t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`
  }
  const processed = new Set<number>()
  const patchedData = data[1].replace(/<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g, row => {
    const rowNo = Number(attr(row, 'r')), annotation = annotations.get(rowNo)
    if (rowNo !== 1 && !annotation) return row
    if (!Number.isInteger(rowNo) || row.endsWith('/>')) return fail()
    processed.add(rowNo)
    const effectiveStyle = (column: number, cell?: string) => {
      const explicit = cell && attr(cell, 's')
      if (explicit !== undefined && explicit !== '') return Number(explicit)
      if (attr(row, 'customFormat') === '1' && attr(row, 's') !== undefined) return Number(attr(row, 's'))
      return columnStyles.find(c => column >= c.min && column <= c.max)?.style ?? 0
    }
    const pending = new Map<number, string>()
    if (rowNo === 1) {
      pending.set(statusCol, inline(statusCol, 1, '核对状态', styleFor(0, 'FFD9EAF7')))
      pending.set(detailCol, inline(detailCol, 1, '核对说明', styleFor(0, 'FFD9EAF7')))
    } else {
      for (const [column, fill] of annotation!.fields) pending.set(column, `<c r="${colName(column)}${rowNo}" s="${styleFor(effectiveStyle(column), fill)}"/>`)
      pending.set(statusCol, inline(statusCol, rowNo, annotation!.status))
      pending.set(detailCol, inline(detailCol, rowNo, annotation!.detail))
    }
    let end = 0, updated = ''
    for (const match of row.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)) {
      const ref = attr(match[0], 'r'), column = ref && /^([A-Z]+)\d+$/.exec(ref)?.[1]
      if (!column) return fail()
      const number = colNumber(column)
      updated += row.slice(end, match.index)
      for (const [col, cell] of [...pending].sort(([a], [b]) => a - b)) if (col < number) { updated += cell; pending.delete(col) }
      const color = annotation?.fields.get(number)
      updated += color ? setAttr(match[0], 's', String(styleFor(effectiveStyle(number, match[0]), color))) : match[0]
      pending.delete(number); end = match.index! + match[0].length
    }
    updated += [...pending].sort(([a], [b]) => a - b).map(([, cell]) => cell).join('') + row.slice(end)
    return updated.replace(/^<row\b[^>]*>/, head => head.replace(/\s+spans=(?:"[^"]*"|'[^']*')/, ''))
  })
  xml = xml.replace(data[0], () => data[0].replace(data[1], () => patchedData))
  if (!processed.has(1) || [...annotations.keys()].some(row => !processed.has(row))) return fail()
  xml = xml.replace(/<dimension\b[^>]*\/>/, tag => {
    const ref = attr(tag, 'ref'), end = ref && /([A-Z]+)(\d+)$/.exec(ref)
    if (!end) return fail()
    return setAttr(tag, 'ref', `${ref!.includes(':') ? ref!.split(':')[0] : 'A1'}:${colName(Math.max(colNumber(end[1]), detailCol))}${end[2]}`)
  })
  const newFills = colors.map(color => `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`).join('')
  styles = styles.replace(fills[0], () => setAttr(fills[0].replace('</fills>', () => newFills + '</fills>'), 'count', String(fillCount + colors.length)))
  styles = styles.replace(xfs[0], () => setAttr(xfs[0].replace('</cellXfs>', () => appendedStyles.join('') + '</cellXfs>'), 'count', String(originalXfs.length + appendedStyles.length)))
  zip.file(sheetPath, xml); zip.file('xl/styles.xml', styles)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
