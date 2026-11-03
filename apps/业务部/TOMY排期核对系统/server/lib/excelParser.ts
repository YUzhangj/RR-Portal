import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { prepareScheduleWorkbook } from './prepareScheduleWorkbook.js'
import type { ScheduleRow } from '../types/index.js'

// Column name aliases for cross-file compatibility
// Dongguan uses "Tomy PO" / "Cust. PO NO.", Indonesia uses "TOMY PO" / "CUSTOMER PO"
const COLUMN_ALIASES: Record<string, string[]> = {
  tomyPO: ['Tomy PO', 'TOMY PO'],
  customerPO: ['Cust. PO NO.', 'CUSTOMER PO'],
  keMing: ['客名', '第三客户名称'],
  diSanKeHu: ['第三客户名称', '客名'],
  poZouHuoQi: ['PO走货期', '走货期'],
}

/**
 * Build a map from header cell string value to column number.
 * Reads row 1 of the worksheet.
 */
function buildColumnMap(headerRow: ExcelJS.Row): Map<string, number> {
  const map = new Map<string, number>()
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = String(cell.value ?? '').trim()
    if (key) map.set(key, colNumber)
  })
  return map
}

/**
 * Resolve a column number from the map using a list of alias names.
 * Returns the first matching column index, or undefined if none found.
 */
function resolveColumn(colMap: Map<string, number>, names: string[]): number | undefined {
  for (const name of names) {
    const idx = colMap.get(name)
    if (idx !== undefined) return idx
  }
  return undefined
}

/**
 * Unwrap an ExcelJS cell value, handling formula cells that return
 * { formula, result } objects. Returns null for null/undefined.
 */
function unwrapCellValue(raw: ExcelJS.CellValue): unknown {
  if (raw === null || raw === undefined) return null
  // Formula cell: { formula: '...', result: value }
  if (typeof raw === 'object' && 'result' in (raw as object)) {
    return (raw as { formula: string; result: unknown }).result
  }
  return raw
}

/**
 * Get and unwrap the value of a cell at a given column index.
 * Returns null if colIndex is undefined.
 */
function getCellValue(row: ExcelJS.Row, colIndex: number | undefined): unknown {
  if (colIndex === undefined) return null
  const cell = row.getCell(colIndex)
  return unwrapCellValue(cell.value)
}

function hasBlueFont(cell: ExcelJS.Cell, theme: string, palette?: string[]): boolean {
  const color = cell.font?.color
  if (!color) return false
  const tint = (color as typeof color & { tint?: number }).tint
  if (tint === 1 || tint === -1) return false
  let rgb = color.argb?.slice(-6)
  const indexed = (color as typeof color & { indexed?: number }).indexed
  if (indexed !== undefined) rgb = palette ? palette[indexed]?.slice(-6) : ({ 4: '0000FF', 12: '0000FF' } as Record<number, string>)[indexed]
  if (color.theme !== undefined) {
    const names = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
    const name = names[color.theme]
    const block = name && new RegExp(`<a:${name}>[\\s\\S]*?</a:${name}>`).exec(theme)?.[0]
    rgb = block ? /<a:srgbClr\b[^>]*\bval="([A-Fa-f0-9]{6})"/.exec(block)?.[1]
      ?? /<a:sysClr\b[^>]*\blastClr="([A-Fa-f0-9]{6})"/.exec(block)?.[1] : undefined
  }
  if (rgb && /^[A-Fa-f0-9]{6}$/.test(rgb)) {
    const red = Number.parseInt(rgb.slice(0, 2), 16)
    const green = Number.parseInt(rgb.slice(2, 4), 16)
    const blue = Number.parseInt(rgb.slice(4, 6), 16)
    return Number.isFinite(red) && Number.isFinite(green) && Number.isFinite(blue)
      && blue > red && blue > green
  }
  return false
}

function finiteNumber(raw: unknown): number | null {
  if (raw == null || typeof raw === 'string' && !raw.trim()) return null
  const value = Number(typeof raw === 'string' ? raw.replace(/,/g, '') : raw)
  return Number.isFinite(value) ? value : null
}

