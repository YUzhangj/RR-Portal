// 将原资质项中的 IP 管控拆为独立 5 分评分项，通用项总分保持 85 分。
migrate((app) => {
  const collection = app.findCollectionByNameOrId('score_templates')
  const moduleField = collection.fields.getByName('module')
  if (moduleField && !moduleField.values.includes('ip_control')) {
    moduleField.values.push('ip_control')
    app.save(collection)
  }

  const qualifications = app.findRecordsByFilter('score_templates', 'module = "qualification"', '', 0, 0)
  for (const record of qualifications) {
    record.set('max_score', 5)
    app.save(record)
  }

  const existing = app.findRecordsByFilter('score_templates', 'module = "ip_control"', '', 0, 1)
  if (!existing.length) {
    const following = app.findRecordsByFilter('score_templates', 'craft_filter = "" && sort_order >= 2', '-sort_order', 0, 0)
    for (const item of following) {
      item.set('sort_order', Number(item.get('sort_order')) + 1)
      app.save(item)
    }
    const record = new Record(collection)
    record.set('name', 'IP管控')
    record.set('module', 'ip_control')
    record.set('max_score', 5)
    record.set('scoring_role', 'buyer')
    record.set('craft_filter', '')
    record.set('is_active', true)
    record.set('sort_order', 2)
    app.save(record)
  }
}, (app) => {
  const records = app.findRecordsByFilter('score_templates', 'module = "ip_control"', '', 0, 0)
  for (const record of records) app.delete(record)

  const following = app.findRecordsByFilter('score_templates', 'craft_filter = "" && sort_order >= 3', 'sort_order', 0, 0)
  for (const item of following) {
    item.set('sort_order', Number(item.get('sort_order')) - 1)
    app.save(item)
  }

  const qualifications = app.findRecordsByFilter('score_templates', 'module = "qualification"', '', 0, 0)
  for (const record of qualifications) {
    record.set('max_score', 10)
    app.save(record)
  }

  const collection = app.findCollectionByNameOrId('score_templates')
  const moduleField = collection.fields.getByName('module')
  if (moduleField) {
    moduleField.values = moduleField.values.filter((value) => value !== 'ip_control')
    app.save(collection)
  }
})
