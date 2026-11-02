import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { CUSTOMER_CHECK_HEADERS, parseCustomerScheduleExcel, reconcileCustomerSchedule, writeAnnotatedCustomerSchedule } from './customerSchedule.js'
import { parseScheduleExcel } from './excelParser.js'
import type { CustomerScheduleRow, ScheduleRow } from '../types/index.js'

const customer = (extra: Partial<CustomerScheduleRow> = {}): CustomerScheduleRow => ({
  rowIndex: 2, shipToCustName: 'Customer', customerPO: 'C1', shipToCountry: 'CHINA', partNumber: 'A1', poNum: '100',
  orderQty: 600, unitCost: 2, purchaseAmount: 1200, poDueDate: null, qcResult: null, qcInspectionDate: null,
  purchasePointName: 'PT ROYAL REGENT MANUFACTURING', ...extra,
})
const source = (extra: Partial<ScheduleRow> = {}): ScheduleRow => ({
  rowIndex: 2, 接单期: null, 国家: '中国', 客名: 'Customer', 第三客户名称: null, 客跟单: null,
  tomyPO: '100', customerPO: 'C1', 货号: 'A1', 数量: 600, 外箱: null, 总箱数: null, PO走货期: null,
  验货期: null, 实际验货期: null, 实际验货通过: false, 验货状态: 'Unscheduled', 验货状态日期: null,
  日期码: null, 箱唛资料: null, 客贴纸: null, 单价USD: 2, 金额USD: 1200, ...extra,
})
async function workbook(rows: CustomerScheduleRow[] = [customer()]): Promise<Buffer> {
  const w = new ExcelJS.Workbook(), s = w.addWorksheet('Orders')
  s.addRow(CUSTOMER_CHECK_HEADERS)
  for (const r of rows) s.addRow([r.shipToCustName, r.customerPO, r.shipToCountry, r.partNumber, r.poNum, r.orderQty,
    r.unitCost, r.purchaseAmount, r.poDueDate, r.qcResult, r.qcInspectionDate, r.purchasePointName])
  return Buffer.from(await w.xlsx.writeBuffer())
}

