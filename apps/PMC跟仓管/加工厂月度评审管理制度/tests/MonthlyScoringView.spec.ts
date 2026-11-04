import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'

const state = vi.hoisted(() => ({ update: vi.fn(), extraOrders: [] as Record<string, unknown>[], patrols: [] as Record<string, unknown>[], patrolFailure: false }))
const factoryItems = [
  { id: 'factory-1', name: '工厂甲', craft: 'injection', region: 'dongguan', ip_control: '已受控', processable_types: '塑胶注塑' },
  { id: 'factory-2', name: '工厂乙', craft: 'injection', region: 'dongguan' },
]
const templates = [{
  id: 'delivery', name: '交期', module: 'delivery', max_score: 20,
  scoring_role: 'buyer', is_active: true,
}]
const records = factoryItems.map((factory, index) => ({
  id: 'score-' + index, factory: factory.id, year_month: '2026-08', status: 'draft', flag: 'none',
  score_items: [{ template_id: 'delivery', score: index === 0 ? 20 : 10 }],
}))
const orders = factoryItems.map((factory, index) => ({
  id: 'order-' + index, factory: factory.id, delivery_date: '2026-08-10', is_delayed: index === 0, order_date: '2026-08-01', amount: index === 0 ? 1200 : undefined, quote_labor_price: index === 0 ? 2 : undefined, quantity: 100,
}))

vi.mock('../src/components/AppLayout.vue', () => ({ default: { template: '<main><slot /></main>' } }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { month: '2026-08' } }),
  useRouter: () => ({ replace: vi.fn() }),
  RouterLink: { template: '<a><slot /></a>' },
}))
vi.mock('../src/stores/auth', () => ({ useAuthStore: () => ({ role: 'admin', userId: 'admin-1' }) }))
vi.mock('../src/utils/permissions', () => ({
  allowedCrafts: () => ['injection'], allowedRegions: () => ['dongguan'], canViewCraft: () => true,
}))
vi.mock('../src/stores/factories', () => ({
  useFactoriesStore: () => ({ items: factoryItems, fetchAll: vi.fn() }),
  filterByCraft: (items: unknown[]) => items,
}))
vi.mock('../src/stores/scoreTemplates', () => ({
  useScoreTemplatesStore: () => ({ items: templates, fetchAll: vi.fn(), applicable: () => templates }),
}))
vi.mock('../src/pb', () => ({ pb: { collection: (name: string) => ({
  getFullList: async (options?: { filter?: string }) => {
    if (name === 'factories') return factoryItems
    if (name === 'score_templates') return templates
    if (name === 'orders') return [...orders, ...state.extraOrders,
      { id: 'old-order', factory: 'factory-1', order_date: '2026-07-01', delivery_date: '2026-07-10', amount: 300, quote_labor_price: 1, quantity: 100 },
    ]
    if (name === 'quality_patrols') {
      if (state.patrolFailure) throw new Error('offline')
      return state.patrols
    }
    if (name === 'quality_inspections') return [
      { factory: 'factory-1', inspect_date: '2026-08-10', internal_result: 'PASS' },
      { factory: 'factory-1', inspect_date: '2026-08-11', internal_result: 'FAIL' },
      { factory: 'factory-1', inspect_date: '2026-08-12', internal_result: '' },
      { factory: 'factory-1', inspect_date: '2026-07-10', internal_result: 'PASS' },
    ]
    if (name !== 'monthly_scores') return []
    return options?.filter?.startsWith('factory =')
      ? records.filter((record) => options.filter!.includes(record.factory))
      : records
  },
  update: state.update,
}) } }))

import MonthlyScoringView from '../src/views/MonthlyScoringView.vue'

