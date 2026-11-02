export async function responseError(response: Response, action: string): Promise<Error> {
  let detail = ''
  if (response.headers.get('content-type')?.includes('application/json')) {
    const data: unknown = await response.json().catch(() => null)
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
      detail = data.error.slice(0, 500)
    }
  }
  if (!detail && response.status === 413) detail = '上传文件过大：单文件最多 25 MB，单次总量最多 50 MB，请缩小文件或分批核对'
  return new Error(detail || `${action}: ${response.status} ${response.statusText}`)
}

/** Keep the portal subpath, validate artifact type, and release the local Blob URL. */
export async function downloadArtifact(sessionId: string, filename: string): Promise<void> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId)) {
    throw new Error('下载标识无效，请重新核对后下载')
  }
  const response = await fetch(`./api/download/${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
  if (response.status === 404) throw new Error('下载已过期或服务已更新，请重新上传核对后下载')
  if (!response.ok) throw await responseError(response, '下载失败')
  const expected = filename.endsWith('.xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'application/zip'
  if (response.headers.get('content-type')?.split(';')[0] !== expected) {
    throw new Error('下载返回的文件类型不正确，请重新核对后重试')
  }
  const blob = await response.blob()
  if (blob.size === 0) throw new Error('结果文件为空，请重新核对后重试')
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  try {
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    URL.revokeObjectURL(url)
  }
}
