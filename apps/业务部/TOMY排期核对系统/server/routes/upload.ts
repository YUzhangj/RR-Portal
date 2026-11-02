import express from 'express'
import multer from 'multer'
import path from 'path'
import { extractPO } from '../lib/pdfExtractor.js'
import { parseScheduleExcel } from '../lib/excelParser.js'
import { reconcile } from '../lib/reconciler.js'
import { writeAnnotatedSchedule } from '../lib/excelWriter.js'
import { buildZipBuffer } from '../lib/zipBuilder.js'
import { buildSummaryReport } from '../lib/summaryReport.js'
import { createOutputStore, OutputCapacityError } from '../lib/outputStore.js'
import { createUploadAdmission, UploadLimitError } from '../lib/uploadAdmission.js'
import {
  parseCustomerScheduleExcel,
  reconcileCustomerSchedule,
  writeAnnotatedCustomerSchedule,
} from '../lib/customerSchedule.js'
import type {
  CustomerScheduleReconciliationResult,
  FileResult,
  ProcessResponse,
  POData,
  ReconciliationResult,
  ReconciliationSummary,
} from '../types/index.js'

// Fix multer's Latin-1 decoded filename back to correct UTF-8.
// Multer decodes multipart filenames as Latin-1 (binary), but browsers send UTF-8.
function fixFilename(name: string): string {
  try {
    const fixed = Buffer.from(name, 'binary').toString('utf8')
    if (!fixed.includes('\ufffd')) return fixed
    return name
  } catch {
    return name
  }
}

const router = express.Router()

// Configure multer with memory storage and 25MB per-file limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

// UUID bearer outputs are retryable for 30 minutes and bounded across requests.
const outputStore = createOutputStore()
const admission = createUploadAdmission()

function displayFilename(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' && value ? value : fallback
  const clean = path.posix.basename(candidate.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '')
  return clean && clean !== '.' && clean !== '..' && clean.length <= 255 ? clean : '上传文件'
}

function appendUniqueEntry(entries: Array<{ name: string; buffer: Buffer }>, folder: string, filename: string, buffer: Buffer) {
  const safe = displayFilename(filename, 'PO.pdf')
  const ext = path.posix.extname(safe)
  const base = safe.slice(0, safe.length - ext.length)
  let name = `${folder}/${safe}`
  for (let i = 2; entries.some(entry => entry.name === name); i++) name = `${folder}/${base} (${i})${ext}`
  entries.push({ name, buffer })
}

function buildReconciliationSummary(result: ReconciliationResult): ReconciliationSummary {
  return {
    matchedCount: result.matched.length,
    unmatchedCount: result.unmatchedPOItems.length,
    ambiguousCount: result.ambiguousPOItems.length,
    mismatchedFieldCount: result.matched.reduce((sum, m) => sum + m.mismatches.length, 0),
    errors: result.errors,
    details: {
      matched: result.matched.map(m => ({
        tomyPO: m.tomyPO,
        货号: m.货号,
        sourceFile: m.sourceFile,
        mismatches: m.mismatches.map(mm => ({
          field: mm.field,
          scheduleValue: mm.scheduleValue,
          poValue: mm.poValue,
        })),
      })),
      unmatched: result.unmatchedPOItems.map(u => ({
        tomyPO: u.tomyPO,
        货号: u.货号,
        sourceFile: u.sourceFile,
      })),
    },
  }
}

function buildCustomerReconciliationSummary(
  result: CustomerScheduleReconciliationResult,
): ReconciliationSummary {
  const summary = {
    matchedCount: result.matched.length,
    unmatchedCount: result.unmatchedRows.length,
    ambiguousCount: result.ambiguousRows.length,
    mismatchedFieldCount: result.matched.reduce((sum, match) => sum + match.mismatches.length, 0),
    errors: result.errors,
    details: {
      matched: result.matched.map((match) => ({
        tomyPO: match.tomyPO,
        货号: match.货号,
        sourceFile: match.sourceSchedule,
        mismatches: match.mismatches.map((mismatch) => ({
          field: mismatch.field,
          scheduleValue: mismatch.scheduleValue,
          poValue: mismatch.poValue,
        })),
      })),
      ambiguous: result.ambiguousRows.map(row => ({
        tomyPO: row.tomyPO, 货号: row.货号, sourceFile: '客户排期', count: row.count,
      })),
      unmatched: result.unmatchedRows.map((row) => ({
        tomyPO: row.tomyPO,
        货号: row.货号,
        sourceFile: '客户排期',
      })),
    },
  }
  return summary
}

