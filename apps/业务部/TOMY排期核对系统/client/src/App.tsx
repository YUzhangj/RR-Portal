import { useState } from 'react'
import { Button, Upload, App as AntApp, Card, Alert, Table, Space, Typography } from 'antd'
import {
  UploadOutlined,
  InboxOutlined,
  DownloadOutlined,
  FileTextOutlined,
} from '@ant-design/icons'
import type { UploadFile } from 'antd'
import { colors } from './theme'
import FileStatusList from './components/FileStatusList'
import { downloadArtifact, responseError } from './lib/download'
import { uploadProblem, MAX_TOTAL_UPLOAD_BYTES } from './lib/uploadValidation'

const { Text } = Typography

// ─── Types (mirrors server/types/index.ts) ────────────────────────────────

interface POItem {
  货号: string
  PO走货期: string
  数量: number
  factoryCode: string
  外箱: number | null
}

interface POData {
  tomyPO: string
  customerPO: string
  handleBy: string
  customerName: string
  destCountry: string
  items: POItem[]
  sourceFile: string
}

interface FileResult {
  filename: string
  status: 'done' | 'error'
  data: POData | null
  error?: string
}

interface ScheduleResult {
  filename: string
  status: 'done' | 'error'
  rowCount: number
  error?: string
}

interface MatchDetail {
  tomyPO: string
  货号: string
  sourceFile: string
  mismatches: Array<{ field: string; scheduleValue: unknown; poValue: unknown }>
}

interface UnmatchedDetail {
  tomyPO: string
  货号: string
  sourceFile: string
}

interface ReconciliationSummary {
  matchedCount: number
  unmatchedCount: number
  ambiguousCount: number
  mismatchedFieldCount: number
  errors: string[]
  details: {
    matched: MatchDetail[]
    unmatched: UnmatchedDetail[]
    ambiguous?: Array<UnmatchedDetail & { count: number }>
  }
}

interface ProcessResponse {
  files: FileResult[]
  scheduleDg: ScheduleResult | null
  scheduleId: ScheduleResult | null
  scheduleCustomer: ScheduleResult | null
  reconciliationDg?: ReconciliationSummary
  reconciliationId?: ReconciliationSummary
  reconciliationRrm?: ReconciliationSummary
  reconciliationCustomer?: ReconciliationSummary
  outputReady?: boolean
  sessionId?: string
  customerSessionId?: string
}

// ─── Section container with eyebrow label ─────────────────────────────────

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="section-label">{label}</div>
      {children}
    </section>
  )
}

// ─── Reconciliation result card ───────────────────────────────────────────

