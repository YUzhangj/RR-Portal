// 用户管理增加“电子部采购”角色，权限与其他部门采购保持一致。
const OLD_NON_BUYER = '@request.auth.id != "" && @request.auth.role != "buyer_injection" && @request.auth.role != "buyer_painting" && @request.auth.role != "buyer_assembly" && @request.auth.role != "buyer_sewing"'
const NON_BUYER = `${OLD_NON_BUYER} && @request.auth.role != "buyer_electronics"`

migrate((app) => {
  const users = app.findCollectionByNameOrId('users')
  const role = users.fields.find((field) => field.name === 'role')
  if (role && !role.values.includes('buyer_electronics')) {
    role.values.push('buyer_electronics')
    app.save(users)
  }

  // buyer_* 对品质数据保持只读，与现有采购角色一致。
  for (const name of ['quality_5s_checks', 'quality_inspections']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.createRule = NON_BUYER
    collection.updateRule = NON_BUYER
    app.save(collection)
  }
}, (app) => {
  const users = app.findCollectionByNameOrId('users')
  const role = users.fields.find((field) => field.name === 'role')
  if (role) role.values = role.values.filter((value) => value !== 'buyer_electronics')
  app.save(users)

  for (const name of ['quality_5s_checks', 'quality_inspections']) {
    const collection = app.findCollectionByNameOrId(name)
    collection.createRule = OLD_NON_BUYER
    collection.updateRule = OLD_NON_BUYER
    app.save(collection)
  }
})