// Empty result fallback for optional single-factory submissions
const emptyResult: ReconciliationResult = {
  matched: [],
  unmatchedPOItems: [],
  ambiguousPOItems: [],
  errors: [],
}

// POST /api/process - accepts PO PDFs and two schedule Excel files, returns per-file results + reconciliation summary
router.post(
  '/process',
  admission.admit,
  upload.fields([
    { name: 'pos', maxCount: 100 },
    { name: 'scheduleDg', maxCount: 1 },
    { name: 'scheduleId', maxCount: 1 },
    { name: 'scheduleCustomer', maxCount: 1 },
  ]),
  async (req, res) => {
    admission.begin(req)
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] }
      const poFiles = files?.pos || []
      const scheduleDgFiles = files?.scheduleDg || []
      const scheduleIdFiles = files?.scheduleId || []
      const scheduleCustomerFiles = files?.scheduleCustomer || []

      // Use clean filenames sent from frontend (avoids multer encoding issues)
      let poNames: string[] = []
      try {
        const parsed: unknown = JSON.parse(typeof req.body?.poNames === 'string' ? req.body.poNames : '[]')
        if (Array.isArray(parsed)) poNames = parsed.map(name => typeof name === 'string' ? name : '')
      } catch { /* use multer names as fallback */ }
      const scheduleDgName = (req.body?.scheduleDgName as string) || ''
      const scheduleIdName = (req.body?.scheduleIdName as string) || ''
      const scheduleCustomerName = (req.body?.scheduleCustomerName as string) || ''

      // Process each PO PDF — keep original buffers for ZIP inclusion
      const results: FileResult[] = []
      const poBuffers: Array<{ filename: string; buffer: Buffer; factoryCode: string | null }> = []
      for (let i = 0; i < poFiles.length; i++) {
        const file = poFiles[i]
        const displayName = displayFilename(poNames[i], fixFilename(file.originalname))
        try {
          const data = await extractPO(file.buffer, displayName)
          if (!data.tomyPO?.trim() || !Array.isArray(data.items) || data.items.length === 0) {
            throw new Error('未识别到有效 TOMY PO 号或货号明细，请检查 PDF 后重试')
          }
          results.push({ filename: displayName, status: 'done', data })
          poBuffers.push({
            filename: displayName,
            buffer: file.buffer,
            factoryCode: data.items[0]?.factoryCode ?? null,
          })
        } catch (err) {
          results.push({
            filename: displayName,
            status: 'error',
            data: null,
            error: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      }

      // Process 东莞 schedule Excel
      let scheduleDgResult: ProcessResponse['scheduleDg'] = null
      let dgBuffer: Buffer | null = null
      let dgScheduleRows = null

      if (scheduleDgFiles.length > 0) {
        const file = scheduleDgFiles[0]
        const displayName = displayFilename(scheduleDgName || undefined, fixFilename(file.originalname))
        try {
          const rows = await parseScheduleExcel(file.buffer)
          scheduleDgResult = { filename: displayName, status: 'done', rowCount: rows.length }
          dgBuffer = file.buffer
          dgScheduleRows = rows
        } catch (err) {
          scheduleDgResult = {
            filename: displayName,
            status: 'error',
            rowCount: 0,
            error: err instanceof Error ? err.message : 'Unknown error',
          }
        }
      }

      // Process 印尼 schedule Excel.
      // The 印尼 workbook holds two sheets: KIK总排期 (RR02/RRI) and RRM总排期 (RR03/RRM).
      let scheduleIdResult: ProcessResponse['scheduleId'] = null
      let idBuffer: Buffer | null = null
      let idScheduleRows = null
      let rrmScheduleRows = null

      if (scheduleIdFiles.length > 0) {
        const file = scheduleIdFiles[0]
        const displayName = displayFilename(scheduleIdName || undefined, fixFilename(file.originalname))
        try {
          const kikRows = await parseScheduleExcel(file.buffer, 'KIK总排期')
          const rrmRows = await parseScheduleExcel(file.buffer, 'RRM总排期')
          scheduleIdResult = { filename: displayName, status: 'done', rowCount: kikRows.length + rrmRows.length }
          idBuffer = file.buffer
          idScheduleRows = kikRows
          rrmScheduleRows = rrmRows
        } catch (err) {
          scheduleIdResult = {
            filename: displayName,
            status: 'error',
            rowCount: 0,
            error: err instanceof Error ? err.message : 'Unknown error',
          }
        }
      }

      // Process customer schedule Excel (red headers are the primary check fields).
      let scheduleCustomerResult: ProcessResponse['scheduleCustomer'] = null
      let customerBuffer: Buffer | null = null
      let customerScheduleRows = null

      if (scheduleCustomerFiles.length > 0) {
        const file = scheduleCustomerFiles[0]
        const displayName = displayFilename(scheduleCustomerName || undefined, fixFilename(file.originalname))
        try {
          const rows = await parseCustomerScheduleExcel(file.buffer)
          scheduleCustomerResult = { filename: displayName, status: 'done', rowCount: rows.length }
          customerBuffer = file.buffer
          customerScheduleRows = rows
        } catch (err) {
          scheduleCustomerResult = {
            filename: displayName,
            status: 'error',
            rowCount: 0,
            error: err instanceof Error ? err.message : 'Unknown error',
          }
        }
      }

      const response: ProcessResponse = {
        files: results,
        scheduleDg: scheduleDgResult,
        scheduleId: scheduleIdResult,
        scheduleCustomer: scheduleCustomerResult,
      }

      // Parse-only inputs remain visible; only usable source data can produce a checked result.
      const hasUsablePO = results.some(result => result.status === 'done' && result.data !== null)
      if ((dgBuffer !== null || idBuffer !== null) && (hasUsablePO || customerBuffer !== null)) {
        const poDataList: POData[] = results
          .filter((r) => r.status === 'done' && r.data !== null)
          .map((r) => r.data!)

        // CRITICAL: Filter POs by factory code BEFORE reconciling (Pitfall 3)
        // All items in a real PO share the same factory code — use items[0]
        // RR01 = 东莞 (DG); RR02 = 印尼RRI (ID); RR03 = 印尼RRM (RRM).
        // RRI and RRM share the same 印尼排期 workbook but live on separate sheets
        // (KIK总排期 / RRM总排期); each reconciles against its own sheet and gets
        // its own annotated output in its own ZIP folder.
        const dgPOs = poDataList.filter((po) => po.items[0]?.factoryCode === 'RR01')
        const idPOs = poDataList.filter((po) => po.items[0]?.factoryCode === 'RR02')
        const rrmPOs = poDataList.filter((po) => po.items[0]?.factoryCode === 'RR03')

        try {
          let dgResult: ReconciliationResult | null = null
          let idResult: ReconciliationResult | null = null
          let rrmResult: ReconciliationResult | null = null
          let customerResult: CustomerScheduleReconciliationResult | null = null
          let dgExcel: Buffer | null = null
          let idExcel: Buffer | null = null
          let rrmExcel: Buffer | null = null
          let customerExcel: Buffer | null = null

          if (dgBuffer !== null && dgScheduleRows !== null && hasUsablePO) {
            dgResult = reconcile(dgPOs, dgScheduleRows)
            dgExcel = await writeAnnotatedSchedule(dgBuffer, dgResult, dgScheduleRows)
            response.reconciliationDg = buildReconciliationSummary(dgResult)
          }

          if (idBuffer !== null && idScheduleRows !== null && hasUsablePO) {
            // RR02 (RRI) → KIK总排期 sheet
            idResult = reconcile(idPOs, idScheduleRows)
            idExcel = await writeAnnotatedSchedule(idBuffer, idResult, idScheduleRows, 'KIK总排期')
            response.reconciliationId = buildReconciliationSummary(idResult)

            // RR03 (RRM) → RRM总排期 sheet, separate annotated output
            if (rrmScheduleRows !== null) {
              rrmResult = reconcile(rrmPOs, rrmScheduleRows)
              rrmExcel = await writeAnnotatedSchedule(idBuffer, rrmResult, rrmScheduleRows, 'RRM总排期')
              response.reconciliationRrm = buildReconciliationSummary(rrmResult)
            }
          }


          if (customerBuffer !== null && customerScheduleRows !== null) {
            customerResult = reconcileCustomerSchedule(customerScheduleRows, {
              dg: dgScheduleRows,
              id: idScheduleRows,
              rrm: rrmScheduleRows,
            })
            customerExcel = await writeAnnotatedCustomerSchedule(customerBuffer, customerResult)
            response.reconciliationCustomer = buildCustomerReconciliationSummary(customerResult)
          }

          // Build summary report and ZIP
          const summaryText = buildSummaryReport(
            dgResult ?? emptyResult,
            idResult ?? emptyResult,
            rrmResult ?? emptyResult,
            customerResult,
          )

          const zipEntries: Array<{ name: string; buffer: Buffer }> = []
          if (dgExcel) zipEntries.push({ name: 'DG/东莞排期核对结果.xlsx', buffer: dgExcel })
          if (idExcel) zipEntries.push({ name: 'ID/印尼排期核对结果.xlsx', buffer: idExcel })
          if (rrmExcel) zipEntries.push({ name: 'RRM/印尼排期核对结果.xlsx', buffer: rrmExcel })
          if (customerExcel) zipEntries.push({ name: '客户排期/客户排期核对结果.xlsx', buffer: customerExcel })

          // Add original PO PDFs to their factory folders
          for (const po of poBuffers) {
            if (po.factoryCode === 'RR01') {
              appendUniqueEntry(zipEntries, 'DG/PO', po.filename, po.buffer)
            } else if (po.factoryCode === 'RR02') {
              appendUniqueEntry(zipEntries, 'ID/PO', po.filename, po.buffer)
            } else if (po.factoryCode === 'RR03') {
              appendUniqueEntry(zipEntries, 'RRM/PO', po.filename, po.buffer)
            }
          }

          zipEntries.push({ name: '核对汇总报告.txt', buffer: Buffer.from(summaryText, 'utf-8') })

          // Check the uncompressed output inputs before allocating the ZIP as well as
          // the exact finished batch; never discard an earlier user's valid token.
          outputStore.assertCapacity(zipEntries.reduce((sum, entry) => sum + entry.buffer.byteLength, 0)
            + (customerExcel?.byteLength ?? 0), customerExcel ? 2 : 1)
          const zipBuffer = await buildZipBuffer(zipEntries)
          const outputs = [{ buffer: zipBuffer, contentType: 'application/zip', filename: 'TOMY_reconciliation.zip' }]
          if (customerExcel) outputs.push({ buffer: customerExcel,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: '客户排期核对结果.xlsx' })
          if (req.aborted || res.destroyed) return
          const [sessionId, customerSessionId] = outputStore.publish(outputs)
          response.outputReady = true
          response.sessionId = sessionId
          if (customerSessionId) response.customerSessionId = customerSessionId
        } catch (err) {
          // Reconciliation failure is non-fatal: still return parse results
          const errMsg = err instanceof Error ? err.message : 'Reconciliation failed'
          if (err instanceof OutputCapacityError) {
            res.status(503).json({ error: errMsg })
            return
          }
          const emptyErrorSummary: ReconciliationSummary = {
            matchedCount: 0, unmatchedCount: 0, ambiguousCount: 0,
            mismatchedFieldCount: 0, errors: [errMsg],
            details: { matched: [], unmatched: [] },
          }
          if (dgBuffer !== null) response.reconciliationDg = { ...emptyErrorSummary }
          if (idBuffer !== null) response.reconciliationId = { ...emptyErrorSummary }
          if (idBuffer !== null) response.reconciliationRrm = { ...emptyErrorSummary }
          if (customerBuffer !== null) response.reconciliationCustomer = { ...emptyErrorSummary }
          response.outputReady = false
        }
      }

      if (customerBuffer !== null && dgBuffer === null && idBuffer === null) {
        response.reconciliationCustomer = {
          ...buildCustomerReconciliationSummary({ matched: [], unmatchedRows: [], ambiguousRows: [], errors: [] }),
          errors: ['客户排期核对需要至少一份可读取的东莞或印尼工厂排期表，请检查上传文件后重试'],
        }
        response.outputReady = false
      } else if ((scheduleCustomerFiles.length > 0 && customerBuffer === null && !hasUsablePO)
        || (poFiles.length > 0 && !hasUsablePO && customerBuffer === null)) {
        response.outputReady = false
      }
      if (res.destroyed) return
      res.setHeader('Cache-Control', 'no-store')
      res.json(response)
    } finally { admission.release(req) }
  }
)

// GET /api/download/:sessionId - returns the ZIP archive
router.get('/download/:sessionId', (req, res) => {
  const { sessionId } = req.params
  const entry = outputStore.get(sessionId)

  if (!entry) {
    res.status(404).json({ error: 'Session not found or expired' })
    return
  }

  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Type', entry.contentType)
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
  )
  res.send(entry.buffer)
})

// Multer limits must be JSON errors rather than an HTML/stack response.
router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  admission.release(_req)
  if (res.headersSent || res.destroyed) return
  if (error instanceof UploadLimitError) {
    res.status(413).json({ error: error.message })
    return
  }
  if (error instanceof multer.MulterError) {
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: error.code === 'LIMIT_FILE_SIZE' ? '单个文件不能超过 25 MB，请缩小文件后重试' : '上传文件字段或数量不符合要求，请重新选择文件',
    })
    return
  }
  next(error)
})

export { router as uploadRouter }
