import * as XLSX from 'xlsx'
import { parseDeliveryImport } from './deliveryStats'
import { applyCnyTaxPrice } from './orderPricing'

export interface DeliveryExcelFile {
  name: string
  arrayBuffer: () => Promise<ArrayBuffer>
}

export interface DeliveryExcelBatchResult {
  fileCount: number
  payloads: Record<string, any>[]
  failedRows: number
  unrecognizedFiles: string[]
  readFailedFiles: string[]
}

export interface DeliveryExcelImportOptions {
  preferCnyTaxPrice?: boolean
}

export async function parseDeliveryExcelFiles(
  files: DeliveryExcelFile[],
  factoryIdByName: Record<string, string>,
  options: DeliveryExcelImportOptions = {},
): Promise<DeliveryExcelBatchResult> {
  const result: DeliveryExcelBatchResult = {
    fileCount: files.length,
    payloads: [],
    failedRows: 0,
    unrecognizedFiles: [],
    readFailedFiles: [],
  }

  for (const file of files) {
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true })
      let recognized = false
      const visibleSheetNames = wb.SheetNames.filter((sheetName) => {
        const metadata = wb.Workbook?.Sheets?.find((entry) => entry.name === sheetName)
        return !metadata?.Hidden
      })
      // 采购单常会保留隐藏的旧版工作表；导入应以用户当前可见的表为准。
      // 如果异常文件没有任何可见表，仍回退尝试全部表，保持兼容。
      const sheetNames = visibleSheetNames.length ? visibleSheetNames : wb.SheetNames
      for (const sheetName of sheetNames) {
        const sheet = wb.Sheets[sheetName]
        if (!sheet) continue
        const aoa = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '' })
        const parsed = parseDeliveryImport(aoa, factoryIdByName)
        if (!parsed.payloads.length && !parsed.failed) continue
        result.failedRows += parsed.failed
        result.payloads.push(...parsed.payloads.map((payload) =>
          applyCnyTaxPrice(payload, options.preferCnyTaxPrice)))
        recognized = true
        break
      }
      if (!recognized) result.unrecognizedFiles.push(file.name)
    } catch (error) {
      console.error(`Excel 读取失败: ${file.name}`, error)
      result.readFailedFiles.push(file.name)
    }
  }

  return result
}
