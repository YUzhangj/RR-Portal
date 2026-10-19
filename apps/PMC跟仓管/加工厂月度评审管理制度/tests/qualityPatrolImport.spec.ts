import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import * as XLSX from 'xlsx'
import QualityPatrolImport from '../src/components/QualityPatrolImport.vue'
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }))
vi.mock('../src/pb', () => ({ pb: { collection: () => ({ getFullList: mocks.list, create: mocks.create }) } }))
const factories = [{id:'a',name:'甲厂',region:'hunan'}, {id:'b',name:'乙厂',region:'hunan'}] as any
function fixture() {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['2026年9月18日湖南加工厂检查总结'],
    ['序号','厂名','员工人数','拉线','场地面积（平方）','9/18评级','评价','整改描述','计划完成时间','符合类型'],
    [1,'甲厂',10,1,100,'A','现场整洁','增加灭蚊灯',46310,'包装'],
    [2,'乙厂',20,2,200,'B','需要整改','','','半成品'],
    ['合计','',30],
  ]), '总结')
  const bytes = XLSX.write(book, {type:'array',bookType:'xlsx'})
  const file = new File([], '巡查.xlsx')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes, configurable: true })
  return file
}
async function read(w: ReturnType<typeof mount>) {
  const input = w.find('input[type=file]'); Object.defineProperty(input.element, 'files', {value:[fixture()], configurable:true})
  await input.trigger('change'); await flushPromises()
}
function confirm(w: ReturnType<typeof mount>) { return w.find('footer .primary') }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => { vi.resetAllMocks(); mocks.list.mockResolvedValue([]); mocks.create.mockImplementation(async (form: FormData) => ({ id: String(form.get('factory')), factory: form.get('factory'), check_date: form.get('check_date') })) })
describe('import preview and persistence', () => {
  it('requires preview confirmation, skips existing records and never calls update', async () => {
    const existing = [{id:'1',factory:'a',check_date:'2026-09-18 00:00:00Z'}] as any
    mocks.list.mockResolvedValue(existing)
    const w = mount(QualityPatrolImport, {props:{factories, records:existing, regions:['hunan'], initialRegion:'hunan'}})
    await read(w)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(w.text()).toContain('已存在，将跳过')
    await confirm(w).trigger('click'); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create.mock.calls[0]![0].get('factory')).toBe('b')
    expect(mocks.create.mock.calls[0]![0].get('evaluation')).toBe('需要整改')
    expect(w.emitted('saved')?.[0]).toEqual(['2026-09-18', 'hunan'])
    w.unmount()
  })
  it('retries failed rows without repeating successful writes', async () => {
    mocks.create.mockRejectedValueOnce(new Error('offline'))
    const w = mount(QualityPatrolImport, {props:{factories, records:[], regions:['hunan'], initialRegion:'hunan'}})
    await read(w); await confirm(w).trigger('click'); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(w.text()).toContain('部分记录失败')
    expect((w.find('input[type=date]').element as HTMLInputElement).disabled).toBe(true)
    await confirm(w).trigger('click'); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(3)
    expect(mocks.create.mock.calls[2]![0].get('factory')).toBe('a')
    w.unmount()
  })
  it('does not repeat a committed row whose response was lost', async () => {
    mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {id:'a',factory:'a',check_date:'2026-09-18 00:00:00Z'},
      {id:'b',factory:'b',check_date:'2026-09-18 00:00:00Z'},
    ])
    mocks.create.mockRejectedValueOnce(new Error('response lost after commit'))
    const w = mount(QualityPatrolImport, {props:{factories, records:[], regions:['hunan'], initialRegion:'hunan'}})
    await read(w); await confirm(w).trigger('click'); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(2)
    await confirm(w).trigger('click'); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(w.text()).toContain('已存在，将跳过')
    expect(w.text()).toContain('剩余 0 条未导入')
    w.unmount()
  })
  it('blocks unknown factories until manually matched and blocks cross-region import', async () => {
    const w = mount(QualityPatrolImport, {props:{factories:[factories[0],{id:'b',name:'乙厂新名',region:'hunan'}], records:[], regions:['hunan','dongguan'], initialRegion:'dongguan'}})
    await read(w)
    expect(w.find('[role=alert]').text()).toContain('厂区不一致')
    expect(confirm(w).attributes('disabled')).toBeDefined()
    await w.find('.controls select').setValue('hunan')
    expect(confirm(w).attributes('disabled')).toBeUndefined()
    await w.findAll('tbody select')[1]!.setValue('')
    expect(confirm(w).attributes('disabled')).toBeUndefined()
    expect(confirm(w).text()).toContain('1 条')
    await w.findAll('tbody select')[1]!.setValue('b')
    expect(confirm(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })
  it('imports matched rows first, then allows searching and importing pending rows', async () => {
    const w = mount(QualityPatrolImport, {props:{factories:[factories[0],{id:'b',name:'湖南新工厂',region:'hunan'}], records:[], regions:['hunan'], initialRegion:'hunan'}})
    await read(w)
    expect(confirm(w).text()).toContain('1 条')
    expect(confirm(w).attributes('disabled')).toBeUndefined()
    await confirm(w).trigger('click'); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('剩余 1 条未导入')
    const search = w.findAll('tbody input')[1]!
    await search.setValue('不存在')
    expect(w.text()).toContain('未找到工厂')
    await search.setValue('湖南新')
    const picker = w.findAll('tbody select')[1]!
    expect(picker.findAll('option').map(o => o.text())).toEqual(['请选择匹配工厂', '湖南新工厂'])
    await picker.setValue('b')
    expect(confirm(w).attributes('disabled')).toBeUndefined()
    await confirm(w).trigger('click'); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.create.mock.calls[1]![0].get('factory')).toBe('b')
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })
  it('labels close and cancel and protects pending imports on close and Escape', async () => {
    const prompt = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const w = mount(QualityPatrolImport, {props:{factories, records:[], regions:['hunan'], initialRegion:'hunan'}})
    await read(w)
    expect(w.find('header button').text()).toBe('关闭')
    expect(w.find('footer button').text()).toBe('取消导入')
    await w.find('header button').trigger('click')
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('2 条记录未导入'))
    expect(w.emitted('close')).toBeUndefined()
    await w.find('[role=dialog]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toBeUndefined()
    prompt.mockReturnValue(true)
    await w.find('footer button').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    prompt.mockRestore(); w.unmount()
  })

  it('keeps explicit matches and cleared selections when factories refresh in the same region', async () => {
    const available = [...factories, { id: 'c', name: '人工匹配厂', region: 'hunan' }]
    const w = mount(QualityPatrolImport, {props:{factories:available, records:[], regions:['hunan'], initialRegion:'hunan'}})
    await read(w)
    await w.findAll('tbody select')[0]!.setValue('c')
    await w.findAll('tbody select')[1]!.setValue('')
    await w.setProps({ factories: available.map(f => ({ ...f })) })
    expect((w.findAll('tbody select')[0]!.element as HTMLSelectElement).value).toBe('c')
    expect((w.findAll('tbody select')[1]!.element as HTMLSelectElement).value).toBe('')
    expect(confirm(w).text()).toContain('1 条')
    w.unmount()
  })

  it('invalidates a removed pending factory after a partial import without repeating saved rows', async () => {
    mocks.create.mockResolvedValueOnce({id:'a',factory:'a',check_date:'2026-09-18'}).mockRejectedValueOnce(new Error('offline'))
    const w = mount(QualityPatrolImport, {props:{factories, records:[], regions:['hunan'], initialRegion:'hunan'}})
    await read(w); await confirm(w).trigger('click'); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(2)
    await w.setProps({ factories: [factories[0]] })
    expect(w.text()).toContain('已导入')
    expect(w.text()).toContain('请选择匹配的工厂')
    expect(confirm(w).attributes('disabled')).toBeDefined()
    expect(confirm(w).text()).toContain('0 条')
    w.unmount()
  })

  it('rechecks authorized factories after the existing-record request before creating each row', async () => {
    let completeList!: (records: any[]) => void
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { completeList = resolve }))
    const w = mount(QualityPatrolImport, {props:{factories, records:[], regions:['hunan'], initialRegion:'hunan'}})
    await read(w)
    await confirm(w).trigger('click')
    await w.setProps({ factories: [factories[0]] })
    completeList([]); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create.mock.calls[0]![0].get('factory')).toBe('a')
    expect(confirm(w).attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('does not begin writes after unmount during the duplicate preflight', async () => {
    const pendingList = deferred<any[]>()
    mocks.list.mockReturnValueOnce(pendingList.promise)
    const w = mount(QualityPatrolImport, {props:{factories, records:[], regions:['hunan'], initialRegion:'hunan'}})
    await read(w); await confirm(w).trigger('click')
    w.unmount()
    pendingList.resolve([]); await flushPromises()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(w.emitted('saved')).toBeUndefined()
  })

  it('allows an already sent create to settle but stops later writes and completion after unmount', async () => {
    const pendingCreate = deferred<any>()
    mocks.create.mockReturnValueOnce(pendingCreate.promise)
    const w = mount(QualityPatrolImport, {props:{factories, records:[], regions:['hunan'], initialRegion:'hunan'}})
    await read(w); await confirm(w).trigger('click'); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    w.unmount()
    pendingCreate.resolve({id:'a',factory:'a',check_date:'2026-09-18'}); await flushPromises()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(w.emitted('saved')).toBeUndefined()
  })

  it('does not close or prompt while reading or saving', async () => {
    const prompt = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const file = fixture()
    const bytes = await file.arrayBuffer()
    const pendingRead = deferred<ArrayBuffer>()
    Object.defineProperty(file, 'arrayBuffer', { value: () => pendingRead.promise, configurable: true })
    const pendingCreate = deferred<any>()
    mocks.create.mockReturnValueOnce(pendingCreate.promise)
    const w = mount(QualityPatrolImport, {props:{factories, records:[], regions:['hunan'], initialRegion:'hunan'}})
    const input = w.find('input[type=file]')
    Object.defineProperty(input.element, 'files', {value:[file], configurable:true})
    await input.trigger('change')
    await w.find('header button').trigger('click')
    await w.find('[role=dialog]').trigger('keydown', {key:'Escape'})
    expect(w.emitted('close')).toBeUndefined()
    expect(prompt).not.toHaveBeenCalled()
    pendingRead.resolve(bytes); await flushPromises()
    await confirm(w).trigger('click'); await flushPromises()
    await w.find('footer button').trigger('click')
    await w.find('[role=dialog]').trigger('keydown', {key:'Escape'})
    expect(w.emitted('close')).toBeUndefined()
    expect(prompt).not.toHaveBeenCalled()
    pendingCreate.resolve({id:'a',factory:'a',check_date:'2026-09-18'}); await flushPromises()
    prompt.mockRestore(); w.unmount()
  })

  it('stops pending rows when the selected region loses authorization', async () => {
    const pendingList = deferred<any[]>()
    mocks.list.mockReturnValueOnce(pendingList.promise)
    const w = mount(QualityPatrolImport, {props:{factories, records:[], regions:['hunan','dongguan'], initialRegion:'hunan'}})
    await read(w); await confirm(w).trigger('click')
    await w.setProps({ regions: ['dongguan'] })
    pendingList.resolve([]); await flushPromises()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(confirm(w).attributes('disabled')).toBeDefined()
    w.unmount()
  })

})
