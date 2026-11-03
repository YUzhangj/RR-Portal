import ExcelJS from 'exceljs'
import { parse } from 'date-fns'
import { normalize } from './normalize.js'
import { prepareScheduleWorkbook } from './prepareScheduleWorkbook.js'
import { patchCustomerWorkbook, type CellAnnotation } from './customerWorkbookPatch.js'
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

function unwrapCellValue(raw: ExcelJS.CellValue): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object' && 'result' in (raw as object)) {
    return (raw as { result: unknown }).result
  }
  if (typeof raw === 'object' && 'text' in (raw as object)) {
    return (raw as { text: string }).text
  }
  if (typeof raw === 'object' && 'richText' in raw) return raw.richText.map(part => part.text).join('')
  return raw
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return null
  const text = String(value).trim()
  return text || null
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'string' && !value.trim()) return null
  const parsed = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function asDate(value: unknown, date1904 = false): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const utc = new Date((date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + Math.floor(value) * 86_400_000)
    return Number.isNaN(utc.getTime()) ? null : new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
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
    if (header && CUSTOMER_CHECK_HEADERS.includes(header as typeof CUSTOMER_CHECK_HEADERS[number]) && map.has(header)) throw new Error(`客户排期表存在重复核对表头: ${header}`)
    if (header) map.set(header, colNumber)
  })
  return map
}

function findCustomerWorksheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const candidates = workbook.worksheets.filter((sheet) => {
    const headers = buildColumnMap(sheet.getRow(1))
    return REQUIRED_HEADERS.every((header) => headers.has(header))
  })
  if (candidates.length > 1) throw new Error('客户排期表包含多个候选工作表，请只保留要核对的一个工作表')
  const worksheet = candidates[0]
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
  const typed = <T>(row: ExcelJS.Row, header: string, convert: (value: unknown) => T | null): T | null => {
    const raw = get(row, header), value = convert(raw)
    if (raw != null && String(raw).trim() && value === null) throw new Error(`客户排期第 ${row.number} 行 ${header} 格式无效，请检查数值或日期`)
    return value
  }

  const rows: CustomerScheduleRow[] = []
  worksheet.eachRow({ includeEmpty: false }, (row, rowIndex) => {
    if (rowIndex === 1) return
    const poNum = asText(get(row, CUSTOMER_HEADERS.poNum))
    const partNumber = asText(get(row, CUSTOMER_HEADERS.partNumber))
    if (CUSTOMER_CHECK_HEADERS.every(header => get(row, header) == null || get(row, header) === '')) return

    rows.push({
      rowIndex,
      shipToCustName: asText(get(row, CUSTOMER_HEADERS.shipToCustName)),
      customerPO: asText(get(row, CUSTOMER_HEADERS.customerPO)),
      shipToCountry: asText(get(row, CUSTOMER_HEADERS.shipToCountry)),
      partNumber,
      poNum,
      orderQty: typed(row, CUSTOMER_HEADERS.orderQty, asNumber),
      unitCost: typed(row, CUSTOMER_HEADERS.unitCost, asNumber),
      purchaseAmount: typed(row, CUSTOMER_HEADERS.purchaseAmount, asNumber),
      poDueDate: typed(row, CUSTOMER_HEADERS.poDueDate, raw => asDate(raw, workbook.properties.date1904)),
      qcResult: asText(get(row, CUSTOMER_HEADERS.qcResult)),
      qcInspectionDate: typed(row, CUSTOMER_HEADERS.qcInspectionDate, raw => asDate(raw, workbook.properties.date1904)),
      purchasePointName: asText(get(row, CUSTOMER_HEADERS.purchasePointName)),
    })
  })

  if (!rows.length) throw new Error('客户排期表没有可核对的数据行')
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
  return JSON.stringify([normalizedText(poNum), normalizedText(partNumber)])
}

const COUNTRY_MAP: Record<string, string> = {
  BELGIUM: '比利时', BEL: '比利时', UK: '英国', 'UNITED KINGDOM': '英国',
  USA: '美国', 'UNITED STATES': '美国', AUSTRALIA: '澳大利亚', AUS: '澳大利亚',
  INDONESIA: '印尼', CHINA: '中国', POLAND: '波兰', POL: '波兰', URUGUAY: '乌拉圭',
  FRANCE: '法国', GERMANY: '德国', JAPAN: '日本', KOREA: '韩国', 'SOUTH KOREA': '韩国',
  CANADA: '加拿大', NETHERLANDS: '荷兰', SPAIN: '西班牙', ITALY: '意大利',
}

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
  addRequiredNumberMismatch(mismatches, CUSTOMER_HEADERS.orderQty, customerRow.orderQty, scheduleRow.数量, 0)
  addRequiredNumberMismatch(mismatches, CUSTOMER_HEADERS.unitCost, customerRow.unitCost, scheduleRow.单价USD, 0.0005)
  addRequiredNumberMismatch(mismatches, CUSTOMER_HEADERS.purchaseAmount, customerRow.purchaseAmount, scheduleRow.金额USD, 0.005)

  if (!sameDate(customerRow.poDueDate, scheduleRow.PO走货期)) {
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
    if (!normalizedText(customerRow.poNum) || !normalizedText(customerRow.partNumber)) {
      const reason = `客户排期第 ${customerRow.rowIndex} 行缺少 PO Num 或 Part Number，未核对`
      result.errors.push(reason)
      result.unmatchedRows.push({ customerRowIndex: customerRow.rowIndex, tomyPO: customerRow.poNum ?? '', 货号: customerRow.partNumber ?? '', purchasePointName: customerRow.purchasePointName, reason })
      continue
    }
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
      continue
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
  const annotations = new Map<number, CellAnnotation>()
  const fields = (fill: string) => new Map(CUSTOMER_CHECK_HEADERS.map(header => [columns.get(header)!, fill]))
  for (const match of result.matched) {
    const colors = fields('FFC6EFCE')
    for (const mismatch of match.mismatches) { const column = columns.get(mismatch.field); if (column !== undefined) colors.set(column, 'FFFFC7CE') }
    annotations.set(match.customerRowIndex, { status: match.mismatches.length ? '有差异' : '已核对',
      detail: [`核对来源: ${match.sourceSchedule}`, ...match.mismatches.map(m => `${m.field}: 排期/核对规则值 ${displayValue(m.poValue)}`)].join('；'), fields: colors })
  }
  for (const row of result.ambiguousRows) annotations.set(row.customerRowIndex, { status: '多条匹配，待确认',
    detail: `同一 PO Num + Part Number 有 ${row.count} 条候选，未选取或核对任何一条`, fields: fields('FFFFEB9C') })
  for (const row of result.unmatchedRows) annotations.set(row.customerRowIndex, { status: '排期未匹配',
    detail: row.reason ?? '未在已上传的东莞/印尼排期中找到同一 PO Num + Part Number', fields: fields('FFFFEB9C') })
  return patchCustomerWorkbook(customerBuffer, worksheet.id, annotations)
}
