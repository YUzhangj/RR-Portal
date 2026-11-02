import fs from 'fs'
import path from 'path'
import vm from 'vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../client/src/App.tsx'), 'utf8')
const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let handler = ''
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleSubmit' && node.initializer) {
    handler = ts.transpileModule('(' + node.initializer.getText(tree) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  }
  ts.forEachChild(node, visit)
}
visit(tree)
const id = '10551055-1055-4055-8055-105510551055'
const selected = (name: string) => [{ originFileObj: new File(['synthetic'], name) }]

function fixture(files: Record<string, unknown>, result: Record<string, unknown>) {
  const calls: Array<{ url: string; body: FormData }> = [], downloads: unknown[][] = [], results: unknown[] = [], errors: unknown[] = [], warnings: string[] = []
  const scope = vm.createContext({ FormData, File, MAX_TOTAL_UPLOAD_BYTES: 50 * 1024 * 1024, ...{ poFiles: [], scheduleDgFile: [], scheduleIdFile: [], scheduleCustomerFile: [] }, ...files,
    message: { warning: (value: string) => warnings.push(value) }, setLoading: () => {}, setResult: (value: unknown) => results.push(value), setError: (value: unknown) => errors.push(value),
    responseError: async () => Error('synthetic rejected'), downloadResult: async (...values: unknown[]) => downloads.push(values),
    fetch: async (url: string, init: { body: FormData }) => { calls.push({ url, body: init.body }); return { ok: true, json: async () => result } },
  })
  return { submit: vm.runInContext(handler, scope) as () => Promise<void>, calls, downloads, results, errors, warnings }
}

describe('actual client submit handler', () => {
  it('blocks missing source and missing factory combinations without sending requests', async () => {
    for (const files of [{}, { scheduleDgFile: selected('factory.xlsx') }, { scheduleCustomerFile: selected('customer.dat') }]) {
      const f = fixture(files, {}); await f.submit()
      expect(f.calls).toHaveLength(0); expect(f.warnings).toHaveLength(1)
    }
  })
  it('posts customer and factory fields below the current portal prefix, prioritizes direct XLSX, and keeps the result for retry', async () => {
    const result = { files: [], customerSessionId: id, sessionId: id, outputReady: true }
    const f = fixture({ scheduleCustomerFile: selected('customer.dat'), scheduleDgFile: selected('factory.xlsx') }, result)
    await f.submit()
    expect(f.calls[0].url).toBe('./api/process')
    expect([...f.calls[0].body.keys()]).toEqual(['poNames', 'scheduleDg', 'scheduleDgName', 'scheduleCustomer', 'scheduleCustomerName'])
    expect(f.calls[0].body.get('scheduleCustomerName')).toBe('customer.dat')
    expect(f.downloads).toEqual([[id, '客户排期核对结果.xlsx', true]])
    expect(f.results).toEqual([null, result])
  })
  it('retains the original PO multipart fields and automatic ZIP flow', async () => {
    const f = fixture({ poFiles: selected('PO.pdf'), scheduleIdFile: selected('factory.xlsx') }, { outputReady: true, sessionId: id })
    await f.submit()
    expect([...f.calls[0].body.keys()]).toEqual(['pos', 'poNames', 'scheduleId', 'scheduleIdName'])
    expect(f.calls[0].body.get('poNames')).toBe('["PO.pdf"]')
    expect(f.downloads).toEqual([[id, 'TOMY_核对结果.zip', true]])
  })
})
