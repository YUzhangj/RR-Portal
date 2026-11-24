const express = require('express');
const db = require('../db');
const { requireAuth, quoteAccess, hasMenuPermission } = require('../middleware/auth');
const { quoteFrozen, quoteWriteRoute } = require('../services/quoteFreeze');
const { buildWorkbook } = require('../services/exportInternal');
const { buildOutputWorkbook } = require('../services/nexusOutputTemplate');
const { overrideNumericValue } = require('../services/outputWorkbookOverrides');
const { outputCellUpdate } = require('../services/outputCellCalculation');
const { inferOutputSourceDepartment } = require('../services/outputSourceDepartment');
const { syncOutputValueToSource } = require('../services/outputSourceSync');
const { serializeWorkbook } = require('../services/workbookPreview');
const { buildSewingTemplateWorkbook } = require('../services/exportSewingTemplate');
const { exportVQ } = require('../services/exportVQ');
const { translateSectionsForVq } = require('../services/vqTranslate');
const { vqCustomerProfile } = require('../services/customerProfiles');

const router = express.Router();
router.use(requireAuth);

const loadOutputOverrides = quoteId => db.prepare(
  `SELECT sheet_name, cell_address, value_json, updated_by, updated_at
   FROM quote_output_overrides WHERE quote_id = ? ORDER BY sheet_name, cell_address`
).all(quoteId);

const loadOutputSections = quoteId => db.prepare(
  `SELECT s.dept, d.name_cn, s.payload_json, s.reviewed_by, s.reviewed_at, s.status
   FROM quote_sections s JOIN departments d ON d.code = s.dept
   WHERE s.quote_id = ? ORDER BY d.sort_order`
).all(quoteId);

// GET /api/quotes/:id/output-layout — 使用最终导出工作簿生成同版预览。
// 预览不要求全部部门已审，方便在填写过程中检查；真正下载仍沿用受控导出规则。
router.get('/:id/output-layout', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const id = Number(req.params.id);
  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!quote) return res.status(404).json({ error: '不存在' });
  const acc = await quoteAccess(req.user, id);
  if (acc.status !== 200) {
    return res.status(acc.status).json({ error: acc.status === 404 ? '不存在' : '无权查看该客户的报价单' });
  }

  let sections = await loadOutputSections(id);
  let overrides = await loadOutputOverrides(id);
  const totalDepts = Number((await db.prepare('SELECT COUNT(*) AS n FROM departments').get()).n);
  const isFrozen = await quoteFrozen(db, id);

  try {
    let workbook = await buildOutputWorkbook({ quote, sections, overrides });
    let synchronizedSource = false;
    if (!isFrozen) {
      for (const override of overrides) {
        let value;
        try { value = JSON.parse(override.value_json); }
        catch (_) { continue; }
        const numericValue = overrideNumericValue(value);
        if (numericValue === null) continue;
        const synchronized = await syncOutputValueToSource(
          db, id, workbook, override.sheet_name, String(override.cell_address || '').toUpperCase(), numericValue
        );
        synchronizedSource ||= Boolean(synchronized);
      }
    }
    if (synchronizedSource) {
      sections = await loadOutputSections(id);
      overrides = await loadOutputOverrides(id);
      workbook = await buildOutputWorkbook({ quote, sections, overrides });
    }
    if (!isFrozen) {
      const affectedDepartments = [...new Set(overrides.map(row => inferOutputSourceDepartment(
        workbook, row.sheet_name, String(row.cell_address || '').toUpperCase()
      )))];
      for (const department of affectedDepartments) {
        await db.prepare(`UPDATE quote_sections SET
          status = CASE WHEN status = 'approved' THEN 'filled' ELSE status END,
          reviewed_by = NULL,
          reviewed_at = NULL
          WHERE quote_id = ? AND dept = ?`).run(id, department);
      }
      if (affectedDepartments.length) {
        await db.prepare("UPDATE quotes SET status = 'drafting' WHERE id = ? AND status IN ('fully_approved', 'exported')").run(id);
      }
    }
    const approvedCount = Number((await db.prepare(
      "SELECT COUNT(*) AS n FROM quote_sections WHERE quote_id = ? AND status = 'approved'"
    ).get(id)).n);
    const sheets = serializeWorkbook(workbook, {
      editableCells: workbook.outputEditState.editable,
      overriddenCells: workbook.outputEditState.overridden,
    });
    const preferredOrder = new Map([['系统报价汇总', 0], ['报价明细', 1]]);
    sheets.sort((left, right) => (preferredOrder.get(left.name) ?? 99) - (preferredOrder.get(right.name) ?? 99));
    res.json({
      quote: {
        id: quote.id,
        quote_no: quote.quote_no,
        product_name: quote.product_name,
        customer: quote.customer,
        version: quote.version,
      },
      approved_count: approvedCount,
      total_departments: totalDepts,
      can_export: approvedCount >= totalDepts,
      // 已进入核价的报价仍可在“报价明细”内保存独立修正值；
      // 原部门填写、审核状态和核价版本都不会被这些修正值反向覆盖。
      can_edit_output: hasMenuPermission(req.user, '报价单详情', 'edit'),
      generated_at: new Date().toISOString(),
      sheets,
    });
  } catch (error) {
    console.error('[output-layout]', error);
    res.status(500).json({ error: '报价表格生成失败: ' + error.message });
  }
});

