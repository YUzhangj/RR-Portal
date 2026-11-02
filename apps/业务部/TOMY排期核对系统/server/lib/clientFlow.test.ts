import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadArtifact, responseError } from '../../client/src/lib/download.js'
import { uploadProblem, MAX_UPLOAD_BYTES } from '../../client/src/lib/uploadValidation.js'

const id = '10551055-1055-4055-8055-105510551055'
afterEach(() => vi.unstubAllGlobals())

describe('client upload and artifact boundaries', () => {
  it('checks empty/oversized/wrong-type files without excluding genuine renamed Excel .dat inputs', () => {
    expect(uploadProblem({ name: 'a.dat', size: 10 }, 'customer')).toBeNull()
    expect(uploadProblem({ name: 'a.XLSX', size: MAX_UPLOAD_BYTES }, 'factory')).toBeNull()
    expect(uploadProblem({ name: 'a.dat', size: 10 }, 'factory')).toContain('格式')
    expect(uploadProblem({ name: 'a.pdf', size: 0 }, 'po')).toContain('为空')
    expect(uploadProblem({ name: 'a.pdf', size: MAX_UPLOAD_BYTES + 1 }, 'po')).toContain('25 MB')
    expect(uploadProblem({ name: 'a.exe', size: 10 }, 'po')).toContain('PDF')
  })

  it('keeps relative API URLs, validates XLSX bytes type, and always removes local Blob handles', async () => {
    const events: unknown[] = []
    const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', { createElement: () => link, body: { appendChild: (item: unknown) => events.push(item) } })
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-only')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: unknown) => {
      events.push([url, init])
      return new Response('fixture', { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
    }))
    await downloadArtifact(id, '客户排期核对结果.xlsx')
    expect(events[0]).toEqual([`./api/download/${id}`, { cache: 'no-store' }])
    expect(link.download).toBe('客户排期核对结果.xlsx')
    expect(link.click).toHaveBeenCalledOnce(); expect(link.remove).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:synthetic-only')
    create.mockRestore(); revoke.mockRestore()
  })

  it('does not save an HTML login/error response as an Excel or accept a path-like download token', async () => {
    const fetch = vi.fn(async () => new Response('<html>synthetic login</html>', { headers: { 'Content-Type': 'text/html' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(downloadArtifact(id, '结果.xlsx')).rejects.toThrow('类型不正确')
    await expect(downloadArtifact('../other', '结果.zip')).rejects.toThrow('标识无效')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shows a bounded server JSON failure and preserves the option to retry', async () => {
    const error = await responseError(new Response(JSON.stringify({ error: '结果缓存暂时已满，请稍后重试' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }), '上传失败')
    expect(error.message).toContain('缓存暂时已满')
    const html = await responseError(new Response('<html>private internals</html>', { status: 502 }), '下载失败')
    expect(html.message).toContain('502'); expect(html.message).not.toContain('private internals')
  })

  it('explains expired/restarted downloads and an upstream upload-size error without exposing an HTML body', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } }))
    await expect(downloadArtifact(id, '结果.xlsx')).rejects.toThrow('已过期或服务已更新')
    const error = await responseError(new Response('<html>proxy internals</html>', { status: 413 }), '服务器返回错误')
    expect(error.message).toContain('50 MB'); expect(error.message).not.toContain('proxy internals')
  })

  it('releases Blob handles even if the browser rejects the programmatic download', async () => {
    const remove = vi.fn()
    vi.stubGlobal('document', { createElement: () => ({ remove, click: () => { throw Error('synthetic blocked') } }), body: { appendChild: () => {} } })
    vi.stubGlobal('fetch', async () => new Response('zip', { headers: { 'Content-Type': 'application/zip' } }))
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-blocked')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    await expect(downloadArtifact(id, '结果.zip')).rejects.toThrow('synthetic blocked')
    expect(remove).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:synthetic-blocked')
    create.mockRestore(); revoke.mockRestore()
  })
})