function ReconciliationCard({
  title,
  reconciliation,
  customer = false,
}: {
  title: string
  reconciliation: ReconciliationSummary
  customer?: boolean
}) {
  const { details } = reconciliation

  const tableData = [
    ...details.matched.map((m, i) => ({
      key: `m-${i}`,
      tomyPO: m.tomyPO,
      货号: m.货号,
      sourceFile: m.sourceFile,
      status: (m.mismatches.length > 0 ? 'mismatch' : 'ok') as 'mismatch' | 'ok',
      mismatches: m.mismatches,
    })),
    ...details.unmatched.map((u, i) => ({
      key: `u-${i}`,
      tomyPO: u.tomyPO,
      货号: u.货号,
      sourceFile: u.sourceFile,
      status: 'unmatched' as const,
      mismatches: [] as MatchDetail['mismatches'],
    })),
    ...(details.ambiguous ?? []).map((entry, i) => ({
      key: `a-${i}`,
      tomyPO: entry.tomyPO,
      货号: entry.货号,
      sourceFile: entry.sourceFile,
      status: 'ambiguous' as const,
      mismatches: [] as MatchDetail['mismatches'],
    })),
  ]

  const columns = [
    {
      title: 'TOMY PO',
      dataIndex: 'tomyPO',
      key: 'tomyPO',
      width: 130,
      render: (v: string) => <span className="num">{v}</span>,
    },
    {
      title: '货号',
      dataIndex: '货号',
      key: '货号',
      width: 110,
      render: (v: string) => <span className="num">{v}</span>,
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_: unknown, record: (typeof tableData)[0]) => {
        if (record.status === 'ok') return <span className="status-chip ok">匹配</span>
        if (record.status === 'mismatch') return <span className="status-chip warn">有差异</span>
        if (record.status === 'ambiguous') return <span className="status-chip warn">待确认</span>
        return <span className="status-chip err">未找到</span>
      },
    },
    {
      title: '差异详情',
      key: 'mismatches',
      render: (_: unknown, record: (typeof tableData)[0]) => {
        if (record.mismatches.length === 0) {
          if (record.status === 'ambiguous') return <Text type="warning">工厂排期存在多条候选，请确认后重新核对</Text>
          return record.status === 'unmatched' ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              排期表中无对应行
            </Text>
          ) : (
            <Text type="secondary">—</Text>
          )
        }
        return (
          <Space direction="vertical" size={2} style={{ lineHeight: 1.5 }}>
            {record.mismatches.map((mm, i) => (
              <Text key={i} style={{ fontSize: 12 }}>
                <Text strong style={{ color: colors.ink2 }}>{mm.field}</Text>
                ：{customer ? '客户排期' : '排期'}
                <Text code style={{ fontSize: 11, padding: '1px 5px' }}>
                  {String(mm.scheduleValue ?? '空')}
                </Text>
                {'　'}{customer ? '工厂排期/规则' : 'PO'}
                <Text code style={{ fontSize: 11, padding: '1px 5px' }}>
                  {String(mm.poValue ?? '空')}
                </Text>
              </Text>
            ))}
          </Space>
        )
      },
    },
  ]

  const hasIssues = reconciliation.unmatchedCount > 0 || reconciliation.mismatchedFieldCount > 0
    || reconciliation.ambiguousCount > 0 || reconciliation.errors.length > 0

  return (
    <Card title={title} size="small">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space size="large" wrap>
          <span className="stat">
            <span className={`stat-num ${hasIssues ? '' : 'ok'}`}>
              {reconciliation.matchedCount}
            </span>
            <span className="stat-label">项匹配</span>
          </span>
          <span className="stat">
            <span className={`stat-num ${reconciliation.mismatchedFieldCount > 0 ? 'warn' : ''}`}>
              {reconciliation.mismatchedFieldCount}
            </span>
            <span className="stat-label">字段不匹配</span>
          </span>
          <span className="stat">
            <span className={`stat-num ${reconciliation.unmatchedCount > 0 ? 'err' : ''}`}>
              {reconciliation.unmatchedCount}
            </span>
            <span className="stat-label">项未找到</span>
          </span>
          {reconciliation.ambiguousCount > 0 && <span className="stat">
            <span className="stat-num warn">{reconciliation.ambiguousCount}</span>
            <span className="stat-label">项待确认</span>
          </span>}
        </Space>

        {reconciliation.errors.length > 0 && (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {reconciliation.errors.map((e, i) => (
              <Alert key={i} message={e} type="error" showIcon />
            ))}
          </Space>
        )}

        {tableData.length > 0 && (
          <Table
            dataSource={tableData}
            columns={columns}
            size="small"
            pagination={false}
            scroll={{ x: 640 }}
          />
        )}
      </Space>
    </Card>
  )
}

// ─── PO classification + stats card ───────────────────────────────────────

