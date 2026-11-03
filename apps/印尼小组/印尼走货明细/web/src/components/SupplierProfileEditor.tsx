import { useState } from 'react'
import { Button, Form, Input, Modal, message } from 'antd'
import { api, type Dictionaries, type SupplierDict } from '../api/client'
import { mergeSupplierProfileEdit, supplierEditableFields } from '../utils/supplierProfileEdit'

export default function SupplierProfileEditor({ name, disabled, onSaved }: {
  name: string; disabled?: boolean; onSaved: (profile: SupplierDict, previous: SupplierDict) => void
}) {
  const [original, setOriginal] = useState<SupplierDict | null>(null)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm<SupplierDict>()
  async function open() {
    setBusy(true)
    try {
      const { data } = await api.get<Dictionaries>('/dictionaries')
      const key = name.trim().toLowerCase()
      const matches = data.suppliers.filter(p => [p.keyword, p.full].some(v => v?.trim().toLowerCase() === key))
      if (matches.length > 1) { message.warning('存在同名供应商，请先到供应商汇总核对'); return }
      const profile = matches[0] || { keyword: name.trim(), full: name.trim() }
      form.resetFields(); form.setFieldsValue(profile); setOriginal(profile)
    } finally { setBusy(false) }
  }
  async function save() {
    const draft = await form.validateFields()
    if (!original) return
    setBusy(true)
    try {
      const { data } = await api.get<Dictionaries>('/dictionaries')
      const latest = original.id == null ? undefined : data.suppliers.find(p => p.id === original.id)
      if (original.id != null && !latest) { message.warning('供应商档案已不存在，请重新打开'); return }
      const payload = mergeSupplierProfileEdit(latest, original, draft)
      if (latest?.id) await api.put(`/dictionaries/suppliers/${latest.id}`, payload)
      else await api.post('/dictionaries/suppliers', payload)
      onSaved(payload, original); setOriginal(null)
      message.success('本供应商档案已保存；当前物料关联仍需保存，不会改写其他物料或历史单据')
    } finally { setBusy(false) }
  }
  return <>
    <Button type="link" size="small" disabled={disabled || !name.trim()} loading={busy} onClick={open}>编辑供应商资料</Button>
    <Modal title="编辑供应商基础资料" open={!!original} onCancel={() => setOriginal(null)}
      onOk={save} okText="保存本供应商档案" confirmLoading={busy}>
      <p>只有点击保存才修改本供应商档案，空白保留原资料。不会批量改写其他物料或历史单据；当前物料关联仍需单独保存。</p>
      <Form form={form} layout="vertical">
        {supplierEditableFields.map(([key, label]) => <Form.Item key={key} name={key} label={label}
          rules={!original?.id && key === 'full' ? [{ required: true, whitespace: true }] : []}>
          <Input maxLength={key === 'keyword' ? 128 : key.startsWith('address') ? 1000 : 256} />
        </Form.Item>)}
      </Form>
    </Modal>
  </>
}
