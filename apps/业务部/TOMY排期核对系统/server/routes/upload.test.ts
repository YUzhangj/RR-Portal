import express from 'express'
import { request as httpRequest, type Server } from 'http'
import { Readable } from 'stream'
import { MAX_PROCESS_UPLOAD_BYTES } from '../lib/uploadAdmission.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import type { ProcessResponse } from '../types/index.js'
import { CUSTOMER_CHECK_HEADERS } from '../lib/customerSchedule.js'

const parserControl = vi.hoisted(() => ({ release: undefined as undefined | (() => void) }))
const storeControl = vi.hoisted(() => ({ published: 0 }))
vi.mock('../lib/outputStore.js', async original => {
  const actual = await original<typeof import('../lib/outputStore.js')>()
  return { ...actual, createOutputStore: () => {
    const store = actual.createOutputStore()
    return { ...store, publish: (outputs: Parameters<typeof store.publish>[0]) => { storeControl.published++; return store.publish(outputs) } }
  } }
})

// Synthetic PO bytes only. No user PDF/XLSX fixtures or external parser service.
vi.mock('../lib/pdfExtractor.js', () => ({
  extractPO: vi.fn(async (buffer: Buffer, filename: string) => {
    const value = JSON.parse(buffer.toString())
    if (value.invalid) throw new Error('Synthetic PDF parse failed')
    if (value.block) await new Promise<void>(resolve => { parserControl.release = resolve })
    return { ...value, sourceFile: filename }
  }),
}))

