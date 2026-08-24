// 注意：PocketBase JSVM 会把 handler 源码抽出、在独立的 executor VM 里重新编译执行，
// 顶层声明的函数/变量在 handler 运行时不可见（ReferenceError）。
// 因此所有辅助函数必须定义在 handler 函数体内部，handler 必须自包含。
function requireOrdersEdit(e) {
  function parsePermissions(auth) {
    let permissions = {}
    const rawPermissions = auth.getString('permissions')
    if (!rawPermissions) return permissions
    try {
      const parsed = JSON.parse(rawPermissions)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : permissions
    } catch {
      return permissions
    }
  }

  function authorizedCrafts(auth) {
    const selected = auth.get('crafts')
    if (Array.isArray(selected) && selected.length) return selected
    const legacy = auth.getString('craft')
    return legacy ? [legacy] : []
  }

  const auth = e.requestInfo().auth
  if (!auth) throw new ApiError(403, '当前账号没有货期管理编辑权限')
  const permissions = parsePermissions(auth)
  if (permissions['orders.edit'] !== undefined) {
    if (permissions['orders.edit'] !== true) {
      throw new ApiError(403, '当前账号没有货期管理编辑权限')
    }
  } else if (auth.get('role') === 'quality_qc') {
    throw new ApiError(403, '当前账号没有货期管理编辑权限')
  }

  const factoryId = e.record.getString('factory')
  if (!factoryId) throw new ApiError(400, '请选择加工厂')
  let factory
  try {
    factory = $app.findRecordById('factories', factoryId)
  } catch {
    throw new ApiError(400, '加工厂不存在')
  }

  const region = e.record.getString('region') || factory.getString('region') || 'dongguan'
  if (!['dongguan', 'hunan', 'heyuan'].includes(region)) {
    throw new ApiError(400, '请选择有效的订单管理厂区')
  }
  if (permissions[`region.${region}`] === false) {
    throw new ApiError(403, '当前账号没有该厂区的货期数据导入或编辑权限')
  }
  const crafts = authorizedCrafts(auth)
  if (crafts.length && !crafts.includes(factory.getString('craft'))) {
    throw new ApiError(403, '当前账号没有该部门的货期数据导入或编辑权限')
  }
  e.record.set('region', region)
  return e.next()
}

onRecordCreateRequest(requireOrdersEdit, 'orders')
onRecordUpdateRequest(requireOrdersEdit, 'orders')
onRecordDeleteRequest(requireOrdersEdit, 'orders')
