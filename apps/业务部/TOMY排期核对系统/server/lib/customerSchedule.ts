import ExcelJS from 'exceljs'
import { parse } from 'date-fns'
import { normalize } from './normalize.js'
import { prepareScheduleWorkbook } from './prepareScheduleWorkbook.js'
import type {
  CustomerScheduleReconciliationResult,
  CustomerScheduleRow,
  FieldMismatch,
  ScheduleRow,
} from '../types/index.js'

const REQUIRED_HEADERS = ['PO Num', 'Part Number']

const CUSTOMER_HEADERS = {
  shipToCustName: 'Ship To Cust Name',
  customerPO: 'Customer PO #',
  shipToCountry: 'Ship To Country',
  partNumber: 'Part Number',
  poNum: 'PO Num',
  orderQty: 'Order Qty',
  unitCost: 'Unit Cost',
  purchaseAmount: 'Purchase Amount',
  poDueDate: 'PO Due Date',
  qcResult: 'QC Result',
  qcInspectionDate: 'QC Inspection Date',
  purchasePointName: 'Purchase Point Name',
} as const

export const CUSTOMER_CHECK_HEADERS = Object.values(CUSTOMER_HEADERS)

const PURCHASE_POINT_NAMES: Record<string, string> = {
  RR01: 'DONGGUAN HANSON PLASTIC PRODUCT LTD',
  RR02: 'PT ROYAL REGENT INDONESIA',
  RR03: 'PT ROYAL REGENT MANUFACTURING',
}

const GREEN_FILL: ExcelJS.FillPattern = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' },
}

const RED_FILL: ExcelJS.FillPattern = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' },
}

const YELLOW_FILL: ExcelJS.FillPattern = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' },
}

function unwrapCellValue(raw: ExcelJS.CellValue): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object' && 'result' in (raw as object)) {
    return (raw as { result: unknown }).result
  }
  if (typeof raw === 'object' && 'text' in (raw as object)) {
    return (raw as { text: string }).text
  }
  return raw
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const utc = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000)
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
  }
  const text = asText(value)
  if (!text) return null
  for (const format of ['MM/dd/yyyy', 'M/d/yyyy', 'yyyy-MM-dd', 'd MMM yyyy']) {
    const parsed = parse(text, format, new Date())
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return null
}

function buildColumnMap(row: ExcelJS.Row): Map<string, number> {
  const map = new Map<string, number>()
  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = String(unwrapCellValue(cell.value) ?? '').trim()
    if (header) map.set(header, colNumber)
  })
  return map
}

function findCustomerWorksheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const worksheet = workbook.worksheets.find((sheet) => {
    const headers = buildColumnMap(sheet.getRow(1))
    return REQUIRED_HEADERS.every((header) => headers.has(header))
  })
  if (!worksheet) {
    throw new Error(`客户排期表缺少必需表头: ${REQUIRED_HEADERS.join(', ')}`)
  }
  return worksheet
}

export async function parseCustomerScheduleExcel(buffer: Buffer): Promise<CustomerScheduleRow[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await prepareScheduleWorkbook(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0])
  const worksheet = findCustomerWorksheet(workbook)
  const columns = buildColumnMap(worksheet.getRow(1))

  const missingHeaders = CUSTOMER_CHECK_HEADERS.filter((header) => !columns.has(header))
  if (missingHeaders.length > 0) {
    throw new Error(`客户排期表缺少红色核对字段: ${missingHeaders.join(', ')}`)
  }

  const get = (row: ExcelJS.Row, header: string) => {
    const column = columns.get(header)
    return column === undefined ? null : unwrapCellValue(row.getCell(column).value)
  }

  const rows: CustomerScheduleRow[] = []
  worksheet.eachRow({ includeEmpty: false }, (row, rowIndex) => {
    if (rowIndex === 1) return
    const poNum = asText(get(row, CUSTOMER_HEADERS.poNum))
    const partNumber = asText(get(row, CUSTOMER_HEADERS.partNumber))
    if (!poNum || !partNumber) return

    rows.push({
      rowIndex,
      shipToCustName: asText(get(row, CUSTOMER_HEADERS.shipToCustName)),
      customerPO: asText(get(row, CUSTOMER_HEADERS.customerPO)),
      shipToCountry: asText(get(row, CUSTOMER_HEADERS.shipToCountry)),
      partNumber,
      poNum,
      orderQty: asNumber(get(row, CUSTOMER_HEADERS.orderQty)),
      unitCost: asNumber(get(row, CUSTOMER_HEADERS.unitCost)),
      purchaseAmount: asNumber(get(row, CUSTOMER_HEADERS.purchaseAmount)),
      poDueDate: asDate(get(row, CUSTOMER_HEADERS.poDueDate)),
      qcResult: asText(get(row, CUSTOMER_HEADERS.qcResult)),
      qcInspectionDate: asDate(get(row, CUSTOMER_HEADERS.qcInspectionDate)),
      purchasePointName: asText(get(row, CUSTOMER_HEADERS.purchasePointName)),
    })
  })

  return rows
}

