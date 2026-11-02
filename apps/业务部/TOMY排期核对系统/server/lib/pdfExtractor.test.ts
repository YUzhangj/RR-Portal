import { describe, it, expect } from 'vitest'
import { extractPO } from './pdfExtractor.js'

// These are actual PDF content streams decoded by pdfjs, not parser mocks or
// private business files. English fixture text uses the PDF standard font.
function pdf(pages: string[][]): Buffer {
  const objects: string[] = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const pageIds: number[] = []
  for (const lines of pages) {
    const pageId = objects.length + 1
    const streamId = pageId + 1
    pageIds.push(pageId)
    const escape = (value: string) => value.replace(/[\\()]/g, '\\$&')
    const stream = `BT /F1 10 Tf 40 790 Td\n${lines.map((line, index) =>
      `${index ? '0 -14 Td ' : ''}(${escape(line)}) Tj`).join('\n')}\nET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`)
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`)
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'ascii'))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, 'ascii')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}
function headers(po: string, type = 'PURCHASE ORDER'): string[] {
  return [type, `Purchase Order No: ${po}`, 'Customer PO No: SYN-CUSTOMER-01',
    'Handle By: Test Planner', 'Ship To Customer Name: Synthetic Ship Customer',
    'Customer Name: Synthetic Order Customer', 'Port of Discharge / Destination Country: BELGIUM']
}
function item(part: string, quantity: string, factory: string, carton: number | null, unit = 'EA', label = false): string[] {
  return [part, '00-RR', '15 May 2026', quantity, unit, factory,
    ...(carton === null ? [] : [`${carton} ${unit} / MASTER CARTON`]),
    ...(label ? ['JDHL-0PL'] : []), 'Item end']
}

describe('extractPO using public synthetic PDF fixtures', () => {
  it('decodes four SKUs and all headers without mixing order and ship customer names', async () => {
    const result = await extractPO(pdf([[...headers('10550001'),
      ...item('SYN5501A', '1,200', 'RR01', 6, 'EA', true),
      ...item('SYN5501B', '2,000', 'RR01', 12),
      ...item('SYN5501C', '300', 'RR01', 24),
      ...item('SYN5501D', '450', 'RR01', 8), 'QC Instruction: TTT / For EU shipments']]), 'synthetic-purchase-order.pdf')
    expect(result).toMatchObject({ tomyPO: '10550001', customerPO: 'SYN-CUSTOMER-01',
      handleBy: 'Test Planner', customerName: 'Synthetic Order Customer',
      shipToCustomerName: 'Synthetic Ship Customer', destCountry: 'BELGIUM', sourceFile: 'synthetic-purchase-order.pdf' })
    expect(result.items).toEqual([
      { 货号: 'SYN5501A', PO走货期: '15 May 2026', 数量: 1200, factoryCode: 'RR01', 外箱: 6, hasJDLabel: true },
      { 货号: 'SYN5501B', PO走货期: '15 May 2026', 数量: 2000, factoryCode: 'RR01', 外箱: 12, hasJDLabel: false },
      { 货号: 'SYN5501C', PO走货期: '15 May 2026', 数量: 300, factoryCode: 'RR01', 外箱: 24, hasJDLabel: false },
      { 货号: 'SYN5501D', PO走货期: '15 May 2026', 数量: 450, factoryCode: 'RR01', 外箱: 8, hasJDLabel: false },
    ])
    expect(result.qcInstructions).toContain('TTT')
    expect(result.qcInstructions).toContain('For EU shipments')
  })
  it('extracts RRI subsequent-order items and SET carton quantities', async () => {
    const result = await extractPO(pdf([[...headers('10550002', 'SUBSEQUENT ORDER'),
      ...item('SYN5502A', '1,234', 'RR02', 10, 'SET'), ...item('SYN5502B', '567', 'RR02', 20, 'SET')]]), 'synthetic-subsequent.pdf')
    expect(result.tomyPO).toBe('10550002')
    expect(result.customerPO).toBe('SYN-CUSTOMER-01')
    expect(result.items.map(row => [row.货号, row.数量, row.factoryCode, row.外箱])).toEqual([
      ['SYN5502A', 1234, 'RR02', 10], ['SYN5502B', 567, 'RR02', 20],
    ])
  })
  it('keeps RRM RR03 and PC packing distinct', async () => {
    const result = await extractPO(pdf([[...headers('10550003'), ...item('SYN5503A', '240', 'RR03', 12, 'PC')]]), 'synthetic-rrm.pdf')
    expect(result.items).toEqual([
      { 货号: 'SYN5503A', PO走货期: '15 May 2026', 数量: 240, factoryCode: 'RR03', 外箱: 12, hasJDLabel: false },
    ])
  })
  it('decodes split labels and retains a missing carton as null', async () => {
    const result = await extractPO(pdf([['SUBSEQUENT ORDER', 'Purchase Order No:', '10550004',
      'Customer PO No:', 'SYN-CUSTOMER-02', 'Handle By:', 'Another Planner',
      'Ship Customer Name:', 'Synthetic Alternate Ship', 'Customer Name:', 'Synthetic Owner',
      'Port of Discharge / Destination Country:', 'USA', ...item('SYN5504A', '75', 'RR02', null)]]), 'synthetic-split.pdf')
    expect(result).toMatchObject({ tomyPO: '10550004', customerPO: 'SYN-CUSTOMER-02',
      handleBy: 'Another Planner', shipToCustomerName: 'Synthetic Alternate Ship', customerName: 'Synthetic Owner', destCountry: 'USA' })
    expect(result.items[0].外箱).toBeNull()
  })
  it('reads all pages and retains the repeated PO header', async () => {
    const result = await extractPO(pdf([
      [...headers('10550005'), ...item('SYN5505A', '100', 'RR01', 5)],
      [...headers('10550005'), ...item('SYN5505B', '200', 'RR01', 10)],
    ]), 'synthetic-multiple-pages.pdf')
    expect(result.tomyPO).toBe('10550005')
    expect(result.items.map(row => [row.货号, row.数量, row.外箱])).toEqual([
      ['SYN5505A', 100, 5], ['SYN5505B', 200, 10],
    ])
  })
  it('rejects malformed PDF bytes', async () => {
    await expect(extractPO(Buffer.from('not a PDF'), 'synthetic-invalid.pdf')).rejects.toThrow()
  })
  it('does not invent a PO or items for an unrelated valid PDF', async () => {
    const result = await extractPO(pdf([['Unrelated synthetic document']]), 'synthetic-unrelated.pdf')
    expect(result.tomyPO).toBe('')
    expect(result.items).toEqual([])
    expect(result.sourceFile).toBe('synthetic-unrelated.pdf')
  })
})