function parseHoldDate(value: unknown, referenceDate: Date | null): Date | null {
  if (typeof value !== 'string') return null
  const explicit = value.match(/(?<![\d\/.\-])(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\s*(?:ON\s*)?HOLD\b/i)
  const monthFirst = value.match(/(?<![\d\/.\-])(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\s*(?:ON\s*)?HOLD\b/i)
  const match = value.match(/(?<![\d\/.\-])(\d{1,2})[\/.\-](\d{1,2})\s*(?:ON\s*)?HOLD\b/i)
  if (!explicit && !monthFirst && !match) return null
  const month = Number(explicit?.[2] ?? monthFirst?.[1] ?? match?.[1])
  const day = Number(explicit?.[3] ?? monthFirst?.[2] ?? match?.[2])
  const year = explicit ? Number(explicit[1]) : monthFirst ? Number(monthFirst[3]) : referenceDate?.getFullYear()
  if (year === undefined) return null
  const parsed = new Date(year, month - 1, day)
  return parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day
    ? parsed
    : null
}

/**
 * Parse an Excel schedule file and return ScheduleRow[] for the 总排期 sheet.
 *
 * Handles:
 * - Header-based column mapping (different positions in Dongguan vs Indonesia)
 * - Column aliases ("Tomy PO" / "TOMY PO", "Cust. PO NO." / "CUSTOMER PO")
 * - Formula cells (外箱, 总箱数, 数量) returning { formula, result } — unwrapped to number
 * - Date cells (PO走货期, 接单期) returning JS Date objects — kept as Date
 * - Empty rows (no tomyPO value) are skipped
 *
 * @param buffer - Workbook file bytes
 * @param sheetName - Optional sheet selector. When given, the worksheet is
 *   resolved by exact name first, then by substring match (e.g. 'KIK' →
 *   'KIK总排期', 'RRM' → 'RRM总排期'). Throws if no sheet matches.
 *   When omitted, falls back to the 总排期 / TOMY-PO-column auto-detection.
 */
export async function parseScheduleExcel(buffer: Buffer, sheetName?: string): Promise<ScheduleRow[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await prepareScheduleWorkbook(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0])
  const theme = (workbook.model.themes as unknown as { theme1?: string })?.theme1 ?? ''
  // Excel permits a custom indexed palette; never assume index 4 remains blue.
  const rawZip = await JSZip.loadAsync(buffer)
  const rawStyles = await rawZip.file('xl/styles.xml')?.async('string') ?? ''
  const indexedColors = /<indexedColors\b[^>]*>([\s\S]*?)<\/indexedColors>/.exec(rawStyles)
  const palette = indexedColors ? [...indexedColors[1].matchAll(/<rgbColor\b[^>]*\brgb=["']([A-Fa-f0-9]{8})["']/g)].map(m => m[1]) : undefined

  let ws: ExcelJS.Worksheet | undefined

  // Explicit sheet selection: exact name, then substring match
  if (sheetName) {
    ws = workbook.getWorksheet(sheetName)
      ?? workbook.worksheets.find((s) => s.name.includes(sheetName))
    if (!ws) {
      const sheetNames = workbook.worksheets.map(s => s.name).join(', ')
      throw new Error(`Sheet "${sheetName}" not found in workbook (available: ${sheetNames})`)
    }
  }

  // Try known sheet name aliases in order
  const SHEET_CANDIDATES = ['总排期', '排期', 'Schedule', 'Sheet1']
  if (!ws) ws = workbook.getWorksheet('总排期')
  if (!ws) {
    for (const name of SHEET_CANDIDATES) {
      ws = workbook.getWorksheet(name)
      if (ws) break
    }
  }
  // Fallback: scan all sheets for one containing a TOMY PO column
  if (!ws) {
    const tomyPONames = new Set(['Tomy PO', 'TOMY PO'])
    for (const sheet of workbook.worksheets) {
      const headerRow = sheet.getRow(1)
      let found = false
      headerRow.eachCell({ includeEmpty: false }, (cell) => {
        if (tomyPONames.has(String(cell.value ?? '').trim())) found = true
      })
      if (found) { ws = sheet; break }
    }
  }
  if (!ws) {
    const sheetNames = workbook.worksheets.map(s => s.name).join(', ')
    throw new Error(`Sheet 总排期 not found in workbook (available: ${sheetNames})`)
  }

  // Build column map from row 1 headers
  const headerRow = ws.getRow(1)
  const colMap = buildColumnMap(headerRow)

  // Resolve aliased columns
  const tomyPOCol = resolveColumn(colMap, COLUMN_ALIASES.tomyPO)
  const customerPOCol = resolveColumn(colMap, COLUMN_ALIASES.customerPO)

  // Direct lookup columns (identical names in both files)
  const jieDanQiCol = colMap.get('接单期')
  const guoJiaCol = colMap.get('国家')
  const keMingCol = resolveColumn(colMap, COLUMN_ALIASES.keMing)
  const diSanKeHuCol = resolveColumn(colMap, COLUMN_ALIASES.diSanKeHu)
  const keGenDanCol = colMap.get('客跟单')
  const huoHaoCol = colMap.get('货号')
  const shuLiangCol = colMap.get('数量')
  const waiXiangCol = colMap.get('外箱')
  const zongXiangShuCol = colMap.get('总箱数')
  const poZouHuoQiCol = resolveColumn(colMap, COLUMN_ALIASES.poZouHuoQi)
  const yanHuoQiCol = colMap.get('验货期')
  const shiJiYanHuoQiCol = colMap.get('实际验货期')
  const riQiMaCol = colMap.get('日期码')
  const xiangMaiZiLiaoCol = colMap.get('箱唛资料')
  const keTieZhiCol = colMap.get('客贴纸')
  const danJiaUsdCol = colMap.get('单价USD')
  const jinEUsdCol = colMap.get('金额USD')

  const rows: ScheduleRow[] = []

  ws.eachRow({ includeEmpty: false }, (row, rowIdx) => {
    if (rowIdx === 1) return // skip header row

    // Get raw tomyPO value to decide if row is empty
    const rawTomyPO = getCellValue(row, tomyPOCol)
    const tomyPOStr = rawTomyPO !== null && rawTomyPO !== undefined
      ? String(rawTomyPO).trim()
      : ''
    // Skip rows with no TOMY PO value (empty/filler rows)
    if (!tomyPOStr) return

    // Extract 接单期
    const rawJieDanQi = getCellValue(row, jieDanQiCol)
    const jieDanQi = rawJieDanQi instanceof Date ? rawJieDanQi : null

    // Extract 国家
    const rawGuoJia = getCellValue(row, guoJiaCol)
    const guoJia = rawGuoJia !== null && rawGuoJia !== undefined
      ? String(rawGuoJia).trim() || null
      : null

    // Extract 客名. Indonesian schedules use 第三客户名称 for the same business field.
    const rawKeMing = getCellValue(row, keMingCol)
    const keMing = rawKeMing !== null && rawKeMing !== undefined
      ? String(rawKeMing).trim() || null
      : null

    // Extract 第三客户名称 for the original PO-to-schedule reconciliation.
    const rawDiSanKeHu = getCellValue(row, diSanKeHuCol)
    const diSanKeHu = rawDiSanKeHu !== null && rawDiSanKeHu !== undefined
      ? String(rawDiSanKeHu).trim() || null
      : null

    // Extract 客跟单
    const rawKeGenDan = getCellValue(row, keGenDanCol)
    const keGenDan = rawKeGenDan !== null && rawKeGenDan !== undefined
      ? String(rawKeGenDan).trim() || null
      : null

    // Extract customerPO
    const rawCustomerPO = getCellValue(row, customerPOCol)
    const customerPOStr = rawCustomerPO !== null && rawCustomerPO !== undefined
      ? String(rawCustomerPO).trim() || null
      : null

    // Extract 货号
    const rawHuoHao = getCellValue(row, huoHaoCol)
    const huoHao = rawHuoHao !== null && rawHuoHao !== undefined
      ? String(rawHuoHao).trim() || null
      : null

    // Extract numeric fields (may be formula cells)
    const rawShuLiang = getCellValue(row, shuLiangCol)
    const shuLiang = finiteNumber(rawShuLiang)

    const rawWaiXiang = getCellValue(row, waiXiangCol)
    const waiXiang = rawWaiXiang !== null && rawWaiXiang !== undefined
      ? (Number(rawWaiXiang) || null)
      : null

    const rawZongXiangShu = getCellValue(row, zongXiangShuCol)
    const zongXiangShu = rawZongXiangShu !== null && rawZongXiangShu !== undefined
      ? (Number(rawZongXiangShu) || null)
      : null

    // Extract PO走货期 (Date)
    const rawPoZouHuoQi = getCellValue(row, poZouHuoQiCol)
    const poZouHuoQi = rawPoZouHuoQi instanceof Date ? rawPoZouHuoQi : null

    // QC state: a blue actual inspection date means inspection passed.
    // A planned date without a blue actual date means booked but not passed yet.
    const rawYanHuoQi = getCellValue(row, yanHuoQiCol)
    const yanHuoQi = rawYanHuoQi instanceof Date ? rawYanHuoQi : null
    const rawShiJiYanHuoQi = getCellValue(row, shiJiYanHuoQiCol)
    const shiJiYanHuoQi = rawShiJiYanHuoQi instanceof Date ? rawShiJiYanHuoQi : null
    const shiJiYanHuoCell = shiJiYanHuoQiCol === undefined ? null : row.getCell(shiJiYanHuoQiCol)
    const shiJiYanHuoTongGuo = shiJiYanHuoQi !== null
      && shiJiYanHuoCell !== null
      && hasBlueFont(shiJiYanHuoCell, theme, palette)
    const actualInspectionText = typeof rawShiJiYanHuoQi === 'string'
      ? rawShiJiYanHuoQi.trim()
      : ''
    const holdDate = parseHoldDate(rawShiJiYanHuoQi, yanHuoQi ?? poZouHuoQi)
    const isOnHold = /\b(?:ON\s*)?HOLD\b/i.test(actualInspectionText)
    const yanHuoZhuangTai: ScheduleRow['验货状态'] = shiJiYanHuoTongGuo
      ? 'Pass'
      : isOnHold
        ? 'On Hold'
        : yanHuoQi
          ? 'Pending'
          : 'Unscheduled'
    const yanHuoZhuangTaiRiQi = shiJiYanHuoTongGuo
      ? shiJiYanHuoQi
      : isOnHold
        ? holdDate
        : yanHuoQi

    // Extract 日期码
    const rawRiQiMa = getCellValue(row, riQiMaCol)
    const riQiMa = rawRiQiMa !== null && rawRiQiMa !== undefined
      ? String(rawRiQiMa).trim() || null
      : null

    // Extract 箱唛资料
    const rawXiangMaiZiLiao = getCellValue(row, xiangMaiZiLiaoCol)
    const xiangMaiZiLiao = rawXiangMaiZiLiao !== null && rawXiangMaiZiLiao !== undefined
      ? String(rawXiangMaiZiLiao).trim() || null
      : null

    // Extract 客贴纸
    const rawKeTieZhi = getCellValue(row, keTieZhiCol)
    const keTieZhi = rawKeTieZhi !== null && rawKeTieZhi !== undefined
      ? String(rawKeTieZhi).trim() || null
      : null

    // Extract USD unit price and amount used by customer schedule reconciliation.
    const rawDanJiaUsd = getCellValue(row, danJiaUsdCol)
    const danJiaUsd = finiteNumber(rawDanJiaUsd)

    const rawJinEUsd = getCellValue(row, jinEUsdCol)
    const jinEUsd = finiteNumber(rawJinEUsd)

    rows.push({
      rowIndex: rowIdx,
      接单期: jieDanQi,
      国家: guoJia,
      客名: keMing,
      第三客户名称: diSanKeHu,
      客跟单: keGenDan,
      tomyPO: tomyPOStr,
      customerPO: customerPOStr,
      货号: huoHao,
      数量: shuLiang,
      外箱: waiXiang,
      总箱数: zongXiangShu,
      PO走货期: poZouHuoQi,
      验货期: yanHuoQi,
      实际验货期: shiJiYanHuoQi,
      实际验货通过: shiJiYanHuoTongGuo,
      验货状态: yanHuoZhuangTai,
      验货状态日期: yanHuoZhuangTaiRiQi,
      日期码: riQiMa,
      箱唛资料: xiangMaiZiLiao,
      客贴纸: keTieZhi,
      单价USD: danJiaUsd,
      金额USD: jinEUsd,
    })
  })

  return rows
}