// PUT /api/quotes/:id/output-cell — 修改最终报价表的原始数值格。
// 只允许修改被公式引用的非公式数值，避免直接覆盖计算结果。
router.put('/:id/output-cell', quoteWriteRoute(db, req => Number(req.params.id), async (req, res) => {
  const id = Number(req.params.id);
  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!quote) return res.status(404).json({ error: '不存在' });
  const acc = await quoteAccess(req.user, id);
  if (acc.status !== 200) return res.status(acc.status).json({ error: acc.status === 404 ? '不存在' : '无权修改该报价单' });
  if (!hasMenuPermission(req.user, '报价单详情', 'edit')) return res.status(403).json({ error: '没有报价单编辑权限' });
  const isFrozen = await quoteFrozen(db, id);

  const sheetName = String(req.body?.sheet_name || '');
  const address = String(req.body?.cell_address || '').toUpperCase();
  if (!sheetName || sheetName.length > 31 || !/^[A-Z]{1,3}[1-9]\d*$/.test(address)) {
    return res.status(400).json({ error: '请提供有效的可编辑数值单元格' });
  }

  const sections = await loadOutputSections(id);
  const workbook = await buildOutputWorkbook({ quote, sections });
  if (!workbook.outputEditState.editable.has(`${sheetName}!${address}`)) {
    return res.status(400).json({ error: '该单元格是标题或公式结果，不能直接修改' });
  }
  const targetCell = workbook.getWorksheet(sheetName)?.getCell(address);
  const update = outputCellUpdate(req.body, targetCell);
  if (!update) return res.status(400).json({ error: '请输入有效的非负用量和单价' });
  const { value, storedValue } = update;

  await db.prepare(`INSERT INTO quote_output_overrides
    (quote_id, sheet_name, cell_address, value_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(quote_id, sheet_name, cell_address) DO UPDATE SET
      value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(id, sheetName, address, JSON.stringify(storedValue), req.user.name);
  const synchronized = isFrozen
    ? null
    : await syncOutputValueToSource(db, id, workbook, sheetName, address, value);
  const sourceDepartment = synchronized?.dept || inferOutputSourceDepartment(
    workbook, sheetName, address, String(req.body?.source_dept || '')
  );
  if (!isFrozen) {
    await db.prepare(`UPDATE quote_sections SET
      status = CASE WHEN status = 'approved' THEN 'filled' ELSE status END,
      reviewed_by = NULL,
      reviewed_at = NULL
      WHERE quote_id = ? AND dept = ?`).run(id, sourceDepartment);
    await db.prepare("UPDATE quotes SET status = 'drafting' WHERE id = ? AND status IN ('fully_approved', 'exported')").run(id);
  }
  await db.prepare(`INSERT INTO audit_log (quote_id, dept, actor, action, detail)
    VALUES (?, ?, ?, 'output_edit', ?)`)
    .run(id, sourceDepartment, req.user.name, JSON.stringify({
      sheet_name: sheetName, cell_address: address, value,
      ...(update.calculation ? { calculation: {
        quantity: update.calculation.quantity, unit_price: update.calculation.unitPrice,
      } } : {}),
      output_only: isFrozen,
    }));
  res.json({ ok: true, source_dept: sourceDepartment });
}));

router.delete('/:id/output-cell', quoteWriteRoute(db, req => Number(req.params.id), async (req, res) => {
  const id = Number(req.params.id);
  const acc = await quoteAccess(req.user, id);
  if (acc.status !== 200) return res.status(acc.status).json({ error: '无权修改该报价单' });
  if (!hasMenuPermission(req.user, '报价单详情', 'edit')) return res.status(403).json({ error: '没有报价单编辑权限' });
  const isFrozen = await quoteFrozen(db, id);
  const sheetName = String(req.body?.sheet_name || '');
  const address = String(req.body?.cell_address || '').toUpperCase();
  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(id);
  const sections = await loadOutputSections(id);
  const workbook = quote ? await buildOutputWorkbook({ quote, sections }) : null;
  const sourceDepartment = workbook
    ? inferOutputSourceDepartment(workbook, sheetName, address, String(req.body?.source_dept || ''))
    : 'sales';
  await db.prepare('DELETE FROM quote_output_overrides WHERE quote_id = ? AND sheet_name = ? AND cell_address = ?')
    .run(id, sheetName, address);
  if (!isFrozen) {
    await db.prepare(`UPDATE quote_sections SET
      status = CASE WHEN status = 'approved' THEN 'filled' ELSE status END,
      reviewed_by = NULL,
      reviewed_at = NULL
      WHERE quote_id = ? AND dept = ?`).run(id, sourceDepartment);
  }
  res.json({ ok: true, source_dept: sourceDepartment });
}));

// GET /api/quotes/:id/output-export — 下载与“报价明细”页面完全同版的工作簿。
router.get('/:id/output-export', async (req, res) => {
  const id = Number(req.params.id);
  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!quote) return res.status(404).json({ error: '不存在' });
  const acc = await quoteAccess(req.user, id);
  if (acc.status !== 200) return res.status(acc.status).json({ error: acc.status === 404 ? '不存在' : '无权导出该客户的报价单' });
  const approvedCount = Number((await db.prepare(
    `SELECT COUNT(*) AS n FROM quote_sections WHERE quote_id = ? AND status = 'approved'`
  ).get(id)).n);
  const totalDepts = Number((await db.prepare('SELECT COUNT(*) AS n FROM departments').get()).n);
  if (approvedCount < totalDepts) return res.status(409).json({ error: `尚有 ${totalDepts - approvedCount} 个部门未审核通过` });
  const sections = await db.prepare(
    `SELECT s.dept, d.name_cn, s.payload_json, s.reviewed_by, s.reviewed_at
     FROM quote_sections s JOIN departments d ON d.code = s.dept
     WHERE s.quote_id = ? ORDER BY d.sort_order`
  ).all(id);
  const overrides = await loadOutputOverrides(id);
  try {
    const workbook = await buildOutputWorkbook({ quote, sections, overrides });
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = encodeURIComponent(`${quote.quote_no || quote.id}_报价明细.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('[output-export]', error);
    res.status(500).json({ error: '导出失败: ' + error.message });
  }
});

