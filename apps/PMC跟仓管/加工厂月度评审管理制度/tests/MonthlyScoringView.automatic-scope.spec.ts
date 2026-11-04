import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { useScoresStore } from '../src/stores/scores'
import { setAuthorizedCrafts, setPermissionOverrides } from '../src/utils/permissions'

const state = vi.hoisted(() => ({
  auth: { userId: 'account-A', role: 'admin', crafts: [] as string[] },
  record: { id: 'account-A', permissions: {} as Record<string, boolean> },
  listeners: new Set<() => void>(), orderReads: 0,
  pendingOrders: null as null | Promise<unknown[]>, writes: [] as { id: string; data: Record<string, unknown> }[],
  readScores: null as null | ((options?: { filter?: string }) => Promise<unknown[]> | null),
  pendingUpdate: null as null | Promise<void>,
  scores: [] as Record<string, any>[],
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
  collection: (name: string) => ({
    getFullList: async (options?: { filter?: string }) => {
      if (name === 'factories') return [{ id: 'f', name: 'Synthetic factory', craft: 'injection', region: 'dongguan' }]
      if (name === 'score_templates') return [{ id: 'delivery', module: 'delivery', max_score: 20, is_active: true, crafts: [], sort_order: 1 }]
      if (name === 'orders') {
        if (++state.orderReads === 2 && state.pendingOrders) return state.pendingOrders
        return allOrders()
      }
      if (name === 'monthly_scores') {
        const delayed = state.readScores?.(options)
        if (delayed) return delayed
        const month = options?.filter?.match(/year_month = "([^"]+)"/)?.[1]
        return structuredClone(state.scores.filter(s => !month || s.year_month === month))
      }
      return []
    },
    update: async (id: string, data: Record<string, unknown>) => {
      state.writes.push({ id, data: structuredClone(data) })
      const existing = state.scores.find(s => s.id === id)!
      Object.assign(existing, structuredClone(data)); await state.pendingUpdate; return structuredClone(existing)
    },
    create: async (data: Record<string, unknown>) => {
      const saved = { id: 'new-score', ...structuredClone(data) }; state.scores.push(saved)
      state.writes.push({ id: saved.id, data: structuredClone(data) }); return structuredClone(saved)
    },
  }),
} }))
import MonthlyScoringView from '../src/views/MonthlyScoringView.vue'
import { useAuthStore } from '../src/stores/auth'

function allOrders() {
  return ['2026-08', '2026-09'].map((month, i) => ({ id: `order-${month}`, factory: 'f', order_no: `PO-${month}`,
    order_date: month + '-01', delivery_date: month + '-10', quantity: 10, amount: i ? 900 : 800, is_delayed: false }))
}
function deferred<T = unknown[]>() { let resolve!: (rows: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const wrappers: ReturnType<typeof mount>[] = []
function view() { const wrapper = mount(MonthlyScoringView); wrappers.push(wrapper); return wrapper }
beforeEach(() => {
  setActivePinia(createPinia()); const auth = useAuthStore(); auth.userId = 'account-A'; auth.role = 'admin'; auth.crafts = []
  state.record = { id: 'account-A', permissions: {} }; state.orderReads = 0; state.pendingOrders = null; state.writes = []
  state.readScores = null; state.pendingUpdate = null
  state.scores = ['2026-08', '2026-09'].map(month => ({ id: 'score-' + month, factory: 'f', year_month: month,
    status: 'draft', score_items: [{ template_id: 'delivery', score: 5 }], flag: 'none' }))
  setAuthorizedCrafts(null); setPermissionOverrides(null)
})
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); setAuthorizedCrafts(null); setPermissionOverrides(null) })