describe('批量自动评分', () => {
  it('展示七项指标并随评分范围汇总，移除红黄牌', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(MonthlyScoringView)
    await flushPromises()
    const headers = wrapper.findAll('th').map((cell) => cell.text())
    expect(headers).toEqual(['工厂', '部门', '综合评级', '加工值', '成本', '货期', '合格率', 'IP管控', '加工类型', '状态', '操作'])
    const cells = () => wrapper.findAll('tbody tr')[0].findAll('td').map((cell) => cell.text())
    expect(cells().slice(3, 9)).toEqual(['1,200.00', '200.00', '1', '33.33%', '已受控', '塑胶注塑'])
    expect(wrapper.findAll('tbody tr')[1].findAll('td').slice(3, 9).map((cell) => cell.text()))
      .toEqual(['—', '—', '0', '—', '—', '—'])
    expect(wrapper.text()).not.toContain('红黄牌')
    expect(wrapper.findAll('tbody tr')[0].findAll('td')[6].attributes('title')).toContain('品质检验明细：合格 1 / 验货 3 条')
    await wrapper.find('select[aria-label="评分时间范围"]').setValue('two_months')
    await flushPromises()
    expect(cells().slice(3, 7)).toEqual(['1,500.00', '300.00', '1', '50.00%'])
    wrapper.unmount()
  })


  it('货期统计去重的延期单数，排除已取消和范围外订单', async () => {
    setActivePinia(createPinia())
    state.extraOrders = [
      { id: 'line-a', factory: 'factory-1', delivery_date: '2026-08-12', order_no: 'PO-DUP', is_delayed: true },
      { id: 'line-b', factory: 'factory-1', delivery_date: '2026-08-12', order_no: 'PO-DUP', delay_days: 2 },
      { id: 'cancelled', factory: 'factory-1', delivery_date: '2026-08-12', order_no: 'PO-CANCEL', is_delayed: true, status: 'cancelled' },
      { id: 'outside', factory: 'factory-1', delivery_date: '2026-09-12', order_no: 'PO-SEP', is_delayed: true },
    ]
    const wrapper = mount(MonthlyScoringView)
    try {
      await flushPromises()
      expect(wrapper.findAll('tbody tr')[0].findAll('td')[5].text()).toBe('2')
      expect(wrapper.findAll('tbody tr')[1].findAll('td')[5].text()).toBe('0')
    } finally { state.extraOrders = []; wrapper.unmount() }
  })

  it('综合评级纳入当月最新巡查且已提交评分无需重新计算', async () => {
    setActivePinia(createPinia())
    const previous = records[0].score_items[0].score
    records[0].score_items[0].score = 95
    records[0].status = 'submitted'
    state.patrols = [
      { id: 'early', factory: 'factory-1', check_date: '2026-08-01', grade: 'D' },
      { id: 'latest', factory: 'factory-1', check_date: '2026-08-25', grade: 'C' },
      { id: 'future', factory: 'factory-1', check_date: '2026-09-01', grade: 'D' },
    ]
    const wrapper = mount(MonthlyScoringView)
    try {
      await flushPromises()
      const cell = wrapper.findAll('tbody tr')[0].findAll('td')[2]
      expect(cell.text()).toBe('C')
      expect(cell.attributes('title')).toContain('月度评分等级：A')
      expect(cell.attributes('title')).toContain('2026-08-25 C级')
    } finally {
      records[0].score_items[0].score = previous
      records[0].status = 'draft'
      state.patrols = []
      wrapper.unmount()
    }
  })

  it('巡查加载失败时不展示缺少巡查的综合评级，重试后恢复', async () => {
    setActivePinia(createPinia())
    state.patrolFailure = true
    const wrapper = mount(MonthlyScoringView)
    try {
      await flushPromises()
      expect(wrapper.find('[role="alert"]').text()).toContain('巡查评级加载失败')
      expect(wrapper.findAll('tbody tr')[0].findAll('td')[2].text()).toBe('—')
      state.patrolFailure = false
      await wrapper.find('[role="alert"] button').trigger('click')
      await flushPromises()
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(wrapper.findAll('tbody tr')[0].findAll('td')[2].text()).toBe('D')
    } finally { state.patrolFailure = false; wrapper.unmount() }
  })

  it('保存后列表重新排序仍对每家工厂仅计算一次', async () => {
    setActivePinia(createPinia())
    state.update.mockImplementation(async (id, data) => ({ ...records.find((record) => record.id === id), ...data }))
    const wrapper = mount(MonthlyScoringView)
    await flushPromises()
    await wrapper.findAll('button').find((button) => button.text() === '自动计算并提交本月评分')!.trigger('click')
    await flushPromises()
    expect(state.update.mock.calls.map(([id]) => id)).toEqual(['score-0', 'score-1'])
    expect(state.update.mock.calls.every(([, data]) => data.status === 'submitted' && data.submitted_by === 'admin-1')).toBe(true)
    expect(state.update.mock.calls[0][1].score_items[0].score).toBe(0)
    expect(state.update.mock.calls[1][1].score_items[0].score).toBe(20)
    expect(wrapper.text()).toContain('已提交 2 家')
    wrapper.unmount()
  })
  it('批量计算不覆盖已提交或已审批结果', async () => {
    setActivePinia(createPinia())
    state.update.mockClear()
    records[0]!.status = 'submitted'
    records[1]!.status = 'approved'
    const wrapper = mount(MonthlyScoringView)
    try {
      await flushPromises()
      await wrapper.findAll('button').find((button) => button.text() === '自动计算并提交本月评分')!.trigger('click')
      await flushPromises()
      expect(state.update).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('跳过已提交/已审批 2 家')
    } finally { records.forEach((record) => { record.status = 'draft' }); wrapper.unmount() }
  })

})
