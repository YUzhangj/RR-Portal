const { createHash } = require('node:crypto');

const fail = message => {
  throw Object.assign(new Error(message), { status: 409 });
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateBundle(bundle) {
  if (bundle?.format !== 'rr-verification-transfer-v1' || !Array.isArray(bundle.records)
    || !bundle.records.length || bundle.records.length > 1000) fail('核价导入包格式无效');
  const keys = new Set();
  for (const record of bundle.records) {
    const quote = record.quote;
    const key = quote?.quote_no;
    if (!quote || !['customer', 'quote_no', 'product_name'].every(field => typeof quote[field] === 'string'
      && quote[field].trim() && quote[field].length <= 500) || keys.has(key)) fail('导入包客户和货号缺失或重复');
    keys.add(key);
    if (!Array.isArray(record.versions) || !record.versions.length) fail('缺少核价版本');
    const numbers = new Set();
    for (const version of record.versions) {
      if (!Number.isSafeInteger(version.version_no) || version.version_no < 1 || numbers.has(version.version_no)
        || !['drafting', 'in_review', 'ready', 'completed'].includes(version.status)) fail('核价版本无效');
      numbers.add(version.version_no);
      if (!Array.isArray(version.sections) || version.sections.length !== 8
        || new Set(version.sections.map(section => section.dept)).size !== 8) fail('核价部门资料不完整');
      for (const section of version.sections) {
        if (!['sales', 'engineering', 'electronic', 'molding', 'painting', 'slush', 'sewing', 'assembly'].includes(section.dept)
          || !section.payload || typeof section.payload !== 'object' || Array.isArray(section.payload)
          || !['empty', 'filled', 'approved', 'rejected'].includes(section.status)) fail('核价部门资料无效');
      }
      if (version.status === 'completed' && version.sections.some(section => section.status !== 'approved')) fail('已完成版本必须全部审核通过');
    }
    if (!record.baseline?.sections?.length || !record.versions[0].sections.find(section => section.dept === 'sales')?.payload.legacy_import) {
      fail('只支持已导入的历史核价资料');
    }
  }
  return bundle;
}

async function planTransfer(db, bundle, factoryCode) {
  validateBundle(bundle);
  const plan = [];
  for (const record of bundle.records) {
    const hash = digest(record);
    const quote = record.quote;
    const existing = await db.prepare('SELECT id FROM quotes WHERE factory_code=? AND quote_no=?').all(factoryCode, quote.quote_no);
    const applied = await db.prepare("SELECT detail FROM audit_log WHERE action='verification_transfer_import' AND detail=?")
      .get(JSON.stringify({ factory: factoryCode, hash }));
    if (applied) {
      plan.push({ customer: quote.customer, quote_no: quote.quote_no, status: 'already_imported', hash });
      continue;
    }
    if (existing.length) fail(`客户 ${quote.customer} 货号 ${quote.quote_no} 已有资料，本次不覆盖，请先核对`);
    plan.push({ customer: quote.customer, quote_no: quote.quote_no, status: 'new', hash });
  }
  return {
    count: plan.length,
    new_count: plan.filter(item => item.status === 'new').length,
    existing_count: plan.filter(item => item.status === 'already_imported').length,
    token: digest([factoryCode, plan]),
    items: plan,
  };
}

async function applyTransfer(db, bundle, { factoryCode, actor, expectedToken }) {
  return db.transaction(async () => {
    if (db.pool) await db.prepare('SELECT code FROM factories WHERE code=? FOR UPDATE').get(factoryCode);
    const plan = await planTransfer(db, bundle, factoryCode);
    if (plan.token !== expectedToken) fail('导入预览已变化，请重新预览');
    for (let index = 0; index < bundle.records.length; index += 1) {
      if (plan.items[index].status !== 'new') continue;
      const record = bundle.records[index];
      const quote = record.quote;
      const inserted = await db.prepare(`INSERT INTO quotes
        (quote_no,product_name,version,customer,qty,factory_code,status,created_by_name)
        VALUES (?,?,?,?,?,?,'drafting',?) RETURNING id`)
        .get(quote.quote_no, quote.product_name, quote.version || 'V1', quote.customer, quote.qty ?? 0, factoryCode, actor);
      const id = Number(inserted.id);
      const baseline = structuredClone(record.baseline);
      baseline.quote = { ...baseline.quote, id, factory_code: factoryCode };
      for (const section of baseline.sections) {
        await db.prepare("INSERT INTO quote_sections(quote_id,dept,payload_json,status) VALUES (?,?,?,'approved')")
          .run(id, section.dept, JSON.stringify(section.payload || {}));
      }
      await db.prepare(`INSERT INTO quote_customer_confirmations
        (quote_id,status,confirmed_price,confirmed_qty,confirmed_by,confirmed_at)
        VALUES (?,'confirmed',?,?,?,datetime('now'))`)
        .run(id, record.confirmation?.confirmed_price ?? 0, record.confirmation?.confirmed_qty ?? quote.qty ?? 0, actor);
      const newest = [...record.versions].sort((left, right) => right.version_no - left.version_no)[0];
      await db.prepare(`INSERT INTO quote_verifications
        (quote_id,baseline_json,verified_values_json,verified_sections_json,status,created_by,updated_by)
        VALUES (?,?,'{}','{}',?,?,?)`)
        .run(id, JSON.stringify(baseline), newest.status === 'completed' ? 'completed' : 'in_progress', actor, actor);
      const ids = new Map();
      for (const version of [...record.versions].sort((left, right) => left.version_no - right.version_no)) {
        const saved = await db.prepare(`INSERT INTO quote_verification_versions
          (quote_id,version_no,label,parent_version_id,source_type,status,note,created_by,completed_by,completed_at,category,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
          .get(id, version.version_no, version.label || `V${version.version_no}`, ids.get(version.parent_version_no) || null,
            version.source_type || 'quote', version.status, version.note || null, version.created_by || actor,
            version.status === 'completed' ? (version.completed_by || actor) : null,
            version.status === 'completed' ? (version.completed_at || new Date().toISOString()) : null,
            version.category || null, version.created_at || new Date().toISOString(), version.updated_at || new Date().toISOString());
        ids.set(version.version_no, Number(saved.id));
        for (const section of version.sections) {
          await db.prepare(`INSERT INTO quote_verification_sections
            (version_id,dept,payload_json,status,filled_by,filled_at,reviewed_by,reviewed_at,review_comment)
            VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(Number(saved.id), section.dept, JSON.stringify(section.payload), section.status, section.filled_by || actor,
              section.filled_at || null, section.reviewed_by || null, section.reviewed_at || null, section.review_comment || null);
        }
      }
      await db.prepare("INSERT INTO audit_log(quote_id,actor,action,detail) VALUES (?,?,'verification_transfer_import',?)")
        .run(id, actor, JSON.stringify({ factory: factoryCode, hash: plan.items[index].hash }));
    }
    return { ok: true, count: plan.new_count, already_imported: plan.existing_count };
  })();
}

module.exports = { validateBundle, planTransfer, applyTransfer, digest };
