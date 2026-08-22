// 订单的管理厂区独立于加工厂所在地。
// 历史数据默认继承加工厂厂区；陈文旋负责的现有订单按东莞管理。
migrate((app) => {
  const collection = app.findCollectionByNameOrId('orders')
  if (!collection.fields.find((field) => field.name === 'region')) {
    collection.fields.add(new SelectField({
      name: 'region',
      required: false,
      maxSelect: 1,
      values: ['dongguan', 'hunan', 'heyuan'],
    }))
    app.save(collection)
  }

  const orders = app.findRecordsByFilter('orders', 'region = ""', '', 0, 0)
  for (const order of orders) {
    let region = 'dongguan'
    try {
      const factory = app.findRecordById('factories', order.getString('factory'))
      region = factory.getString('region') || 'dongguan'
    } catch {
      region = 'dongguan'
    }
    if (order.getString('pmc').trim() === '陈文旋') region = 'dongguan'
    order.set('region', region)
    app.save(order)
  }
}, (app) => {
  const collection = app.findCollectionByNameOrId('orders')
  const field = collection.fields.find((item) => item.name === 'region')
  if (field) collection.fields.removeById(field.id)
  app.save(collection)
})
