import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { buildCustomsWorkbook } from './customsExport'

it.each(['rri', 'rrm', 'legacy'])('装箱单顶部统一柜号封号，所有单据同表引用（%s）', async variant => {
  const input = readFileSync(new URL(`../../public/${variant === 'legacy' ? 'template-customs.xlsx' : `template-customs-${variant}.xlsx`}`, import.meta.url))
  const items = [1, 2].map(id => ({ material_id: id, qty: 1, kg: 1, price: 1, currency: 'US$', supplier: 'SYNTHETIC',
    contract_no: `CONTRACT-${id}`, invoice_no: `INVOICE-${id}`, bl_head: 'RRI' }))
  const blob = await buildCustomsWorkbook({ templateBuffer: Uint8Array.from(input).buffer,
    items, materials: new Map(items.map(item => [item.material_id, { id: item.material_id, name_zh: `Synthetic ${item.material_id}`, unit_kg: 'PCE', net_per_pc: 1 }])),
    images: new Map(), productHs: new Map(), form: { customer: variant === 'rrm' ? 'RRM' : 'RRI', containerNo: 'SYNTHETIC-CNTR', blNo: 'SYNTHETIC-SEAL' } })
  const bytes = await blob.arrayBuffer(), book = XLSX.read(bytes, { type: 'array' }), sheet = book.Sheets['装箱单']
  expect(sheet.A4.v).toBe('柜号 / Container'); expect(sheet.F4.v).toBe('封号 / Seal No.')
  expect(sheet.C4.v).toBe('SYNTHETIC-CNTR'); expect(sheet.H4.v).toBe('SYNTHETIC-SEAL')
  expect(sheet.C4.f).toBeUndefined(); expect(sheet.H4.f).toBeUndefined()
  expect(sheet.A1.v).toMatch(/Royal Regent|ROYAL REGENT/)
  expect(sheet.A6.v).toContain('PACKING LIST')
  const headers = Object.values(sheet).filter(cell => cell.f === 'IF($C$4="","",$C$4)' || cell.f === 'IF($H$4="","",$H$4)')
  expect(headers).toHaveLength(4)
  expect(sheet.D17).toMatchObject({ f: 'IF($C$4="","",$C$4)', v: 'SYNTHETIC-CNTR' })
  expect(sheet.H17).toMatchObject({ f: 'IF($H$4="","",$H$4)', v: 'SYNTHETIC-SEAL' })
  expect(Object.keys((await JSZip.loadAsync(bytes)).files).some(path => path.startsWith('xl/externalLinks/'))).toBe(false)
  expect(sheet['!merges']).toEqual(expect.arrayContaining(['A4:B4', 'C4:E4', 'F4:G4', 'H4:K4'].map(XLSX.utils.decode_range)))
  if (process.env.RR_PACKING_QA_DIR) {
    mkdirSync(process.env.RR_PACKING_QA_DIR, { recursive: true }); writeFileSync(`${process.env.RR_PACKING_QA_DIR}/${variant}.xlsx`, new Uint8Array(bytes))
  }
}, 60000)


it('续页全部引用唯一顶部柜号封号，复制装箱单后这两个字段仍保持同表引用', async () => {
  const items = Array.from({ length: 17 }, (_, i) => ({ material_id: i + 1, outbound_id: i + 1, qty: 1, kg: 1,
    price: 1, currency: 'US$', supplier: 'SYNTHETIC', contract_no: `STACK-${i}`, invoice_no: `INV-${i}`, bl_head: 'RRI' }))
  const output = await buildCustomsWorkbook({
    templateBuffer: Uint8Array.from(readFileSync(new URL('../../public/template-customs-rri.xlsx', import.meta.url))).buffer,
    items, materials: new Map(items.map(item => [item.material_id, { id: item.material_id, name_zh: `Stack ${item.material_id}`, unit_kg: 'PCE', net_per_pc: 1 }])),
    images: new Map(), productHs: new Map(), form: { customer: 'RRI', containerNo: 'STACK-CNTR', blNo: '' },
  })
  const book = XLSX.read(await output.arrayBuffer(), { type: 'array' }), sheet = book.Sheets['装箱单']
  expect(sheet.C4).toMatchObject({ v: 'STACK-CNTR' }); expect(sheet.H4.v || '').toBe('')
  expect(Object.values(sheet).filter(c => c.v === '柜号 / Container')).toHaveLength(1)
  expect(Object.values(sheet).filter(c => c.f === 'IF($C$4="","",$C$4)')).toHaveLength(17)
  expect(Object.values(sheet).filter(c => c.f === 'IF($H$4="","",$H$4)')).toHaveLength(17)
  expect(Object.values(sheet).filter(c => c.f === 'IF($H$4="","",$H$4)').every(c => c.v === '')).toBe(true)
  const detached = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(detached, sheet, '装箱单')
  const copied = XLSX.read(XLSX.write(detached, { type: 'array', bookType: 'xlsx' }), { type: 'array' }).Sheets['装箱单']
  for (const [address, cell] of Object.entries(sheet)) {
    if (!['IF($C$4="","",$C$4)', 'IF($H$4="","",$H$4)'].includes(cell.f || '')) continue
    expect(copied[address].f).toBe(cell.f)
    expect(copied[address].f).not.toMatch(/!|\[|file:|xwechat_files/)
  }
}, 60000)