import { uploadRouter } from './upload.js'
let server: Server
let baseUrl: string
beforeAll(async () => {
  const app = express()
  app.use('/tomy-paiqi/api', uploadRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/tomy-paiqi/api`
      resolve()
    })
  })
})
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })

function fakePO(factoryCode = 'RR01', po = '10550001', sku = 'SKU1055') {
  return Buffer.from(JSON.stringify({ tomyPO: po, customerPO: 'CP1055', handleBy: 'Synthetic', customerName: 'Synthetic customer', shipToCustomerName: 'Synthetic customer', qcInstructions: '', destCountry: 'AUSTRALIA',
    items: [{ 货号: sku, PO走货期: '09 Sep 2026', 数量: 600, factoryCode, 外箱: 12, hasJDLabel: false }] }))
}
async function factory(indonesia = false, duplicate = false) {
  const workbook = new ExcelJS.Workbook()
  for (const [name, po, sku] of indonesia ? [['KIK总排期', '10550002', 'SKU1055ID'], ['RRM总排期', '10550003', 'SKU1055RRM']] : [['总排期', '10550001', 'SKU1055']]) {
    const sheet = workbook.addWorksheet(name)
    sheet.addRow(['国家', '客名', 'Tomy PO', 'Cust. PO NO.', '货号', '数量', '外箱', 'PO走货期', '单价USD', '金额USD', '验货期', '实际验货期'])
    sheet.addRow(['澳大利亚', 'TOMY AUSTRALIA PTY, LTD.', po, 'CP1055', sku, 600, 12, new Date(2026, 8, 9), 4.419, 2651.4, new Date(2026, 8, 7), new Date(2026, 8, 8)])
    sheet.getCell('L2').font = { color: { argb: 'FF0000FF' } }
    if (duplicate) sheet.addRow(sheet.getRow(2).values)
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
async function customer() {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Open Order')
  sheet.addRow([...CUSTOMER_CHECK_HEADERS, '原始备注'])
  const values: Record<string, unknown> = {
    'Ship To Cust Name': 'TOMY AUSTRALIA PTY, LTD.', 'Customer PO #': 'CP1055', 'Ship To Country': 'AUSTRALIA',
    'Part Number': 'SKU1055', 'PO Num': '10550001', 'Order Qty': 600, 'Unit Cost': 4.419,
    'Purchase Amount': 2651.4, 'PO Due Date': new Date(2026, 8, 9), 'QC Result': 'Pass',
    'QC Inspection Date': new Date(2026, 8, 8), 'Purchase Point Name': 'DONGGUAN HANSON PLASTIC PRODUCT LTD',
  }
  sheet.addRow([...CUSTOMER_CHECK_HEADERS.map(header => values[header]), { formula: 'SUM(1,2)', result: 3 }])
  sheet.getCell('M2').note = '原有备注保留'
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
function add(form: FormData, name: string, bytes: Buffer, filename: string) {
  form.append(name, new Blob([new Uint8Array(bytes)]), filename)
}
async function post(form: FormData) {
  const response = await fetch(baseUrl + '/process', { method: 'POST', body: form })
  expect(response.status).toBe(200)
  return await response.json() as ProcessResponse
}
async function download(token: string | undefined, type: string) {
  expect(token).toMatch(/^[a-f0-9-]{36}$/)
  const response = await fetch(baseUrl + '/download/' + token)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain(type)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  return Buffer.from(await response.arrayBuffer())
}

describe('isolated upload/download route under /tomy-paiqi', () => {
  it('retains empty and PO-only parse responses without listening on the normal port', async () => {
    expect((await post(new FormData())).files).toEqual([])
    const form = new FormData(); add(form, 'pos', fakePO(), '合成PO.pdf')
    const result = await post(form)
    expect(result.files[0]).toMatchObject({ filename: '合成PO.pdf', status: 'done', data: { tomyPO: '10550001' } })
    expect(result.sessionId).toBeUndefined()
  })

  it('preserves old PO factory separation, original PDF bytes, and repeat ZIP downloads', async () => {
    const form = new FormData()
    const originals = [fakePO(), fakePO('RR02', '10550002', 'SKU1055ID'), fakePO('RR03', '10550003', 'SKU1055RRM')]
    originals.forEach((buffer, i) => add(form, 'pos', buffer, `PO${i}.pdf`))
    add(form, 'scheduleDg', await factory(), '东莞.xlsx'); add(form, 'scheduleId', await factory(true), '印尼.xlsx')
    const result = await post(form)
    expect(result.reconciliationDg?.errors).toEqual([])
    expect(result.reconciliationDg?.matchedCount).toBe(1)
    expect(result.reconciliationId?.matchedCount).toBe(1)
    expect(result.reconciliationRrm?.matchedCount).toBe(1)
    const first = await download(result.sessionId, 'application/zip')
    expect(await download(result.sessionId, 'application/zip')).toEqual(first)
    const zip = await JSZip.loadAsync(first)
    for (const [i, folder] of ['DG', 'ID', 'RRM'].entries()) expect(await zip.file(`${folder}/PO/PO${i}.pdf`)!.async('nodebuffer')).toEqual(originals[i])
  })

  it('returns retryable direct customer XLSX and ZIP while preserving original cells/formulas/notes', async () => {
    const form = new FormData(); const original = await customer()
    add(form, 'scheduleDg', await factory(), 'dongguan.xlsx'); add(form, 'scheduleCustomer', original, '微信下载.dat')
    const result = await post(form)
    expect(result.scheduleCustomer).toMatchObject({ filename: '微信下载.dat', status: 'done', rowCount: 1 })
    expect(result.reconciliationCustomer?.matchedCount).toBe(1)
    expect(result.reconciliationCustomer?.mismatchedFieldCount).toBe(0)
    const direct = await download(result.customerSessionId, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(await download(result.customerSessionId, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toEqual(direct)
    const before = new ExcelJS.Workbook(); await before.xlsx.load(original as never)
    const after = new ExcelJS.Workbook(); await after.xlsx.load(direct as never)
    for (let column = 1; column <= 13; column++) {
      expect(after.worksheets[0].getRow(1).getCell(column).value).toEqual(before.worksheets[0].getRow(1).getCell(column).value)
      expect(after.worksheets[0].getRow(2).getCell(column).value).toEqual(before.worksheets[0].getRow(2).getCell(column).value)
    }
    expect(after.worksheets[0].getCell('M2').note).toEqual(before.worksheets[0].getCell('M2').note)
    const zip = await JSZip.loadAsync(await download(result.sessionId, 'application/zip'))
    expect(await zip.file('客户排期/客户排期核对结果.xlsx')!.async('nodebuffer')).toEqual(direct)
  })

  it('does not announce success or publish any token when customer parsing fails without POs', async () => {
    const form = new FormData(); add(form, 'scheduleDg', await factory(), 'factory.xlsx'); add(form, 'scheduleCustomer', Buffer.from('not Excel'), 'bad.dat')
    const result = await post(form)
    expect(result.scheduleCustomer?.status).toBe('error')
    expect(result.outputReady).toBe(false)
    expect(result.sessionId).toBeUndefined(); expect(result.customerSessionId).toBeUndefined()
    expect(result.reconciliationDg).toBeUndefined()
  })

  it('rejects an empty/non-PO parse instead of producing a successful empty ZIP', async () => {
    const form = new FormData()
    add(form, 'pos', Buffer.from(JSON.stringify({ tomyPO: '', items: [] })), 'not-PO.pdf')
    add(form, 'scheduleDg', await factory(), 'factory.xlsx')
    const result = await post(form)
    expect(result.files[0].status).toBe('error')
    expect(result.files[0].error).toContain('有效 TOMY PO')
    expect(result.outputReady).toBe(false)
    expect(result.sessionId).toBeUndefined()
  })

  it('requires a readable factory for customer checking while preserving per-file parse errors', async () => {
    for (const badFactory of [false, true]) {
      const form = new FormData(); add(form, 'scheduleCustomer', await customer(), 'customer.xlsx')
      if (badFactory) add(form, 'scheduleDg', Buffer.from('bad factory'), 'factory.xlsx')
      const result = await post(form)
      expect(result.outputReady).toBe(false)
      expect(result.reconciliationCustomer?.errors.join(' ')).toContain('工厂排期表')
      expect(result.sessionId).toBeUndefined(); expect(result.customerSessionId).toBeUndefined()
      if (badFactory) expect(result.scheduleDg?.status).toBe('error')
    }
  })

  it('keeps same-named original PO files without archive traversal or overwrite', async () => {
    const first = fakePO(); const second = Buffer.from(fakePO().toString().replace('Synthetic', 'Synthetic second original'))
    const form = new FormData(); add(form, 'pos', first, 'same.pdf'); add(form, 'pos', second, 'same.pdf')
    form.append('poNames', JSON.stringify(['../../same.pdf', '..\\same.pdf']))
    add(form, 'scheduleDg', await factory(), 'factory.xlsx')
    const result = await post(form)
    const zip = await JSZip.loadAsync(await download(result.sessionId, 'application/zip'))
    expect(await zip.file('DG/PO/same.pdf')!.async('nodebuffer')).toEqual(first)
    expect(await zip.file('DG/PO/same (2).pdf')!.async('nodebuffer')).toEqual(second)
    expect(Object.keys(zip.files).some(name => name.includes('..'))).toBe(false)
  })

  it('rejects another request while parsing, and keeps the slot through client cancellation until finally', async () => {
    const form = new FormData()
    const pending = JSON.parse(fakePO().toString()); pending.block = true
    add(form, 'pos', Buffer.from(JSON.stringify(pending)), 'pending.pdf')
    add(form, 'scheduleDg', await factory(), 'factory.xlsx')
    const abort = new AbortController()
    parserControl.release = undefined
    const published = storeControl.published
    const first = fetch(baseUrl + '/process', { method: 'POST', body: form, signal: abort.signal }).catch(() => null)
    await vi.waitFor(() => expect(parserControl.release).toBeTypeOf('function'))
    const second = await fetch(baseUrl + '/process', { method: 'POST', body: new FormData() })
    expect(second.status).toBe(429); expect((await second.json()).error).toContain('正在处理')
    abort.abort(); await first
    const stillBusy = await fetch(baseUrl + '/process', { method: 'POST', body: new FormData() })
    expect(stillBusy.status).toBe(429)
    parserControl.release!()
    await vi.waitFor(async () => {
      const next = await fetch(baseUrl + '/process', { method: 'POST', body: new FormData() })
      expect(next.status).toBe(200)
    })
    expect(storeControl.published).toBe(published)
  })

  it('flushes actual JSON 413 responses for declared and chunked aggregate overflow, then admits the next request', async () => {
    async function oversized(chunked: boolean) {
      return await new Promise<{ status: number; body: string }>((resolve, reject) => {
        let responded = false
        const boundary = 'synthetic-1055-boundary'
        const request = httpRequest(baseUrl + '/process', { method: 'POST', headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(MAX_PROCESS_UPLOAD_BYTES + 1) }),
        } }, response => {
          responded = true; const parts: Buffer[] = []
          response.on('data', part => parts.push(part))
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts).toString() }))
          response.on('error', reject)
        })
        request.on('error', error => { if (!responded) reject(error) })
        if (!chunked) { request.end('x'); return }
        const file = Buffer.alloc(20 * 1024 * 1024, 65)
        function* chunks() {
          for (let i = 0; i < 3; i++) {
            yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pos"; filename="large${i}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`)
            yield file
            yield Buffer.from('\r\n')
          }
          yield Buffer.from(`--${boundary}--\r\n`)
        }
        const stream = Readable.from(chunks()); stream.on('error', reject); stream.pipe(request)
        request.on('close', () => stream.destroy())
      })
    }
    for (const chunked of [false, true]) {
      const response = await oversized(chunked).catch(error => { throw new Error(`${chunked ? 'chunked' : 'declared'}: ${error.message}`) })
      expect(response.status).toBe(413)
      expect(JSON.parse(response.body).error).toContain('50 MB')
      expect((await post(new FormData())).files).toEqual([])
    }
  }, 15000)

  it('returns an explicit JSON error for unknown file fields and a missing/expired token', async () => {
    const form = new FormData(); add(form, 'wrongField', Buffer.from('synthetic'), 'file.xlsx')
    const response = await fetch(baseUrl + '/process', { method: 'POST', body: form })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('字段或数量')
    const missing = await fetch(baseUrl + '/download/00000000-0000-0000-0000-000000000000')
    expect(missing.status).toBe(404)
  })
})
