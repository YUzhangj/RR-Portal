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
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes })
  return file
}
async function read(w: ReturnType<typeof mount>) {
  const input = w.find('input[type=file]'); Object.defineProperty(input.element, 'files', {value:[fixture()], configurable:true})
  await input.trigger('change'); await flushPromises()
}
function confirm(w: ReturnType<typeof mount>) { return w.find('footer .primary') }
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
  it('blocks unknown factories until manually matched and blocks cross-region import', async () => {
    const w = mount(QualityPatrolImport, {props:{factories:[factories[0],{id:'b',name:'乙厂新名',region:'hunan'}], records:[], regions:['hunan','dongguan'], initialRegion:'dongguan'}})
    await read(w)
    expect(w.find('[role=alert]').text()).toContain('厂区不一致')
    expect(confirm(w).attributes('disabled')).toBeDefined()
    await w.find('.controls select').setValue('hunan')
    expect(confirm(w).attributes('disabled')).toBeUndefined()
    await w.findAll('tbody select')[1]!.setValue('')
    expect(confirm(w).attributes('disabled')).toBeDefined()
    await w.findAll('tbody select')[1]!.setValue('b')
    expect(confirm(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})
