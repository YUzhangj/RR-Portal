import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { prepareScheduleWorkbook, trimTrailingEmptyRows, loadBoundedWorkbookArchive, WORKBOOK_XML_LIMIT } from './prepareScheduleWorkbook.js'
import { parseScheduleExcel } from './excelParser.js'
import { writeAnnotatedSchedule } from './excelWriter.js'

describe('sparse schedule workbook preparation', () => {
  it('rejects legacy XLS and oversized declared ZIP XML before expansion', async () => {
    await expect(loadBoundedWorkbookArchive(Buffer.from('legacy BIFF data'))).rejects.toThrow(/\.xlsx/)
    const zip = new JSZip(); zip.file('xl/worksheets/sheet1.xml', '<worksheet/>')
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    for (let i = 0; i < buffer.length - 4; i++) if (buffer.readUInt32LE(i) === 0x02014b50 && buffer.readUInt32LE(i + 24) > 0) {
      buffer.writeUInt32LE(WORKBOOK_XML_LIMIT + 1, i + 24)
    }
    await expect(loadBoundedWorkbookArchive(buffer)).rejects.toThrow(/解压内容过大/)
  })

  it('rejects unsafe archive paths and excessive actual structural rows', async () => {
    const zip = new JSZip(); zip.file('../outside.xml', '<keep/>')
    await expect(loadBoundedWorkbookArchive(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/不安全/)
    const book = new ExcelJS.Workbook(); book.addWorksheet('总排期').addRow(['Tomy PO', '货号'])
    const archive = await JSZip.loadAsync(await book.xlsx.writeBuffer()), name = 'xl/worksheets/sheet1.xml'
    archive.file(name, (await archive.file(name)!.async('string')).replace('</sheetData>', '<row r="2" hidden="1"/>'.repeat(100001) + '</sheetData>'))
    await expect(prepareScheduleWorkbook(await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))).rejects.toThrow(/结构行过多/)
  })

  it('keeps cells, formulas, styled blanks, interior heights and structural rows unchanged', () => {
    const xml = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row>' +
      '<row r="2" ht="25"/><row r="3"><c r="A3"><f>A1+1</f><v>2</v></c><c r="B3" s="2"/></row>' +
      '<row r="4" ht="14.25"/><row r="5"></row><row r="6" hidden="1"/>' +
      '<row r="7" outlineLevel="1"/><row r="8" s="2"/></sheetData><mergeCells><mergeCell ref="C1:D2"/></mergeCells></worksheet>'
    const result = trimTrailingEmptyRows(xml)
    expect(result).toBe(xml.replace('<row r="4" ht="14.25"/>', '').replace('<row r="5"></row>', ''))
  })

  it('returns unmodified workbooks directly and reuses one preparation per input buffer', async () => {
    const book = new ExcelJS.Workbook()
    book.addWorksheet('总排期').addRow(['Tomy PO', '货号'])
    const buffer = Buffer.from(await book.xlsx.writeBuffer())
    const first = prepareScheduleWorkbook(buffer)
    expect(prepareScheduleWorkbook(buffer)).toBe(first)
    expect(await first).toBe(buffer)
  })

  it('parses and annotates a million-row height export without expanding its empty tail', async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('总排期')
    sheet.addRow(['Tomy PO', '货号', '数量', 'PO走货期'])
    sheet.addRow(['10123456', '47280A', 100, new Date('2026-10-20')])
    sheet.getCell('C2').value = { formula: '50*2', result: 100 }
    sheet.getCell('A2').note = '保留原始备注'
    sheet.getCell('A2').font = { bold: true }
    const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer())
    const name = 'xl/worksheets/sheet1.xml'
    const xml = await zip.file(name)!.async('string')
    // Same structure as the real exported workbook: tiny compressed XLSX,
    // but one height-only row record for every row in the Excel sheet.
    const blocks: string[] = []
    for (let start = 3; start <= 1048576; start += 4096) {
      let block = ''
      for (let row = start; row < Math.min(start + 4096, 1048577); row++) block += `<row r="${row}" ht="14.25"/>`
      blocks.push(block)
    }
    zip.file(name, xml.replace('</sheetData>', blocks.join('') + '</sheetData>'))
    const input = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const cleaned = await prepareScheduleWorkbook(input)
    const cleanedZip = await JSZip.loadAsync(cleaned)
    expect((await cleanedZip.file(name)!.async('string')).match(/<row\b/g)).toHaveLength(2)
    const rows = await parseScheduleExcel(input)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rowIndex: 2, tomyPO: '10123456', 数量: 100 })
    expect(rows[0].PO走货期).toBeInstanceOf(Date)
    const output = await writeAnnotatedSchedule(input, { matched: [], unmatchedPOItems: [], ambiguousPOItems: [], errors: [] }, rows)
    const restored = new ExcelJS.Workbook()
    await restored.xlsx.load(output as unknown as Parameters<typeof restored.xlsx.load>[0])
    expect(restored.getWorksheet('总排期')!.getCell('C2').value).toEqual({ formula: '50*2', result: 100 })
    expect(restored.getWorksheet('总排期')!.getCell('A2').font.bold).toBe(true)
    expect(restored.getWorksheet('总排期')!.getCell('A2').note).toContain('保留原始备注')
  }, 60000)
})