// GET /api/quotes/:id/export — 全部审核通过后，导出与“报价明细”页面同版的 xlsx。
router.get('/:id/export', async (req, res) => {
  const id = Number(req.params.id);
  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!quote) return res.status(404).json({ error: '不存在' });
  // 客户可见范围校验
  const acc = await quoteAccess(req.user, id);
  if (acc.status !== 200) return res.status(acc.status).json({ error: acc.status === 404 ? '不存在' : '无权导出该客户的报价单' });

  const approvedCount = Number((await db.prepare(
    `SELECT COUNT(*) AS n FROM quote_sections WHERE quote_id = ? AND status = 'approved'`
  ).get(id)).n);
  const totalDepts = Number((await db.prepare('SELECT COUNT(*) AS n FROM departments').get()).n);
  if (approvedCount < totalDepts) {
    return res.status(409).json({ error: `尚有 ${totalDepts - approvedCount} 个部门未审核通过` });
  }

  const sections = await db.prepare(
    `SELECT s.dept, d.name_cn, s.payload_json, s.reviewed_by, s.reviewed_at
     FROM quote_sections s JOIN departments d ON d.code = s.dept
     WHERE s.quote_id = ? ORDER BY d.sort_order`
  ).all(id);
  const overrides = await loadOutputOverrides(id);

  await db.prepare(`INSERT INTO audit_log (quote_id, actor, action) VALUES (?, ?, 'export')`)
    .run(id, req.user.name);

  try {
    const wb = await buildOutputWorkbook({ quote, sections, overrides });
    const buf = await wb.xlsx.writeBuffer();
    const filename = encodeURIComponent(`${quote.quote_no || quote.id}_报价明细.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[export]', e);
    res.status(500).json({ error: '导出失败: ' + e.message });
  }
});

const DEPARTMENT_SHEETS = {
  electronic: '电子明细',
  molding: '啤机明细',
  blow: '吹气明细',
  painting: '喷油明细',
  slush: '搪胶明细',
  sewing: '车缝明细',
  assembly: '装配明细',
};

// GET /api/quotes/:id/export-department/:dept — 导出单个生产部门的功能表格。
router.get('/:id/export-department/:dept', async (req, res) => {
  const id = Number(req.params.id);
  const dept = String(req.params.dept || '');
  const sheetName = DEPARTMENT_SHEETS[dept];
  if (!sheetName) return res.status(400).json({ error: '该部门不支持单独导出' });

  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!quote) return res.status(404).json({ error: '不存在' });
  const acc = await quoteAccess(req.user, id);
  if (acc.status !== 200) {
    return res.status(acc.status).json({ error: acc.status === 404 ? '不存在' : '无权导出该客户的报价单' });
  }

  const sections = await db.prepare(
    `SELECT s.dept, d.name_cn, s.payload_json, s.reviewed_by, s.reviewed_at
     FROM quote_sections s JOIN departments d ON d.code = s.dept
     WHERE s.quote_id = ? ORDER BY d.sort_order`
  ).all(id);

  try {
    let wb;
    if (require('../services/mixedQuotation').getConfig(sections)?.enabled) {
      wb = await require('../services/exportMixedQuotation').buildMixedWorkbook({ quote, sections, dept });
    } else if (dept === 'sewing') {
      wb = await buildSewingTemplateWorkbook({ quote, sections });
    } else {
      wb = await buildWorkbook({ quote, sections });
      const selected = wb.getWorksheet(sheetName);
      if (!selected) return res.status(404).json({ error: '未找到该部门的导出表格' });
      wb.worksheets.slice().forEach(sheet => {
        if (sheet.id !== selected.id) wb.removeWorksheet(sheet.id);
      });
    }
    await db.prepare(`INSERT INTO audit_log (quote_id, actor, action, detail) VALUES (?, ?, 'export_department', ?)`)
      .run(id, req.user.name, dept);
    const buf = await wb.xlsx.writeBuffer();
    const filename = encodeURIComponent(dept === 'sewing'
      ? `${quote.quote_no || quote.id}_车缝报价单.xlsx`
      : `${quote.quote_no || quote.id}_${sheetName}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[export-department]', e);
    res.status(500).json({ error: '部门表格导出失败: ' + e.message });
  }
});

