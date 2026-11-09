// Frozen validator from the pre-fix JSON importer; no business data.
function _backupValidate(parsed) {
  /* 支持两种格式：
     1. { version, records: [...] }  — 本系统导出格式
     2. [...]                        — 直接数组（简单兼容）
  */
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.records) ? parsed.records : null);

  if (!arr) return '文件不是有效的 JSON 数组或备份包';
  if (arr.length === 0) return '备份文件中没有记录（空数组）';

  /* 检查必要字段：至少80%的记录要有 date 和 supplier */
  const REQUIRED = ['date', 'supplier'];
  const validCount = arr.filter(r =>
    r && typeof r === 'object' &&
    REQUIRED.every(f => r[f] != null && String(r[f]).trim() !== '')
  ).length;

  if (validCount / arr.length < 0.8) {
    return `缺少必填字段（date / supplier），仅 ${validCount}/${arr.length} 条记录有效`;
  }

  return null;   /* 通过 */
}