describe('customer input and source identity safety', () => {
  it('does not claim an arbitrary duplicate or turn the next duplicate into unmatched', () => {
    const r = reconcileCustomerSchedule([customer(), customer({ rowIndex: 3 })], { rrm: [source(), source({ rowIndex: 3 })] })
    expect(r.ambiguousRows).toHaveLength(2); expect(r.matched).toHaveLength(0); expect(r.unmatchedRows).toHaveLength(0)
  })
  it('still disambiguates a genuinely unique exact quantity', () => {
    const r = reconcileCustomerSchedule([customer()], { rrm: [source(), source({ rowIndex: 3, 数量: 300 })] })
    expect(r.matched).toHaveLength(1); expect(r.ambiguousRows).toHaveLength(0)
  })
  it('keeps factory identity and the two PO/part key members separate', () => {
    const r = reconcileCustomerSchedule([customer()], { dg: [source()] })
    expect(r.matched).toHaveLength(0); expect(r.unmatchedRows).toHaveLength(1)
    const collision = reconcileCustomerSchedule([customer({ poNum: '1:2', partNumber: '3' })], { rrm: [source({ tomyPO: '1', 货号: '2:3' })] })
    expect(collision.matched).toHaveLength(0); expect(collision.unmatchedRows).toHaveLength(1)
  })
  it('reports a missing source quantity rather than marking that check green', () => {
    expect(reconcileCustomerSchedule([customer()], { rrm: [source({ 数量: null })] }).matched[0].mismatches.map(x => x.field)).toContain('Order Qty')
  })
  it('reports a missing expected due date when the customer has a date', () => {
    expect(reconcileCustomerSchedule([customer({ poDueDate: new Date(2026, 0, 1) })], { rrm: [source()] }).matched[0].mismatches.map(x => x.field)).toContain('PO Due Date')
  })
  it('retains data rows with incomplete PO/part keys and explicitly reports them', async () => {
    const parsed = await parseCustomerScheduleExcel(await workbook([customer(), customer({ rowIndex: 3, partNumber: null })]))
    expect(parsed).toHaveLength(2)
    const r = reconcileCustomerSchedule(parsed, { rrm: [source()] })
    expect(r.unmatchedRows).toHaveLength(1); expect(r.errors.join(' ')).toContain('3')
  })
  it('rejects a header-only customer workbook instead of claiming successful zero checks', async () => {
    await expect(parseCustomerScheduleExcel(await workbook([]))).rejects.toThrow(/数据/)
  })
  it('keeps zero values distinct from missing factory quantity and prices', async () => {
    const w = new ExcelJS.Workbook(), s = w.addWorksheet('总排期')
    s.addRow(['Tomy PO', '货号', '数量', '单价USD', '金额USD']); s.addRow(['100', 'A1', 0, '', 0])
    const [r] = await parseScheduleExcel(Buffer.from(await w.xlsx.writeBuffer()))
    expect(r.数量).toBe(0); expect(r.单价USD).toBeNull(); expect(r.金额USD).toBe(0)
  })
  it('respects 1904 date system for numeric customer dates', async () => {
    const w = new ExcelJS.Workbook(); await w.xlsx.load(await workbook() as any); w.properties.date1904 = true
    w.worksheets[0].getCell('I2').value = 44560
    const [r] = await parseCustomerScheduleExcel(Buffer.from(await w.xlsx.writeBuffer()))
    const expected = new Date(Date.UTC(1904, 0, 1) + 44560 * 86400000)
    expect(r.poDueDate?.getFullYear()).toBe(expected.getUTCFullYear()); expect(r.poDueDate?.getMonth()).toBe(expected.getUTCMonth()); expect(r.poDueDate?.getDate()).toBe(expected.getUTCDate())
  })
  it('rejects invalid customer amounts and dates instead of treating them as blank', async () => {
    for (const [column, value] of [['F2', 'not-a-number'], ['I2', 'not-a-date']] as const) {
      const w = new ExcelJS.Workbook(); await w.xlsx.load(await workbook() as any); w.worksheets[0].getCell(column).value = value
      await expect(parseCustomerScheduleExcel(Buffer.from(await w.xlsx.writeBuffer()))).rejects.toThrow(/第 2 行.*格式无效/)
    }
  })
  it('reads rich-text headers but rejects duplicate headers and multiple candidate sheets', async () => {
    const w = new ExcelJS.Workbook(); await w.xlsx.load(await workbook() as any)
    w.worksheets[0].getCell('A1').value = { richText: [{ text: 'Ship To ' }, { text: 'Cust Name' }] }
    expect(await parseCustomerScheduleExcel(Buffer.from(await w.xlsx.writeBuffer()))).toHaveLength(1)
    w.worksheets[0].getCell('M1').value = 'PO Num'
    await expect(parseCustomerScheduleExcel(Buffer.from(await w.xlsx.writeBuffer()))).rejects.toThrow(/重复/)
    w.worksheets[0].getCell('M1').value = null
    w.addWorksheet('Second').addRow(CUSTOMER_CHECK_HEADERS)
    await expect(parseCustomerScheduleExcel(Buffer.from(await w.xlsx.writeBuffer()))).rejects.toThrow(/多个/)
  })
})