function normalizedText(value: string | null | undefined): string {
  return normalize(value).replace(/\s+/g, ' ').toUpperCase()
}

function sameDate(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function addTextMismatch(
  mismatches: FieldMismatch[],
  field: string,
  actual: string | null,
  expected: string | null | undefined,
): void {
  if (normalizedText(actual) !== normalizedText(expected)) {
    mismatches.push({ field, scheduleValue: actual, poValue: expected ?? '' })
  }
}

function addNumberMismatch(
  mismatches: FieldMismatch[],
  field: string,
  actual: number | null,
  expected: number | null | undefined,
  tolerance = 0,
): void {
  if (expected == null) return
  if (actual === null || Math.abs(actual - expected) > tolerance) {
    mismatches.push({ field, scheduleValue: actual, poValue: expected })
  }
}

function addRequiredNumberMismatch(
  mismatches: FieldMismatch[],
  field: string,
  actual: number | null,
  expected: number | null | undefined,
  tolerance: number,
): void {
  if (actual === null || expected == null || Math.abs(actual - expected) > tolerance) {
    mismatches.push({ field, scheduleValue: actual, poValue: expected ?? null })
  }
}

function customerKey(poNum: string | null | undefined, partNumber: string | null | undefined): string {
  return `${normalizedText(poNum)}:${normalizedText(partNumber)}`
}

const COUNTRY_MAP: Record<string, string> = {
  BELGIUM: '比利时', BEL: '比利时', UK: '英国', 'UNITED KINGDOM': '英国',
  USA: '美国', 'UNITED STATES': '美国', AUSTRALIA: '澳大利亚', AUS: '澳大利亚',
  INDONESIA: '印尼', CHINA: '中国', POLAND: '波兰', POL: '波兰', URUGUAY: '乌拉圭',
  FRANCE: '法国', GERMANY: '德国', JAPAN: '日本', KOREA: '韩国', 'SOUTH KOREA': '韩国',
  CANADA: '加拿大', NETHERLANDS: '荷兰', SPAIN: '西班牙', ITALY: '意大利',
}

const CHECKED_HEADERS = [
  CUSTOMER_HEADERS.shipToCustName,
  CUSTOMER_HEADERS.customerPO,
  CUSTOMER_HEADERS.shipToCountry,
  CUSTOMER_HEADERS.partNumber,
  CUSTOMER_HEADERS.poNum,
  CUSTOMER_HEADERS.orderQty,
  CUSTOMER_HEADERS.unitCost,
  CUSTOMER_HEADERS.purchaseAmount,
  CUSTOMER_HEADERS.poDueDate,
  CUSTOMER_HEADERS.qcResult,
  CUSTOMER_HEADERS.qcInspectionDate,
  CUSTOMER_HEADERS.purchasePointName,
]

export interface CustomerScheduleSources {
  dg?: ScheduleRow[] | null
  id?: ScheduleRow[] | null
  rrm?: ScheduleRow[] | null
}

interface IndexedScheduleRow {
  row: ScheduleRow
  factoryCode: 'RR01' | 'RR02' | 'RR03'
  label: string
}

function inferFactoryCode(purchasePointName: string | null): 'RR01' | 'RR02' | 'RR03' | null {
  const value = normalizedText(purchasePointName)
  if (value.includes('DONGGUAN HANSON')) return 'RR01'
  if (value.includes('ROYAL REGENT INDONESIA')) return 'RR02'
  if (value.includes('ROYAL REGENT MANUFACTURING')) return 'RR03'
  return null
}

function countriesMatch(customerCountry: string | null, scheduleCountry: string | null): boolean {
  const customer = normalizedText(customerCountry)
  const schedule = normalizedText(scheduleCountry)
  const translated = normalizedText(COUNTRY_MAP[customer] ?? customerCountry)
  return customer === schedule || translated === schedule
}

function compareCustomerToSchedule(
  customerRow: CustomerScheduleRow,
  source: IndexedScheduleRow,
): FieldMismatch[] {
  const scheduleRow = source.row
  const mismatches: FieldMismatch[] = []

  addTextMismatch(mismatches, CUSTOMER_HEADERS.shipToCustName, customerRow.shipToCustName, scheduleRow.客名)
  addTextMismatch(mismatches, CUSTOMER_HEADERS.customerPO, customerRow.customerPO, scheduleRow.customerPO)
  if (!countriesMatch(customerRow.shipToCountry, scheduleRow.国家)) {
    mismatches.push({
      field: CUSTOMER_HEADERS.shipToCountry,
      scheduleValue: customerRow.shipToCountry,
      poValue: scheduleRow.国家,
    })
  }
  addTextMismatch(mismatches, CUSTOMER_HEADERS.partNumber, customerRow.partNumber, scheduleRow.货号)
  addTextMismatch(mismatches, CUSTOMER_HEADERS.poNum, customerRow.poNum, scheduleRow.tomyPO)
  addNumberMismatch(mismatches, CUSTOMER_HEADERS.orderQty, customerRow.orderQty, scheduleRow.数量)
  addRequiredNumberMismatch(mismatches, CUSTOMER_HEADERS.unitCost, customerRow.unitCost, scheduleRow.单价USD, 0.0005)
  addRequiredNumberMismatch(mismatches, CUSTOMER_HEADERS.purchaseAmount, customerRow.purchaseAmount, scheduleRow.金额USD, 0.005)

  if (scheduleRow.PO走货期 && !sameDate(customerRow.poDueDate, scheduleRow.PO走货期)) {
    mismatches.push({
      field: CUSTOMER_HEADERS.poDueDate,
      scheduleValue: customerRow.poDueDate,
      poValue: scheduleRow.PO走货期,
    })
  }

  const actualQcResult = normalizedText(customerRow.qcResult)
  const expectedQcResult = scheduleRow.验货状态 === 'Unscheduled'
    ? ''
    : normalizedText(scheduleRow.验货状态)
  const qcResultMatches = scheduleRow.验货状态 === 'On Hold'
    ? actualQcResult === 'ON HOLD' || actualQcResult === 'HOLD'
    : actualQcResult === expectedQcResult
  if (!qcResultMatches) {
    const expectedLabel = scheduleRow.验货状态 === 'Pass'
      ? 'Pass（蓝字实际验货日期）'
      : scheduleRow.验货状态 === 'Pending'
        ? 'Pending（已预约未验货）'
        : scheduleRow.验货状态 === 'On Hold'
          ? 'On Hold'
          : '应为空（尚未预约验货）'
    mismatches.push({
      field: CUSTOMER_HEADERS.qcResult,
      scheduleValue: customerRow.qcResult,
      poValue: expectedLabel,
    })
  }

  if (!sameDate(customerRow.qcInspectionDate, scheduleRow.验货状态日期)) {
    mismatches.push({
      field: CUSTOMER_HEADERS.qcInspectionDate,
      scheduleValue: customerRow.qcInspectionDate,
      poValue: scheduleRow.验货状态日期
        ?? (scheduleRow.验货状态 === 'On Hold'
          ? '排期 On Hold 未标有效日期'
          : '应为空（尚未预约验货）'),
    })
  }

  addTextMismatch(
    mismatches,
    CUSTOMER_HEADERS.purchasePointName,
    customerRow.purchasePointName,
    PURCHASE_POINT_NAMES[source.factoryCode],
  )

  return mismatches
}

export function reconcileCustomerSchedule(
  customerRows: CustomerScheduleRow[],
  sources: CustomerScheduleSources,
): CustomerScheduleReconciliationResult {
  const result: CustomerScheduleReconciliationResult = {
    matched: [],
    unmatchedRows: [],
    ambiguousRows: [],
    errors: [],
  }

  const allSources: IndexedScheduleRow[] = [
    ...(sources.dg ?? []).map((row) => ({ row, factoryCode: 'RR01' as const, label: '东莞排期' })),
    ...(sources.id ?? []).map((row) => ({ row, factoryCode: 'RR02' as const, label: '印尼RRI排期' })),
    ...(sources.rrm ?? []).map((row) => ({ row, factoryCode: 'RR03' as const, label: '印尼RRM排期' })),
  ]
  if (allSources.length === 0) {
    result.errors.push('客户排期核对需要同时上传东莞或印尼排期表')
  }

  const index = new Map<string, IndexedScheduleRow[]>()
  for (const source of allSources) {
    const key = customerKey(source.row.tomyPO, source.row.货号)
    const rows = index.get(key) ?? []
    rows.push(source)
    index.set(key, rows)
  }

  const claimedRows = new Set<string>()
  for (const customerRow of customerRows) {
    const expectedFactory = inferFactoryCode(customerRow.purchasePointName)
    const candidates = (index.get(customerKey(customerRow.poNum, customerRow.partNumber)) ?? [])
      .filter((source) => expectedFactory === null || source.factoryCode === expectedFactory)
      .filter((source) => !claimedRows.has(`${source.factoryCode}:${source.row.rowIndex}`))

    if (candidates.length === 0) {
      result.unmatchedRows.push({
        customerRowIndex: customerRow.rowIndex,
        tomyPO: customerRow.poNum ?? '',
        货号: customerRow.partNumber ?? '',
        purchasePointName: customerRow.purchasePointName,
      })
      continue
    }

    const exactQuantityRows = candidates.filter((source) => source.row.数量 === customerRow.orderQty)
    const matchedSource = exactQuantityRows[0] ?? candidates[0]
    const ambiguousCount = exactQuantityRows.length > 1
      ? exactQuantityRows.length
      : exactQuantityRows.length === 0 && candidates.length > 1
        ? candidates.length
        : 0
    if (ambiguousCount > 0) {
      result.ambiguousRows.push({
        customerRowIndex: customerRow.rowIndex,
        tomyPO: customerRow.poNum ?? '',
        货号: customerRow.partNumber ?? '',
        count: ambiguousCount,
      })
    }

    claimedRows.add(`${matchedSource.factoryCode}:${matchedSource.row.rowIndex}`)
    result.matched.push({
      customerRowIndex: customerRow.rowIndex,
      tomyPO: customerRow.poNum ?? '',
      货号: customerRow.partNumber ?? '',
      sourceSchedule: matchedSource.label,
      mismatches: compareCustomerToSchedule(customerRow, matchedSource),
    })
  }

  return result
}

function displayValue(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  }
  return String(value ?? '空')
}

