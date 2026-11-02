import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import {
  CUSTOMER_CHECK_HEADERS,
  parseCustomerScheduleExcel,
  reconcileCustomerSchedule,
  writeAnnotatedCustomerSchedule,
} from './customerSchedule.js'
import type { ScheduleRow } from '../types/index.js'

function makeScheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    rowIndex: 2, 接单期: null, 国家: '澳大利亚',
    客名: 'TOMY AUSTRALIA PTY, LTD.', 第三客户名称: '不同的第三客户名称', 客跟单: null,
    tomyPO: '10123190', customerPO: '20218996', 货号: '47023A1', 数量: 600,
    外箱: null, 总箱数: null, PO走货期: new Date(2026, 8, 9),
    验货期: new Date(2026, 8, 7), 实际验货期: new Date(2026, 8, 8), 实际验货通过: true,
    验货状态: 'Pass', 验货状态日期: new Date(2026, 8, 8),
    日期码: null, 箱唛资料: null, 客贴纸: null,
    单价USD: 4.419, 金额USD: 2651.4, ...overrides,
  }
}

async function makeCustomerWorkbook(overrides: Record<string, unknown> = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Open Order')
  sheet.addRow(CUSTOMER_CHECK_HEADERS)
  const values: Record<string, unknown> = {
    'Ship To Cust Name': 'TOMY AUSTRALIA PTY, LTD.', 'Customer PO #': '20218996',
    'Ship To Country': 'AUSTRALIA', 'Part Number': '47023A1', 'PO Num': '10123190',
    'Order Qty': 600, 'Unit Cost': 4.419, 'Purchase Amount': 2651.4,
    'PO Due Date': new Date(2026, 8, 9), 'QC Result': 'Pass',
    'QC Inspection Date': new Date(2026, 8, 8),
    'Purchase Point Name': 'PT ROYAL REGENT MANUFACTURING', ...overrides,
  }
  sheet.addRow(CUSTOMER_CHECK_HEADERS.map((header) => values[header]))
  for (let column = 1; column <= CUSTOMER_CHECK_HEADERS.length; column++) {
    sheet.getRow(1).getCell(column).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' },
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

describe('customer schedule reconciliation', () => {
  it('parses all red-header check fields', async () => {
    const rows = await parseCustomerScheduleExcel(await makeCustomerWorkbook())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      poNum: '10123190', partNumber: '47023A1', orderQty: 600,
      unitCost: 4.419, purchaseAmount: 2651.4, qcResult: 'Pass',
      purchasePointName: 'PT ROYAL REGENT MANUFACTURING',
    })
  })

  it('matches customer PO Num + Part Number to the RRM schedule', async () => {
    const rows = await parseCustomerScheduleExcel(await makeCustomerWorkbook())
    const result = reconcileCustomerSchedule(rows, { rrm: [makeScheduleRow()] })
    expect(result.matched).toHaveLength(1)
    expect(result.unmatchedRows).toHaveLength(0)
    expect(result.matched[0].sourceSchedule).toBe('印尼RRM排期')
    expect(result.matched[0].mismatches).toEqual([])
  })

  it('flags QC result and date when a blue actual inspection date has passed', async () => {
    const rows = await parseCustomerScheduleExcel(await makeCustomerWorkbook({
      'QC Result': 'Pending', 'QC Inspection Date': new Date(2026, 8, 10),
    }))
    const result = reconcileCustomerSchedule(rows, { rrm: [makeScheduleRow()] })
    expect(result.matched[0].mismatches.map((m) => m.field)).toEqual([
      'QC Result', 'QC Inspection Date',
    ])
  })

  it('uses 验货期 as the expected date when inspection is only booked', async () => {
    const rows = await parseCustomerScheduleExcel(await makeCustomerWorkbook({
      'QC Result': 'Pending', 'QC Inspection Date': new Date(2026, 8, 7),
    }))
    const result = reconcileCustomerSchedule(rows, {
      rrm: [makeScheduleRow({
        实际验货期: null, 实际验货通过: false,
        验货状态: 'Pending', 验货状态日期: new Date(2026, 8, 7),
      })],
    })
    expect(result.matched[0].mismatches).toEqual([])
  })

  it('expects blank QC date when inspection has not been booked', async () => {
    const rows = await parseCustomerScheduleExcel(await makeCustomerWorkbook({
      'QC Result': null, 'QC Inspection Date': null,
    }))
    const result = reconcileCustomerSchedule(rows, {
      rrm: [makeScheduleRow({
        验货期: null, 实际验货期: null, 实际验货通过: false,
        验货状态: 'Unscheduled', 验货状态日期: null,
      })],
    })
    expect(result.matched[0].mismatches).toEqual([])
  })

  it('matches On Hold and its annotated hold date', async () => {
    const rows = await parseCustomerScheduleExcel(await makeCustomerWorkbook({
      'QC Result': 'On Hold', 'QC Inspection Date': new Date(2026, 10, 2),
    }))
    const result = reconcileCustomerSchedule(rows, {
      rrm: [makeScheduleRow({
        实际验货期: null, 实际验货通过: false,
        验货状态: 'On Hold', 验货状态日期: new Date(2026, 10, 2),
      })],
    })
    expect(result.matched[0].mismatches).toEqual([])
  })

  it('writes checked cells, quantity mismatch, and status', async () => {
    const source = await makeCustomerWorkbook({ 'Order Qty': 599 })
    const rows = await parseCustomerScheduleExcel(source)
    const result = reconcileCustomerSchedule(rows, { rrm: [makeScheduleRow()] })
    const output = await writeAnnotatedCustomerSchedule(source, result)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(output as any)
    const sheet = workbook.worksheets[0]
    const column = (header: string) => CUSTOMER_CHECK_HEADERS.indexOf(header) + 1
    expect((sheet.getCell(2, column('Order Qty')).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFC7CE')
    expect((sheet.getCell(2, column('Ship To Cust Name')).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFC6EFCE')
    expect((sheet.getCell(2, column('Unit Cost')).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFC6EFCE')
    expect((sheet.getCell(2, column('Purchase Amount')).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFC6EFCE')
    expect(String(sheet.getCell(2, CUSTOMER_CHECK_HEADERS.length + 2).value)).toContain('Order Qty: 排期/核对规则值 600')
    expect(sheet.getCell(2, CUSTOMER_CHECK_HEADERS.length + 1).value).toBe('有差异')
  })

  it('compares Unit Cost to 单价USD and Purchase Amount to 金额USD', async () => {
    const rows = await parseCustomerScheduleExcel(await makeCustomerWorkbook())
    const result = reconcileCustomerSchedule(rows, {
      rrm: [makeScheduleRow({ 单价USD: 4.5, 金额USD: 2700 })],
    })
    expect(result.matched[0].mismatches.map((m) => m.field)).toEqual([
      'Unit Cost', 'Purchase Amount',
    ])
  })

  it('marks rows with no factory schedule match', async () => {
    const source = await makeCustomerWorkbook()
    const rows = await parseCustomerScheduleExcel(source)
    const result = reconcileCustomerSchedule(rows, { rrm: [] })
    const output = await writeAnnotatedCustomerSchedule(source, result)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(output as any)
    expect(workbook.worksheets[0].getCell(2, CUSTOMER_CHECK_HEADERS.length + 1).value).toBe('排期未匹配')
  })
})
