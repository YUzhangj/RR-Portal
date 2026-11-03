// Leave room for multipart headers below the deployed gateway's 50 MiB limit.
const VERIFICATION_UPLOAD_BYTES = 49 * 1024 * 1024;
function handleVerificationUpload(handler) {
  return (req, res, next) => handler(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '核价导入文件过大，最大支持 49 MiB；请缩小文件后重试' });
    if (error.code === 'LEGACY_WORKBOOK_TYPE') return res.status(400).json({ error: error.message });
    if (String(error.code || '').startsWith('LIMIT_')) return res.status(400).json({ error: '核价导入字段过多或格式不正确' });
    return next(error);
  });
}
module.exports = { VERIFICATION_UPLOAD_BYTES, handleVerificationUpload };
