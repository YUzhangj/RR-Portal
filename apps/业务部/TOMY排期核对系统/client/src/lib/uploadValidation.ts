export const MAX_TOTAL_UPLOAD_BYTES = 50 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export function uploadProblem(file: { name: string; size: number }, kind: 'po' | 'factory' | 'customer'): string | null {
  const allowed = kind === 'po' ? /\.pdf$/i : kind === 'customer' ? /\.(xlsx|xls|dat)$/i : /\.(xlsx|xls)$/i
  if (!allowed.test(file.name)) return kind === 'po' ? 'PO 文件请选择 PDF' : '排期表格式不正确，请重新选择 Excel 文件'
  if (file.size === 0) return '文件为空，请重新选择'
  if (file.size > MAX_UPLOAD_BYTES) return '单个文件不能超过 25 MB，请缩小文件后重试'
  return null
}