function PoClassificationCard({
  result,
}: {
  result: ProcessResponse
}) {
  const totalCount = result.files.length
  const successCount = result.files.filter((f) => f.status === 'done').length
  const errorCount = result.files.filter((f) => f.status === 'error').length

  const dgPOs = result.files.filter((f) => f.data?.items[0]?.factoryCode === 'RR01')
  const idPOs = result.files.filter((f) => f.data?.items[0]?.factoryCode === 'RR02')
  const rrmPOs = result.files.filter((f) => f.data?.items[0]?.factoryCode === 'RR03')
  const unknownPOs = result.files.filter((f) => {
    if (f.status === 'error') return true
    const fc = f.data?.items[0]?.factoryCode
    return fc !== 'RR01' && fc !== 'RR02' && fc !== 'RR03'
  })

  return (
    <Card size="small" title="PO 文件分类">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space size="large" wrap>
          <span className="stat">
            <span className="stat-num">{totalCount}</span>
            <span className="stat-label">总数</span>
          </span>
          <span className="stat">
            <span className="stat-num ok">{successCount}</span>
            <span className="stat-label">解析成功</span>
          </span>
          {errorCount > 0 && (
            <span className="stat">
              <span className="stat-num err">{errorCount}</span>
              <span className="stat-label">失败</span>
            </span>
          )}
        </Space>

        {dgPOs.length > 0 && (
          <div>
            <div style={{ fontSize: 13, color: colors.info, fontWeight: 500, marginBottom: 6 }}>
              东莞 RR01 · {dgPOs.length} 个
            </div>
            <div>
              {dgPOs.map((f, i) => (
                <span key={i} className="file-tag dg" title={f.filename}>
                  {f.filename}
                </span>
              ))}
            </div>
          </div>
        )}

        {idPOs.length > 0 && (
          <div>
            <div style={{ fontSize: 13, color: colors.purple, fontWeight: 500, marginBottom: 6 }}>
              印尼RRI RR02 · {idPOs.length} 个
            </div>
            <div>
              {idPOs.map((f, i) => (
                <span key={i} className="file-tag id" title={f.filename}>
                  {f.filename}
                </span>
              ))}
            </div>
          </div>
        )}

        {rrmPOs.length > 0 && (
          <div>
            <div style={{ fontSize: 13, color: colors.pink, fontWeight: 500, marginBottom: 6 }}>
              印尼RRM RR03 · {rrmPOs.length} 个
            </div>
            <div>
              {rrmPOs.map((f, i) => (
                <span key={i} className="file-tag id" title={f.filename}>
                  {f.filename}
                </span>
              ))}
            </div>
          </div>
        )}

        {unknownPOs.length > 0 && (
          <div>
            <div style={{ fontSize: 13, color: colors.warn, fontWeight: 500, marginBottom: 6 }}>
              未分类 · {unknownPOs.length} 个
            </div>
            <div>
              {unknownPOs.map((f, i) => (
                <span key={i} className="file-tag warn" title={f.filename}>
                  {f.filename}
                </span>
              ))}
            </div>
          </div>
        )}
      </Space>
    </Card>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────

function App() {
  const { message } = AntApp.useApp()
  const [poFiles, setPoFiles] = useState<UploadFile[]>([])
  const [scheduleDgFile, setScheduleDgFile] = useState<UploadFile[]>([])
  const [scheduleIdFile, setScheduleIdFile] = useState<UploadFile[]>([])
  const [scheduleCustomerFile, setScheduleCustomerFile] = useState<UploadFile[]>([])
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [result, setResult] = useState<ProcessResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const downloadResult = async (
    sessionId: string,
    filename: string,
    automatic = false,
  ) => {
    setDownloading(true)
    try {
      await downloadArtifact(sessionId, filename)
      if (automatic) message.success('核对完成，结果文件已开始下载')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '下载失败，请点击下载按钮重试')
    } finally {
      setDownloading(false)
    }
  }

  const beforeUpload = (kind: 'po' | 'factory' | 'customer') => (file: File) => {
    const problem = uploadProblem(file, kind)
    if (problem) { message.warning(problem); return Upload.LIST_IGNORE }
    return false
  }

  const handleSubmit = async () => {
    if (poFiles.length > 100) { message.warning('一次最多选择 100 个 PO PDF 文件'); return }
    if (poFiles.length === 0 && scheduleCustomerFile.length === 0) {
      message.warning('请选择 PO PDF 或客户排期表')
      return
    }
    if (scheduleDgFile.length === 0 && scheduleIdFile.length === 0) {
      message.warning('请至少选择一份东莞或印尼工厂排期表')
      return
    }

    const totalBytes = [...poFiles, ...scheduleDgFile, ...scheduleIdFile, ...scheduleCustomerFile]
      .reduce((sum, file) => sum + (file.originFileObj?.size ?? 0), 0)
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) { message.warning('单次上传总量不能超过 50 MB，请分批核对'); return }

    setLoading(true)
    setResult(null)
    setError(null)

    const formData = new FormData()
    const poNames: string[] = []
    poFiles.forEach((file) => {
      if (file.originFileObj) {
        formData.append('pos', file.originFileObj)
        poNames.push(file.originFileObj.name)
      }
    })
    formData.append('poNames', JSON.stringify(poNames))

    if (scheduleDgFile[0]?.originFileObj) {
      formData.append('scheduleDg', scheduleDgFile[0].originFileObj)
      formData.append('scheduleDgName', scheduleDgFile[0].originFileObj.name)
    }
    if (scheduleIdFile[0]?.originFileObj) {
      formData.append('scheduleId', scheduleIdFile[0].originFileObj)
      formData.append('scheduleIdName', scheduleIdFile[0].originFileObj.name)
    }
    if (scheduleCustomerFile[0]?.originFileObj) {
      formData.append('scheduleCustomer', scheduleCustomerFile[0].originFileObj)
      formData.append('scheduleCustomerName', scheduleCustomerFile[0].originFileObj.name)
    }

    try {
      const response = await fetch('./api/process', {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        throw await responseError(response, '服务器返回错误')
      }
      const data = (await response.json()) as ProcessResponse
      setResult(data)
      if (data.customerSessionId) {
        await downloadResult(data.customerSessionId, '客户排期核对结果.xlsx', true)
      } else if (data.outputReady && data.sessionId) {
        await downloadResult(data.sessionId, 'TOMY_核对结果.zip', true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  const handleDownload = async () => {
    if (!result?.sessionId) return
    await downloadResult(result.sessionId, 'TOMY_核对结果.zip')
  }

  const handleCustomerDownload = async () => {
    if (!result?.customerSessionId) return
    await downloadResult(result.customerSessionId, '客户排期核对结果.xlsx')
  }

  const schedules: ScheduleResult[] = []
  if (result?.scheduleDg) schedules.push(result.scheduleDg)
  if (result?.scheduleId) schedules.push(result.scheduleId)
  if (result?.scheduleCustomer) schedules.push(result.scheduleCustomer)

  return (
    <main className="page stack">
      <header className="page-head">
        <div className="eyebrow">业务部 · TOMY</div>
        <h1>排期核对</h1>
        <p className="subtitle">
          上传 TOMY PO PDF、客户排期与东莞／印尼排期，自动核对并下载标注结果。
        </p>
      </header>

      <Section label="PO 文件">
        <Card size="small">
          <div className="drop-zone">
            <Upload.Dragger
              multiple
              accept=".pdf"
              beforeUpload={beforeUpload('po')}
              disabled={loading}
              fileList={poFiles}
              onChange={({ fileList }) => setPoFiles(fileList)}
              showUploadList={{ showPreviewIcon: false }}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">把 PO PDF 文件拖到这里</p>
              <p className="ant-upload-hint">或点击选择文件 · 支持多选 .pdf</p>
            </Upload.Dragger>
          </div>
        </Card>
      </Section>

      <Section label="东莞排期表">
        <Card size="small">
          <Upload
            accept=".xlsx,.xls"
            maxCount={1}
            beforeUpload={beforeUpload('factory')}
            disabled={loading}
            fileList={scheduleDgFile}
            onChange={({ fileList }) => setScheduleDgFile(fileList)}
          >
            <Button icon={<FileTextOutlined />}>选择东莞排期表 Excel</Button>
          </Upload>
          <p className="meta">单文件 · .xlsx 或 .xls · 对应工厂代码 RR01</p>
        </Card>
      </Section>

      <Section label="印尼排期表">
        <Card size="small">
          <Upload
            accept=".xlsx,.xls"
            maxCount={1}
            beforeUpload={beforeUpload('factory')}
            disabled={loading}
            fileList={scheduleIdFile}
            onChange={({ fileList }) => setScheduleIdFile(fileList)}
          >
            <Button icon={<FileTextOutlined />}>选择印尼排期表 Excel</Button>
          </Upload>
          <p className="meta">单文件 · .xlsx 或 .xls · 含两个 sheet：KIK总排期(RR02/RRI)、RRM总排期(RR03/RRM)</p>
        </Card>
      </Section>

      <Section label="客户排期表">
        <Card size="small">
          <Upload
            accept=".xlsx,.xls,.dat"
            maxCount={1}
            beforeUpload={beforeUpload('customer')}
            disabled={loading}
            fileList={scheduleCustomerFile}
            onChange={({ fileList }) => setScheduleCustomerFile(fileList)}
          >
            <Button icon={<FileTextOutlined />}>选择客户排期表</Button>
          </Upload>
          <p className="meta">
            可选 · 支持 Excel 及微信下载的 .dat 文件 · 重点核对红色字段、单价/金额与 QC 状态
          </p>
        </Card>
      </Section>

      <Button
        type="primary"
        icon={<UploadOutlined />}
        onClick={handleSubmit}
        loading={loading}
        disabled={downloading}
        size="large"
        block
        style={{ height: 44 }}
      >
        上传并核对
      </Button>

      {error && (
        <Alert
          message="请求失败"
          description={error}
          type="error"
          showIcon
          closable
          onClose={() => setError(null)}
        />
      )}

      {result && (
        <Section label="核对结果">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {result.files.length > 0 && <PoClassificationCard result={result} />}

            {result.reconciliationDg && (
              <ReconciliationCard
                title="东莞 (RR01) 核对结果"
                reconciliation={result.reconciliationDg}
              />
            )}

            {result.reconciliationId && (
              <ReconciliationCard
                title="印尼RRI (RR02) 核对结果"
                reconciliation={result.reconciliationId}
              />
            )}

            {result.reconciliationRrm && (
              <ReconciliationCard
                title="印尼RRM (RR03) 核对结果"
                reconciliation={result.reconciliationRrm}
              />
            )}

            {result.reconciliationCustomer && (
              <ReconciliationCard
                title="客户排期核对结果"
                reconciliation={result.reconciliationCustomer}
                customer
              />
            )}

            {result.customerSessionId && (
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={handleCustomerDownload}
                loading={downloading}
                size="large"
                block
                style={{ height: 44 }}
              >
                下载客户排期标注结果 Excel
              </Button>
            )}

            {result.outputReady && result.sessionId && (
              <Button
                type="default"
                icon={<DownloadOutlined />}
                onClick={handleDownload}
                loading={downloading}
                size="large"
                block
                style={{ height: 44 }}
              >
                下载核对结果 ZIP
              </Button>
            )}

            {(result.sessionId || result.customerSessionId) && <p className="meta">
              结果文件可在生成后 30 分钟内重复下载；服务更新后需重新核对。
            </p>}
            <FileStatusList files={result.files} schedules={schedules} />
          </Space>
        </Section>
      )}
    </main>
  )
}

export default App