describe('actual inspection color and preservation', () => {
  async function inspection(color: Partial<ExcelJS.Color>, themeRed = false, paletteRed = false) {
    const w = new ExcelJS.Workbook(), s = w.addWorksheet('总排期')
    s.addRow(['Tomy PO', '货号', '验货期', '实际验货期']); s.addRow(['100', 'A1', new Date(2026, 0, 1), new Date(2026, 0, 2)])
    s.getCell('D2').font = { color }
    let buffer = Buffer.from(await w.xlsx.writeBuffer())
    if (themeRed || paletteRed) {
      const z = await JSZip.loadAsync(buffer), p = 'xl/theme/theme1.xml'
      if (themeRed) z.file(p, (await z.file(p)!.async('string')).replace(/(<a:accent1>)[\s\S]*?(<\/a:accent1>)/, '$1<a:srgbClr val="FF0000"/>$2'))
      if (paletteRed) z.file('xl/styles.xml', (await z.file('xl/styles.xml')!.async('string')).replace('</styleSheet>', '<colors><indexedColors>' + Array.from({ length: 6 }, () => '<rgbColor rgb="FFFF0000"/>').join('') + '</indexedColors></colors></styleSheet>'))
      buffer = await z.generateAsync({ type: 'nodebuffer' })
    }
    return (await parseScheduleExcel(buffer))[0]
  }
  it('recognizes actual Excel indexed blue 4 and rejects indexed yellow 5', async () => {
    expect((await inspection({ indexed: 4 } as any)).验货状态).toBe('Pass')
    expect((await inspection({ indexed: 5 } as any)).验货状态).toBe('Pending')
  })
  it('resolves the actual custom theme instead of assuming accent 1 is blue', async () => {
    expect((await inspection({ theme: 4 }, true)).验货状态).toBe('Pending')
  })
  it('does not mark a custom red indexed palette or a white tint as passed', async () => {
    expect((await inspection({ indexed: 4 } as any, false, true)).验货状态).toBe('Pending')
    expect((await inspection({ theme: 4, tint: 1 })).验货状态).toBe('Pending')
  })
  it('parses only whole Hold dates and never reinterprets the tail of a two-digit-year date', async () => {
    const w = new ExcelJS.Workbook(), s = w.addWorksheet('总排期')
    s.addRow(['Tomy PO', '货号', '验货期', '实际验货期'])
    for (const [i, value] of ['9/8/26 Hold', '2026/9/8 Hold', '9/8/2026 Hold', '11/2 Hold', '1-2-9/8 Hold'].entries()) s.addRow([String(i + 1), 'A1', new Date(2026, 10, 1), value])
    const rows = await parseScheduleExcel(Buffer.from(await w.xlsx.writeBuffer()))
    expect(rows[0].验货状态日期).toBeNull(); expect(rows[4].验货状态日期).toBeNull()
    expect(rows[1].验货状态日期).toEqual(new Date(2026, 8, 8)); expect(rows[2].验货状态日期).toEqual(new Date(2026, 8, 8)); expect(rows[3].验货状态日期).toEqual(new Date(2026, 10, 2))
  })
  it('preserves unknown archive parts, original comments, formulas and other sheets', async () => {
    const w = new ExcelJS.Workbook(); await w.xlsx.load(await workbook() as any)
    w.worksheets[0].getCell('F2').note = 'ORIGINAL-NOTE-KEEP'
    const other = w.addWorksheet('Keep'); other.mergeCells('A1:B1'); other.getCell('A1').value = { formula: '1+1', result: 2 }
    other.getCell('C2').value = { text: 'Original link', hyperlink: 'https://example.invalid/keep' }
    const image = w.addImage({ extension: 'png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S5QAAAAASUVORK5CYII=' })
    other.addImage(image, 'D3:E4')
    const z = await JSZip.loadAsync(await w.xlsx.writeBuffer()); z.file('customXml/item1.xml', '<keep>ORIGINAL-OPAQUE-DATA</keep>')
    z.file('xl/worksheets/sheet1.xml', (await z.file('xl/worksheets/sheet1.xml')!.async('string')).replace('<sheetData>', '<!-- ORIGINAL SAFE XML COMMENT --><sheetData>'))
    const input = await z.generateAsync({ type: 'nodebuffer' })
    const result = reconcileCustomerSchedule([customer()], { rrm: [source({ 数量: 599 })] })
    const out = await writeAnnotatedCustomerSchedule(input, result), archive = await JSZip.loadAsync(out)
    expect(await archive.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<!-- ORIGINAL SAFE XML COMMENT -->')
    expect(Object.keys(archive.files).sort()).toEqual(Object.keys(z.files).sort())
    for (const [name, entry] of Object.entries(z.files)) if (!entry.dir && !['xl/worksheets/sheet1.xml', 'xl/styles.xml'].includes(name)) {
      expect(await archive.file(name)!.async('nodebuffer'), name).toEqual(await entry.async('nodebuffer'))
    }
    expect(await archive.file('customXml/item1.xml')?.async('string')).toBe('<keep>ORIGINAL-OPAQUE-DATA</keep>')
    const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(out as any)
    expect(loaded.worksheets[0].getCell('F2').note).toBe('ORIGINAL-NOTE-KEEP')
    expect(loaded.getWorksheet('Keep')!.getCell('A1').value).toEqual({ formula: '1+1', result: 2 })
    expect(loaded.getWorksheet('Keep')!.getCell('B1').isMerged).toBe(true)
    expect(loaded.getWorksheet('Keep')!.getCell('C2').value).toEqual({ text: 'Original link', hyperlink: 'https://example.invalid/keep' })
    expect(loaded.getWorksheet('Keep')!.getImages()).toHaveLength(1)
  })
  it('only changes checked cell fill while preserving values, rich text and style attributes', async () => {
    const w = new ExcelJS.Workbook(); await w.xlsx.load(await workbook() as any)
    const s = w.worksheets[0]
    s.getCell('F2').value = { formula: '300*2', result: 600 }
    s.getCell('F2').style = { numFmt: '#,##0.00', font: { bold: true, name: 'Arial' }, alignment: { horizontal: 'right' }, border: { bottom: { style: 'thin' } } }
    s.getCell('M2').value = { richText: [{ text: '$& s="7" spans="9" <&> ' }] }
    const input = Buffer.from(await w.xlsx.writeBuffer()), output = await writeAnnotatedCustomerSchedule(input, reconcileCustomerSchedule([customer()], { rrm: [source()] }))
    const result = new ExcelJS.Workbook(); await result.xlsx.load(output as any)
    expect(result.worksheets[0].getCell('F2').value).toEqual(s.getCell('F2').value)
    for (const field of ['numFmt', 'font', 'alignment', 'border'] as const) expect(result.worksheets[0].getCell('F2').style[field]).toEqual(s.getCell('F2').style[field])
    expect(result.worksheets[0].getCell('M2').value).toEqual(s.getCell('M2').value)
    expect(result.worksheets[0].getCell('N1').value).toBe('核对状态'); expect(result.worksheets[0].getCell('O1').value).toBe('核对说明')
  })
  it('marks ambiguous rows yellow without showing any arbitrary source comparison', async () => {
    const input = await workbook(), result = reconcileCustomerSchedule([customer()], { rrm: [source(), source({ rowIndex: 3 })] })
    const w = new ExcelJS.Workbook(); await w.xlsx.load(await writeAnnotatedCustomerSchedule(input, result) as any)
    expect(w.worksheets[0].getCell('M2').value).toBe('多条匹配，待确认')
    expect((w.worksheets[0].getCell('F2').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFEB9C')
  })
  it('refuses column overflow without returning a corrupt XLSX', async () => {
    const w = new ExcelJS.Workbook(); await w.xlsx.load(await workbook() as any); w.worksheets[0].getCell('XFD2').value = 'KEEP'
    const input = Buffer.from(await w.xlsx.writeBuffer())
    await expect(writeAnnotatedCustomerSchedule(input, reconcileCustomerSchedule([customer()], { rrm: [source()] }))).rejects.toThrow(/最后列/)
    expect(w.worksheets[0].getCell('XFD2').value).toBe('KEEP')
  })
})
