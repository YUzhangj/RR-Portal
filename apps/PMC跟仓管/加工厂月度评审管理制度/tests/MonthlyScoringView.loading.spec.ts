import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { useFactoriesStore } from '../src/stores/factories'
import { useScoresStore } from '../src/stores/scores'
import { useScoreTemplatesStore } from '../src/stores/scoreTemplates'
import { setAuthorizedCrafts, setPermissionOverrides } from '../src/utils/permissions'

const state = vi.hoisted(() => ({
  auth: { userId: 'synthetic-1', role: 'admin', crafts: [] as string[] },
  record: { id: 'synthetic-1', permissions: {} as Record<string, boolean> },
  listeners: new Set<() => void>(),
  read: null as null | ((name: string, options?: { filter?: string }) => Promise<unknown[]>),
}))
vi.mock('../src/components/AppLayout.vue', () => ({ default: { template: '<main><slot /></main>' } }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { month: '2026-08' } }), useRouter: () => ({ replace: async () => {} }),
  RouterLink: { template: '<a><slot /></a>' },
}))
vi.mock('../src/stores/auth', async () => {
  const { reactive } = await import('vue')
  const auth = reactive(state.auth)
  return { useAuthStore: () => auth }
})
vi.mock('../src/pb', () => ({ pb: {
  authStore: { get record() { return state.record }, onChange(fn: () => void) { state.listeners.add(fn); return () => state.listeners.delete(fn) } },
  collection: (name: string) => ({ getFullList: (options?: { filter?: string }) => state.read!(name, options) }),
} }))
import MonthlyScoringView from '../src/views/MonthlyScoringView.vue'
import { useAuthStore } from '../src/stores/auth'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const factory = (name = '当前工厂', craft = 'injection', region = 'dongguan') => ({ id: 'f', name, craft, region })
const order = (month = '2026-09', amount = 200) => ({ id: month, factory: 'f', order_date: month + '-01', delivery_date: month + '-10', amount, quantity: 10, quote_labor_price: 2 })
const score = (month = '2026-09') => ({ id: month, factory: 'f', year_month: month, status: 'draft', score_items: [] })
function records(name: string, month = '2026-09') {
  if (name === 'factories') return [factory()]
  if (name === 'monthly_scores') return [score(month)]
  if (name === 'orders') return [order(month)]
  if (name === 'quality_inspections') return [{ factory: 'f', inspect_date: month + '-11', internal_result: 'PASS' }]
  return []
}
const wrappers: ReturnType<typeof mount>[] = []
function view() { const w = mount(MonthlyScoringView); wrappers.push(w); return w }
async function cachedAugust() {
  state.read = async name => records(name, '2026-08')
  const w = view(); await flushPromises()
  expect(w.find('tbody').text()).toContain('当前工厂')
  w.unmount(); wrappers.splice(wrappers.indexOf(w), 1)
}
beforeEach(() => {
  setActivePinia(createPinia())
  const auth = useAuthStore(); auth.userId = 'synthetic-1'; auth.role = 'admin'; auth.crafts = []
  state.record = { id: 'synthetic-1', permissions: {} }
  state.read = async name => records(name)
  setAuthorizedCrafts(null); setPermissionOverrides(null)
})
afterEach(() => { for (const w of wrappers.splice(0)) w.unmount(); setAuthorizedCrafts(null); setPermissionOverrides(null) })

