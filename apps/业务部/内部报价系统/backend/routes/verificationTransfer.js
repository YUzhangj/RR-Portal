const express = require('express');
const multer = require('multer');
const { gunzipSync } = require('node:zlib');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { planTransfer, applyTransfer } = require('../services/verificationTransfer');
const { VERIFICATION_UPLOAD_BYTES, handleVerificationUpload } = require('../services/verificationUpload');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: VERIFICATION_UPLOAD_BYTES, fieldSize: 1024, fields: 4, files: 1, parts: 6 } });
router.use(requireAuth, (req, res, next) => req.user.perms?.['账号管理']?.can_admin
  ? next() : res.status(403).json({ error: '只有系统管理员可以导入客户核价资料' }));
router.post('/', handleVerificationUpload(upload.single('file')), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择核价导入包' });
    let bundle;
    try {
      const buffer = req.file.buffer;
      const bytes = buffer[0] === 0x1f && buffer[1] === 0x8b
        ? gunzipSync(buffer, { maxOutputLength: 160 * 1024 * 1024 }) : buffer;
      bundle = JSON.parse(bytes.toString('utf8'));
    } catch { return res.status(400).json({ error: '导入包不是有效的 JSON 或 GZIP 文件' }); }
    const options = { factoryCode: req.user.active_factory_code, actor: req.user.name || req.user.username };
    res.json(req.body.apply === '1'
      ? await applyTransfer(db, bundle, { ...options, expectedToken: req.body.token })
      : await planTransfer(db, bundle, options.factoryCode));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});
module.exports = router;