describe('automatic scoring keeps the clicked scope and existing protected records', () => {
  it('does not submit the newly selected month when the original automatic read returns late', async () => {
    const pending = deferred(); state.pendingOrders = pending.promise
    const wrapper = view(); await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === '自动计算并提交本月评分')!.trigger('click')
    await wrapper.find('input[type=month]').setValue('2026-09'); await flushPromises()
    expect(wrapper.findAll('tbody tr')[0].findAll('td')[3].text()).toBe('900.00')
    pending.resolve(allOrders()); await flushPromises()
    expect(state.writes).toEqual([])
    expect(useScoresStore().items[0]?.year_month).toBe('2026-09')
    expect(wrapper.findAll('tbody tr')[0].findAll('td')[3].text()).toBe('900.00')
  })

  it('does not submit as the new account or overwrite its loaded snapshot after an account switch', async () => {
    const pending = deferred(); state.pendingOrders = pending.promise
    const wrapper = view(); await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === '自动计算并提交本月评分')!.trigger('click')
    const auth = useAuthStore(); auth.userId = 'account-B'; state.record = { id: 'account-B', permissions: {} }
    for (const listener of state.listeners) listener()
    await flushPromises(); await wrapper.find('input[type=month]').setValue('2026-09'); await flushPromises()
    expect(useScoresStore().items[0]?.status).toBe('draft')
    pending.resolve(allOrders()); await flushPromises()
    expect(state.writes).toEqual([])
    expect(useScoresStore().items[0]?.status).toBe('draft')
  })

  it('does not overwrite a score that was approved after the list snapshot was loaded', async () => {
    const pending = deferred(); state.pendingOrders = pending.promise
    const wrapper = view(); await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === '自动计算并提交本月评分')!.trigger('click')
    state.scores[0]!.status = 'approved'; state.scores[0]!.score_items = [{ template_id: 'delivery', score: 19 }]
    pending.resolve(allOrders()); await flushPromises()
    expect(state.writes).toEqual([])
    expect(state.scores[0]!.status).toBe('approved'); expect(state.scores[0]!.score_items[0].score).toBe(19)
  })

  it('does not recreate a draft deleted after the list snapshot was loaded', async () => {
    const pending = deferred(); state.pendingOrders = pending.promise
    const wrapper = view(); await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === '自动计算并提交本月评分')!.trigger('click')
    state.scores = state.scores.filter(s => s.year_month !== '2026-08')
    pending.resolve(allOrders()); await flushPromises()
    expect(state.writes).toEqual([]); expect(state.scores.some(s => s.year_month === '2026-08')).toBe(false)
  })

  it('rechecks the scope after the store fresh-record read and before making a write', async () => {
    const wrapper = view(); await flushPromises(); const lookup = deferred()
    const august = structuredClone(state.scores.filter(s => s.year_month === '2026-08'))
    state.readScores = options => options?.filter?.startsWith('factory =') ? lookup.promise : null
    await wrapper.findAll('button').find(b => b.text() === '自动计算并提交本月评分')!.trigger('click'); await flushPromises()
    await wrapper.find('input[type=month]').setValue('2026-09'); await flushPromises()
    lookup.resolve(august); await flushPromises()
    expect(state.writes).toEqual([]); expect(useScoresStore().items.map(s => s.year_month)).toEqual(['2026-09'])
  })

  it('does not commit an already sent old-month response into the newly loaded store', async () => {
    const wrapper = view(); await flushPromises(); const response = deferred<void>(); state.pendingUpdate = response.promise
    await wrapper.findAll('button').find(b => b.text() === '自动计算并提交本月评分')!.trigger('click'); await flushPromises()
    expect(state.writes).toHaveLength(1); expect(state.scores[0]!.status).toBe('submitted')
    await wrapper.find('input[type=month]').setValue('2026-09'); await flushPromises()
    response.resolve(); await flushPromises()
    expect(state.writes).toHaveLength(1); expect(useScoresStore().items.map(s => s.year_month)).toEqual(['2026-09'])
    expect(wrapper.findAll('tbody tr')[0].findAll('td')[3].text()).toBe('900.00')
  })

  it('does not let the final old-month refresh overwrite a newer month', async () => {
    const wrapper = view(); await flushPromises(); const oldRefresh = deferred()
    state.readScores = options => !options?.filter?.startsWith('factory =') && options?.filter?.includes('2026-08') ? oldRefresh.promise : null
    await wrapper.findAll('button').find(b => b.text() === '自动计算并提交本月评分')!.trigger('click'); await flushPromises()
    expect(state.writes).toHaveLength(1)
    await wrapper.find('input[type=month]').setValue('2026-09'); await flushPromises()
    oldRefresh.resolve(structuredClone(state.scores.filter(s => s.year_month === '2026-08'))); await flushPromises()
    expect(useScoresStore().items.map(s => s.year_month)).toEqual(['2026-09'])
    expect(wrapper.findAll('tbody tr')[0].findAll('td')[3].text()).toBe('900.00')
  })

  it('still submits a normal draft once in the selected month and refreshes its real saved payload', async () => {
    const wrapper = view(); await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === '自动计算并提交本月评分')!.trigger('click'); await flushPromises()
    expect(state.writes).toHaveLength(1); expect(state.writes[0]!.id).toBe('score-2026-08')
    expect(state.scores[0]!.status).toBe('submitted'); expect(state.scores[0]!.submitted_by).toBe('account-A')
    expect(useScoresStore().items[0]?.status).toBe('submitted')
    expect(state.scores[1]!.status).toBe('draft')
  })

  it('still creates an absent monthly score without changing the other month', async () => {
    state.scores = state.scores.filter(s => s.year_month !== '2026-08')
    const wrapper = view(); await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === '自动计算并提交本月评分')!.trigger('click'); await flushPromises()
    expect(state.writes).toHaveLength(1)
    expect(state.scores.find(s => s.year_month === '2026-08')).toMatchObject({ status: 'submitted', submitted_by: 'account-A' })
    expect(state.scores.find(s => s.year_month === '2026-09')?.status).toBe('draft')
    expect(useScoresStore().items[0]?.year_month).toBe('2026-08')
  })
})