// GET /api/quotes/:id/export-vq — 生成 TOMY / SPIN 客户报客表。
router.get('/:id/export-vq', async (req, res) => {
  const id = Number(req.params.id);
  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!quote) return res.status(404).json({ error: '不存在' });

  const acc = await quoteAccess(req.user, id);
  if (acc.status !== 200) {
    return res.status(acc.status).json({ error: acc.status === 404 ? '不存在' : '无权导出该客户的报价单' });
  }

  const approvedCount = Number((await db.prepare(
    `SELECT COUNT(*) AS n FROM quote_sections WHERE quote_id = ? AND status = 'approved'`
  ).get(id)).n);
  const totalDepts = Number((await db.prepare('SELECT COUNT(*) AS n FROM departments').get()).n);
  if (approvedCount < totalDepts) {
    return res.status(409).json({ error: `尚有 ${totalDepts - approvedCount} 个部门未审核通过` });
  }

  const sections = await db.prepare(
    `SELECT s.dept, d.name_cn, s.payload_json, s.reviewed_by, s.reviewed_at
     FROM quote_sections s JOIN departments d ON d.code = s.dept
     WHERE s.quote_id = ? ORDER BY d.sort_order`
  ).all(id);

  await db.prepare(`INSERT INTO audit_log (quote_id, actor, action) VALUES (?, ?, 'export_vq')`)
    .run(id, req.user.name);

  try {
    const buf = await exportVQ({ quote, sections });
    const filename = encodeURIComponent(`VQ_${quote.quote_no || quote.id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[export-vq]', e);
    res.status(500).json({ error: '报客表导出失败: ' + e.message });
  }
});

// POST /api/quotes/:id/translate-vq — 与「报价系统」一致，自动翻译报客表英文名称。
router.post('/:id/translate-vq', async (req, res) => {
  const id = Number(req.params.id);
  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!quote) return res.status(404).json({ error: '不存在' });

  const acc = await quoteAccess(req.user, id);
  if (acc.status !== 200) {
    return res.status(acc.status).json({ error: acc.status === 404 ? '不存在' : '无权操作该客户的报价单' });
  }
  const customer = vqCustomerProfile(quote.customer);
  if (!customer) {
    return res.status(400).json({ error: `客户「${quote.customer || '未设置'}」暂未配置报客表翻译` });
  }

  const sections = await db.prepare(
    'SELECT id, dept, payload_json FROM quote_sections WHERE quote_id = ? ORDER BY id'
  ).all(id);

  try {
    const result = await translateSectionsForVq({ quote, sections });
    await db.transaction(async () => {
      for (const section of result.sections) {
        await db.prepare('UPDATE quote_sections SET payload_json = ? WHERE id = ?')
          .run(section.payload_json, section.id);
      }
      await db.prepare(
        `INSERT INTO audit_log (quote_id, actor, action, detail)
         VALUES (?, ?, 'translate_vq', ?)`
      ).run(
        id,
        req.user.name,
        `translated=${result.translated}, untranslated=${result.untranslated}`
      );
    })();
    res.json({
      translated: result.translated,
      untranslated: result.untranslated,
      warning: result.warning,
    });
  } catch (error) {
    console.error('[translate-vq]', error);
    res.status(500).json({ error: '翻译失败: ' + error.message });
  }
});

module.exports = router;
