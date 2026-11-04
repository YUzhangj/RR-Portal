import { defineStore } from 'pinia'
import { ref } from 'vue'
import { pb } from '../pb'
import type { MonthlyScore } from '../types/score'
import type { Order } from '../types/order'
import { canViewCraft } from '../utils/permissions'
import type { Craft } from '../constants/roles'

interface ScoringListCacheEntry {
  orders: Order[]
  scores: MonthlyScore[]
}

export const useScoresStore = defineStore('scores', () => {
  const items = ref<MonthlyScore[]>([])
  const scoringListCache = new Map<string, ScoringListCacheEntry>()

  const listCacheKey = (startMonth: string, endMonth: string) => `${startMonth}:${endMonth}`

  function keepViewableCrafts(records: MonthlyScore[]) {
    return records.filter((item) => {
      const craft = (item as any).expand?.factory?.craft as Craft | undefined
      return !craft || canViewCraft(craft)
    })
  }

  async function fetchByMonth(yearMonth: string, isCurrent?: () => boolean) {
    const records = await pb.collection('monthly_scores').getFullList<MonthlyScore>({
      filter: `year_month = "${yearMonth}"`,
      expand: 'factory',
    })
    if (!isCurrent || isCurrent()) items.value = keepViewableCrafts(records)
  }
  async function fetchByRange(startMonth: string, endMonth: string) {
    const records = await pb.collection('monthly_scores').getFullList<MonthlyScore>({
      filter: `year_month >= "${startMonth}" && year_month <= "${endMonth}"`,
      expand: 'factory',
      sort: 'year_month',
    })
    items.value = keepViewableCrafts(records)
  }
  async function getOne(factoryId: string, yearMonth: string): Promise<MonthlyScore | null> {
    const r = await pb.collection('monthly_scores').getFullList<MonthlyScore>({
      filter: `factory = "${factoryId}" && year_month = "${yearMonth}"`,
    })
    return r[0] ?? null
  }

  function findCached(factoryId: string, yearMonth: string): MonthlyScore | null {
    return items.value.find((item) => item.factory === factoryId && item.year_month === yearMonth) ?? null
  }

  function rememberScoringList(startMonth: string, endMonth: string, orders: Order[]) {
    scoringListCache.set(listCacheKey(startMonth, endMonth), {
      orders: [...orders],
      scores: [...items.value],
    })
  }

  function restoreScoringList(startMonth: string, endMonth: string): Order[] | null {
    const cached = scoringListCache.get(listCacheKey(startMonth, endMonth))
    if (!cached) return null
    items.value = [...cached.scores]
    return [...cached.orders]
  }

  function updateCachedScore(saved: MonthlyScore) {
    const sameScore = (item: MonthlyScore) => item.id === saved.id
      || (item.factory === saved.factory && item.year_month === saved.year_month)
    const index = items.value.findIndex(sameScore)
    if (index >= 0) items.value[index] = saved
    else items.value.push(saved)
    for (const [key, cached] of scoringListCache.entries()) {
      const [startMonth, endMonth] = key.split(':')
      if (saved.year_month < startMonth || saved.year_month > endMonth) continue
      const cachedIndex = cached.scores.findIndex(sameScore)
      if (cachedIndex >= 0) cached.scores[cachedIndex] = saved
      else cached.scores.push(saved)
    }
  }

  async function save(factoryId: string, yearMonth: string,
    source: Partial<MonthlyScore> | ((existing: MonthlyScore | null) => Partial<MonthlyScore>),
    isCurrent?: () => boolean) {
    const existing = await getOne(factoryId, yearMonth)
    if (isCurrent && !isCurrent()) throw new Error('账号、月份或指标范围已变更，已停止自动评分')
    // Automatic callers can recheck the fresh record and preserve manual items
    // before the existing authenticated save and cache update paths run.
    const data = typeof source === 'function' ? source(existing) : source
    const saved = existing
      ? await pb.collection('monthly_scores').update<MonthlyScore>(existing.id, data)
      : await pb.collection('monthly_scores').create<MonthlyScore>({
        factory: factoryId, year_month: yearMonth, status: 'draft', flag: 'none', ...data,
      })
    if (!isCurrent || isCurrent()) updateCachedScore(saved)
    return saved
  }
  return {
    items,
    fetchByMonth,
    fetchByRange,
    getOne,
    findCached,
    rememberScoringList,
    restoreScoringList,
    save,
  }
})
