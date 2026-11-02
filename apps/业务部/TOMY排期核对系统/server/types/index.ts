export interface POItem {
  货号: string          // Part No.
  PO走货期: string      // Due Date (raw string "18 Mar 2026")
  数量: number          // Quantity
  factoryCode: string   // "RR01" (东莞), "RR02" (印尼RRI) or "RR03" (印尼RRM)
  外箱: number | null   // Carton packing (N EA/SET per MASTER CARTON)
  hasJDLabel: boolean   // true if item segment contains <FC>JDHL-0PL
}

export interface POData {
  tomyPO: string            // Purchase Order No
  customerPO: string        // Customer PO No
  handleBy: string          // Handle By
  customerName: string      // Customer Name from Shipment Info
  shipToCustomerName: string // Ship To Customer Name (used for 箱唛资料 rule)
  destCountry: string       // Port of Discharge / Destination Country (English)
  items: POItem[]           // One per SKU line in the PO
  sourceFile: string        // Original filename
  qcInstructions: string    // Full QC/remarks text from PDF (for 箱唛資料 rule evaluation)
}

export interface ScheduleRow {
  rowIndex: number
  接单期: Date | null
  国家: string | null
  客名: string | null
  第三客户名称: string | null
  客跟单: string | null
  tomyPO: string | null
  customerPO: string | null
  货号: string | null
  数量: number | null
  外箱: number | null
  总箱数: number | null
  PO走货期: Date | null
  验货期: Date | null
  实际验货期: Date | null
  实际验货通过: boolean
  验货状态: 'Pass' | 'Pending' | 'On Hold' | 'Unscheduled'
  验货状态日期: Date | null
  日期码: string | null
  箱唛资料: string | null
  客贴纸: string | null
  单价USD: number | null
  金额USD: number | null
}

export interface CustomerScheduleRow {
  rowIndex: number
  shipToCustName: string | null
  customerPO: string | null
  shipToCountry: string | null
  partNumber: string | null
  poNum: string | null
  orderQty: number | null
  unitCost: number | null
  purchaseAmount: number | null
  poDueDate: Date | null
  qcResult: string | null
  qcInspectionDate: Date | null
  purchasePointName: string | null
}

export interface CustomerScheduleMatchResult {
  customerRowIndex: number
  tomyPO: string
  货号: string
  sourceSchedule: string
  mismatches: FieldMismatch[]
}

export interface CustomerScheduleUnmatchedRow {
  customerRowIndex: number
  tomyPO: string
  货号: string
  purchasePointName: string | null
}

export interface CustomerScheduleReconciliationResult {
  matched: CustomerScheduleMatchResult[]
  unmatchedRows: CustomerScheduleUnmatchedRow[]
  ambiguousRows: Array<{ customerRowIndex: number; tomyPO: string; 货号: string; count: number }>
  errors: string[]
}

export interface FileResult {
  filename: string
  status: 'done' | 'error'
  data: POData | null
  error?: string
}

export interface ProcessResponse {
  files: FileResult[]
  scheduleDg: {
    filename: string
    status: 'done' | 'error'
    rowCount: number
    error?: string
  } | null
  scheduleId: {
    filename: string
    status: 'done' | 'error'
    rowCount: number
    error?: string
  } | null
  scheduleCustomer: {
    filename: string
    status: 'done' | 'error'
    rowCount: number
    error?: string
  } | null
  reconciliationDg?: ReconciliationSummary
  reconciliationId?: ReconciliationSummary
  reconciliationRrm?: ReconciliationSummary
  reconciliationCustomer?: ReconciliationSummary
  outputReady?: boolean
  sessionId?: string
  customerSessionId?: string
}

export interface MatchDetail {
  tomyPO: string
  货号: string
  sourceFile: string
  mismatches: Array<{ field: string; scheduleValue: unknown; poValue: unknown }>
}

export interface UnmatchedDetail {
  tomyPO: string
  货号: string
  sourceFile: string
}

export interface ReconciliationSummary {
  matchedCount: number
  unmatchedCount: number
  ambiguousCount: number
  mismatchedFieldCount: number
  errors: string[]
  details: {
    matched: MatchDetail[]
    unmatched: UnmatchedDetail[]
  }
}

export interface FieldMismatch {
  field: string           // column name: "货号", "PO走货期", etc.
  scheduleValue: unknown  // value in schedule cell (stays in cell)
  poValue: unknown        // value from PO (shown in Excel comment)
}

export interface RowMatchResult {
  scheduleRowIndex: number
  tomyPO: string
  货号: string
  status: 'matched' | 'unmatched' | 'ambiguous'
  mismatches: FieldMismatch[]
  dateCode: string | null
  sourceFile: string
  hasJDLabel: boolean
}

export interface ReconciliationResult {
  matched: RowMatchResult[]
  unmatchedPOItems: Array<{ tomyPO: string; 货号: string; sourceFile: string; poItem: POItem; poData: POData }>
  ambiguousPOItems: Array<{ tomyPO: string; 货号: string; sourceFile: string; count: number }>
  errors: string[]
}
