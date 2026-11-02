import JSZip from 'jszip'
import type { Readable } from 'node:stream'

// Reuse the cleaned archive across parsing KIK/RRM and writing their results.
// A weak key lets the input and cleaned copy be collected after the request.
const prepared = new WeakMap<Buffer, Promise<Buffer>>()
export const WORKBOOK_XML_LIMIT = 64 * 1024 * 1024
export const WORKBOOK_EXPANDED_LIMIT = 128 * 1024 * 1024

/** Check ZIP expansion before ExcelJS allocates rows/cells. No archive is extracted. */
export async function loadBoundedWorkbookArchive(buffer: Buffer): Promise<JSZip> {
  if (buffer.length > 25 * 1024 * 1024 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('仅支持不超过 25MB 的有效 .xlsx 工作簿；旧版 .xls 请先另存为 .xlsx')
  const zip = await JSZip.loadAsync(buffer)
  const entries = Object.entries(zip.files)
  if (entries.length > 2048) throw new Error('工作簿 ZIP 条目过多，无法安全读取')
  let expanded = 0
  for (const [name, entry] of entries) {
    if (entry.dir) continue
    const metadata = entry as typeof entry & { unsafeOriginalName?: string; _data?: { uncompressedSize?: number } }
    if (metadata.unsafeOriginalName && metadata.unsafeOriginalName !== name) throw new Error('工作簿包含不安全的 ZIP 路径')
    const size = metadata._data?.uncompressedSize
    if (!Number.isSafeInteger(size) || size! < 0) throw new Error('工作簿 ZIP 大小信息不完整')
    expanded += size!
    if (expanded > WORKBOOK_EXPANDED_LIMIT || /\.xml$/.test(name) && size! > WORKBOOK_XML_LIMIT) throw new Error('工作簿解压内容过大，请减少无用格式或拆分后上传')
  }
  let actualTotal = 0
  for (const [name, entry] of entries) {
    if (entry.dir) continue
    await new Promise<void>((resolve, reject) => {
      let actualEntry = 0, failed = false
      const stream = entry.nodeStream('nodebuffer') as Readable
      stream.on('data', (chunk: Buffer) => {
        actualEntry += chunk.length; actualTotal += chunk.length
        if (actualTotal > WORKBOOK_EXPANDED_LIMIT || /\.xml$/.test(name) && actualEntry > WORKBOOK_XML_LIMIT) {
          failed = true; stream.destroy(); reject(new Error('工作簿实际解压内容过大'))
        }
      }).on('error', reject).on('end', () => { if (!failed) resolve() })
    })
  }
  return zip
}

export function readBoundedXml(entry: JSZip.JSZipObject): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []; let bytes = 0, settled = false
    const stream = entry.nodeStream('nodebuffer') as Readable
    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > WORKBOOK_XML_LIMIT) { settled = true; stream.destroy(); reject(new Error('工作簿 XML 实际解压内容过大')); return }
      parts.push(chunk)
    }).on('error', error => { if (!settled) { settled = true; reject(error) } })
      .on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(parts).toString('utf8')) } }).resume()
  })
}

/** Remove only empty, format-only rows after the last explicitly stored cell.
 * Some WPS/Excel exports contain a height record for all 1,048,576 rows.
 * ExcelJS otherwise allocates a Row object for every one of those records.
 * Cell-bearing rows (including formulas, styled blank cells and notes), row
 * numbers, merges, other worksheet metadata and all other ZIP entries remain.
 */
export function trimTrailingEmptyRows(xml: string): string {
  const section = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)
  if (!section) return xml
  let lastCellRow = 0
  for (const match of section[1].matchAll(/<c\b[^>]*\br=["'][A-Z]+(\d+)["']/g)) {
    lastCellRow = Math.max(lastCellRow, Number(match[1]))
  }
  const compact = section[1].replace(/<row\b([^>]*?)(?:\/>|>\s*<\/row>)/g, (row: string, attrs: string) => {
    const number = /\br=["'](\d+)["']/.exec(attrs)
    // Keep structural row properties such as hiding/outlines/page borders.
    const extra = attrs.replace(/\b(?:r|ht|customHeight)=["'][^"']*["']/g, '').trim()
    return number && Number(number[1]) > lastCellRow && !extra ? '' : row
  })
  if (compact === section[1]) return xml
  const start = section.index + section[0].indexOf('>') + 1
  return xml.slice(0, start) + compact + xml.slice(start + section[1].length)
}

export function prepareScheduleWorkbook(buffer: Buffer): Promise<Buffer> {
  let result = prepared.get(buffer)
  if (!result) {
    result = (async () => {
      const zip = await loadBoundedWorkbookArchive(buffer)
      let changed = false
      let cellCount = 0, rowCount = 0
      for (const name of ['xl/styles.xml', 'xl/sharedStrings.xml']) {
        const entry = zip.file(name)
        if (!entry) continue
        const xml = await readBoundedXml(entry)
        const limit = name.endsWith('styles.xml') ? 20000 : 150000
        if ([...xml.matchAll(name.endsWith('styles.xml') ? /<(?:xf|font|fill|border)\b/g : /<si\b/g)].length > limit) throw new Error('工作簿样式或共享文本过多，请拆分后上传')
      }
      for (const [name, entry] of Object.entries(zip.files)) {
        if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue
        const original = await readBoundedXml(entry)
        const compact = trimTrailingEmptyRows(original)
        cellCount += [...compact.matchAll(/<c\b/g)].length
        rowCount += [...compact.matchAll(/<row\b/g)].length
        if (cellCount > 150000 || rowCount > 100000) throw new Error('工作簿有效单元格或结构行过多，请拆分后上传')
        if (compact !== original) {
          zip.file(name, compact)
          changed = true
        }
      }
      return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : buffer
    })()
    prepared.set(buffer, result)
  }
  return result
}
