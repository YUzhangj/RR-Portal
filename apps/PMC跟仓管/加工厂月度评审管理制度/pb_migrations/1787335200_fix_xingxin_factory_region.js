// 兴信为湖南邵阳工厂；历史导入时因旧数据无厂区字段被默认归到东莞。
// 订单通过 factory 关系引用，修正工厂归属后其订单会自动进入湖南厂区。
migrate((app) => {
  const names = ['邵阳兴信', '邵阳市兴信塑胶制品有限公司']
  for (const name of names) {
    const records = app.findRecordsByFilter('factories', 'name = {:name}', '', 0, 0, { name })
    for (const record of records) {
      record.set('region', 'hunan')
      app.save(record)
    }
  }
}, (app) => {
  const names = ['邵阳兴信', '邵阳市兴信塑胶制品有限公司']
  for (const name of names) {
    const records = app.findRecordsByFilter('factories', 'name = {:name}', '', 0, 0, { name })
    for (const record of records) {
      record.set('region', 'dongguan')
      app.save(record)
    }
  }
})