export async function writeAnnotatedCustomerSchedule(
  customerBuffer: Buffer,
  result: CustomerScheduleReconciliationResult,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await prepareScheduleWorkbook(customerBuffer) as unknown as Parameters<typeof workbook.xlsx.load>[0])
  const worksheet = findCustomerWorksheet(workbook)
  const columns = buildColumnMap(worksheet.getRow(1))
  const statusColumn = worksheet.columnCount + 1
  const statusHeader = worksheet.getRow(1).getCell(statusColumn)
  statusHeader.value = '核对状态'
  statusHeader.font = { ...statusHeader.font, bold: true }
  statusHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAF7' } }
  worksheet.getColumn(statusColumn).width = 12

  const fieldColumns = new Map<string, number>()
  for (const header of CUSTOMER_CHECK_HEADERS) {
    const column = columns.get(header)
    if (column !== undefined) fieldColumns.set(header, column)
  }

  const ambiguousRowIndexes = new Set(result.ambiguousRows.map((row) => row.customerRowIndex))
  for (const match of result.matched) {
    const row = worksheet.getRow(match.customerRowIndex)
    for (const header of CHECKED_HEADERS) {
      const column = fieldColumns.get(header)
      if (column === undefined) continue
      const cell = row.getCell(column)
      cell.style = { ...cell.style, fill: { ...GREEN_FILL } }
    }
    for (const mismatch of match.mismatches) {
      const column = fieldColumns.get(mismatch.field)
      if (column === undefined) continue
      const cell = row.getCell(column)
      cell.style = { ...cell.style, fill: { ...RED_FILL } }
      cell.note = `排期/核对规则值: ${displayValue(mismatch.poValue)}`
    }
    const statusCell = row.getCell(statusColumn)
    statusCell.value = ambiguousRowIndexes.has(match.customerRowIndex)
      ? '重复匹配'
      : match.mismatches.length > 0 ? '有差异' : '已核对'
    statusCell.note = `核对来源: ${match.sourceSchedule}`
  }

  for (const unmatched of result.unmatchedRows) {
    const row = worksheet.getRow(unmatched.customerRowIndex)
    for (const header of CUSTOMER_CHECK_HEADERS) {
      const column = fieldColumns.get(header)
      if (column === undefined) continue
      const cell = row.getCell(column)
      cell.style = { ...cell.style, fill: { ...YELLOW_FILL } }
    }
    const statusCell = row.getCell(statusColumn)
    statusCell.value = '排期未匹配'
    statusCell.note = '未在已上传的东莞/印尼排期中找到同一 PO Num + Part Number'
  }

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