describe('monthly scoring request snapshots', () => {
  it('ignores the late quality response of a cached month after the newer month has rendered', async () => {
    await cachedAugust()
    const oldQuality = deferred<unknown[]>()
    let qualityCalls = 0
    state.read = async name => name === 'quality_inspections' && qualityCalls++ === 0 ? oldQuality.promise : records(name)
    const w = view(); await flushPromises()
    await w.find('input[type=month]').setValue('2026-09'); await flushPromises()
    expect(w.find('tbody').text()).toContain('当前工厂')
    expect(w.find('tbody').text()).toContain('200.00')
    oldQuality.resolve([]); await flushPromises()
    expect(w.find('tbody').text()).toContain('当前工厂')
    expect(w.find('tbody').text()).toContain('200.00')
    expect(w.find('tbody').text()).toContain('100.00%')
    expect(useScoresStore().items[0]?.year_month).toBe('2026-09')
  })

  it('commits factories, scores, templates, orders and quality only from the latest complete request', async () => {
    const old = new Map<string, ReturnType<typeof deferred<unknown[]>>>()
    let initial = true
    state.read = async name => {
      if (!initial) return records(name)
      const value = deferred<unknown[]>(); old.set(name, value); return value.promise
    }
    const w = view(); await flushPromises(); initial = false
    await w.find('input[type=month]').setValue('2026-09'); await flushPromises()
    expect(w.find('tbody').text()).toContain('当前工厂')
    for (const [name, pending] of old) pending.resolve(name === 'factories' ? [factory('旧工厂')] : name === 'score_templates' ? [{ id: 'old-template' }] : records(name, '2026-08'))
    await flushPromises()
    expect(w.find('tbody').text()).toContain('当前工厂')
    expect(w.find('tbody').text()).not.toContain('旧工厂')
    expect(w.find('tbody').text()).toContain('200.00')
    expect(useFactoriesStore().items[0]?.name).toBe('当前工厂')
    expect(useScoresStore().items[0]?.year_month).toBe('2026-09')
    expect(useScoreTemplatesStore().items).toEqual([])
  })

  it('an old finally cannot stop the newer loading state or enable automatic scoring', async () => {
    await cachedAugust()
    const old = deferred<unknown[]>(), latest = deferred<unknown[]>()
    let qualityCalls = 0
    state.read = async name => name === 'quality_inspections' ? (++qualityCalls === 1 ? old.promise : latest.promise) : records(name)
    const w = view(); await flushPromises()
    await w.find('input[type=month]').setValue('2026-09'); await flushPromises()
    old.resolve([]); await flushPromises()
    expect(w.find('tbody').text()).toContain('正在加载')
    expect(w.find('button').element.disabled).toBe(true)
    latest.resolve(records('quality_inspections')); await flushPromises()
    expect(w.find('tbody').text()).toContain('当前工厂')
    expect(w.find('button').element.disabled).toBe(false)
  })

  it('shows a retryable quality failure without stale figures or a false zero pass rate', async () => {
    let fail = true
    state.read = async name => { if (name === 'quality_inspections' && fail) throw new Error('synthetic offline'); return records(name, '2026-08') }
    const w = view(); await flushPromises()
    expect(w.find('[role=alert]').text()).toContain('评分指标加载失败')
    expect(w.find('tbody').text()).not.toContain('当前工厂')
    expect(w.find('tbody').text()).not.toContain('0.00%')
    expect(w.find('tbody').text()).not.toContain('暂无订单工厂')
    expect(w.find('button').element.disabled).toBe(true)
    fail = false
    await w.find('[role=alert] button').trigger('click'); await flushPromises()
    expect(w.find('[role=alert]').exists()).toBe(false)
    expect(w.find('tbody').text()).toContain('当前工厂')
    expect(w.find('tbody').text()).toContain('100.00%')
  })

  it('clears old identity figures and rejects in-flight writes before an explicit reload in the new scope', async () => {
    const oldQuality = deferred<unknown[]>(); let first = true
    state.read = async name => first && name === 'quality_inspections' ? oldQuality.promise : records(name, '2026-08')
    const w = view(); await flushPromises()
    const auth = useAuthStore(); auth.userId = 'synthetic-2'
    state.record = { id: 'synthetic-2', permissions: { 'region.dongguan': false } }
    setAuthorizedCrafts(['sewing']); setPermissionOverrides({ 'region.dongguan': false })
    for (const notify of state.listeners) notify()
    oldQuality.resolve(records('quality_inspections', '2026-08')); await flushPromises()
    expect(w.find('[role=alert]').text()).toContain('账号或权限已变更')
    expect(w.find('tbody').text()).not.toContain('当前工厂')
    expect(useScoresStore().items).toEqual([])
    first = false
    state.read = async name => name === 'factories' ? [factory('新授权工厂', 'sewing', 'hunan'), { ...factory('无权工厂'), id: 'denied' }] : records(name, '2026-08')
    await w.find('[role=alert] button').trigger('click'); await flushPromises()
    expect(w.find('tbody').text()).toContain('新授权工厂')
    expect(w.find('tbody').text()).not.toContain('无权工厂')
  })

  it('unmount detaches identity listeners and prevents pending store commits', async () => {
    const pending = deferred<unknown[]>()
    state.read = async () => pending.promise
    const w = view(); await flushPromises()
    expect(state.listeners.size).toBe(1)
    w.unmount(); wrappers.splice(wrappers.indexOf(w), 1)
    expect(state.listeners.size).toBe(0)
    pending.resolve([factory('不应提交')]); await flushPromises()
    expect(useFactoriesStore().items).toEqual([])
    expect(useScoresStore().items).toEqual([])
  })

  it('does not restore another account range cache after the scoring page was unmounted', async () => {
    await cachedAugust()
    const auth = useAuthStore(); auth.userId = 'synthetic-2'
    state.record = { id: 'synthetic-2', permissions: {} }
    state.read = async name => name === 'factories' ? [factory('新账号工厂')] : records(name, '2026-08')
    const w = view(); await flushPromises()
    expect(w.find('tbody').text()).toContain('新账号工厂')
    expect(useFactoriesStore().items[0]?.name).toBe('新账号工厂')
    expect(w.find('[role=alert]').exists()).toBe(false)
  })

  it('loading B September cannot authorize the surviving A August cache for B', async () => {
    await cachedAugust()
    const auth = useAuthStore(); auth.userId = 'synthetic-2'
    state.record = { id: 'synthetic-2', permissions: { 'region.dongguan': false } }
    setAuthorizedCrafts(['sewing']); setPermissionOverrides({ 'region.dongguan': false })
    let augustReads = 0
    const firstAugust = deferred<unknown[]>()
    state.read = async (name, options) => {
      if (name === 'factories') return [factory('B授权工厂', 'sewing', 'hunan')]
      if (name === 'monthly_scores') {
        const month = options?.filter?.includes('2026-09') ? '2026-09' : '2026-08'
        if (month === '2026-08' && ++augustReads === 1) return firstAugust.promise
        return [{ ...score(month), status: 'approved' }]
      }
      if (name === 'orders') return [order('2026-08', 800), order('2026-09', 900)]
      return []
    }
    const w = view()
    // Change before mount's August request settles; B September is the first
    // completed B range, while A August remains inside the real store cache.
    await w.find('input[type=month]').setValue('2026-09'); await flushPromises()
    expect(w.find('tbody').text()).toContain('900.00')
    w.unmount(); wrappers.splice(wrappers.indexOf(w), 1)
    const readsBefore = augustReads
    const reopened = view(); await flushPromises()
    expect(augustReads).toBe(readsBefore + 1)
    expect(reopened.find('tbody').text()).toContain('800.00')
    expect(reopened.find('tbody').text()).toContain('B授权工厂')
    expect(reopened.find('tbody').text()).toContain('已审批')
    expect(reopened.find('tbody').text()).not.toContain('当前工厂')
    expect(useScoresStore().items[0]?.status).toBe('approved')
    firstAugust.resolve([score('2026-08')]); await flushPromises()
    expect(useScoresStore().items[0]?.status).toBe('approved')
    expect(reopened.find('tbody').text()).toContain('800.00')
  })
})
