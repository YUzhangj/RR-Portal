<script lang="ts">
// The existing range cache has no account key. Reuse only snapshots this
// page has proved belong to the same account and permission scope.
const scoringCacheOwners = new WeakMap<object, Map<string, string>>()
</script>
<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppLayout from '../components/AppLayout.vue'
import { useFactoriesStore, filterByCraft } from '../stores/factories'
import { useScoresStore } from '../stores/scores'
import { useScoreTemplatesStore } from '../stores/scoreTemplates'
import { useAuthStore } from '../stores/auth'
import { pb } from '../pb'
import { computeFactoryStats } from '../utils/factoryStats'
import { latestPatrolGrades, lowerGrade, type PatrolRating } from '../utils/scoringPatrolGrade'
import {
  factoryIdsWithOrdersInRange,
  filterMonthlyScoringData,
  mergeAutomaticScores,
  orderMonth,
  recordMonth,
} from '../utils/monthlyAutoScoring'
import {
  monthsInScoringRange,
  resolveScoringRange,
  summarizeFactoryScores,
  type ScoringRangeMode,
} from '../utils/scoringDateRange'
import { allowedCrafts, allowedRegions, canViewCraft } from '../utils/permissions'
import { CRAFT_LABELS, REGION_LABELS, regionOf, REGIONS, type Craft, type Region } from '../constants/roles'
import type { MonthlyScore, ScoreTemplate } from '../types/score'
import type { Factory } from '../types/factory'
import type { Order } from '../types/order'
import type { QualityInspection } from '../types/qualityInspection'
import type { Quality5sCheck } from '../types/quality5s'

const route = useRoute()
const router = useRouter()
const requestedMonth = String(route.query.month ?? '')
const month = ref(/^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : new Date().toISOString().slice(0, 7))
const factories = useFactoriesStore()
const scores = useScoresStore()
const templates = useScoreTemplatesStore()
const auth = useAuthStore()
const deptFilter = ref('')
const regionFilter = ref<Region | ''>('')
const search = ref('')
const rangeMode = ref<ScoringRangeMode>('month')
const customStart = ref(month.value)
const customEnd = ref(month.value)
const loadingScores = ref(false)
const loadError = ref('')
const loadedContext = ref('')
let loadRequest = 0
const autoScoring = ref(false)
const autoProgress = ref('')
const scoringOrders = ref<Order[]>([])
const scoringInspections = ref<QualityInspection[]>([])
const scoringPatrols = ref<PatrolRating[]>([])
const patrolLoadError = ref('')
async function loadPatrols() {
  try {
    const records = await pb.collection('quality_patrols').getFullList<PatrolRating>({ fields: 'id,factory,check_date,grade' })
    return { records, error: '' }
  } catch {
    return { records: [] as PatrolRating[], error: '巡查评级加载失败，综合评级暂不可用，请重试。' }
  }
}
const myRegions = computed(() => (auth.role ? allowedRegions(auth.role) : REGIONS))

const gradeCls: Record<string, string> = { A: 'badge-A', B: 'badge-B', C: 'badge-C', D: 'badge-D' }
const statusLabel: Record<string, string> = { draft: '草稿', submitted: '已提交', approved: '已审批' }
const formatAmount = (value: number | undefined) => value == null ? '—' : value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const selectedRange = computed(() => resolveScoringRange(rangeMode.value, month.value, customStart.value, customEnd.value))
const identityKey = () => JSON.stringify([
  auth.userId, auth.role,
  allowedCrafts(), auth.role ? allowedRegions(auth.role) : [],
  pb.authStore?.record?.id, pb.authStore?.record?.permissions,
])
const contextKey = () => JSON.stringify([selectedRange.value.start, selectedRange.value.end, identityKey()])
const rangeKey = (start: string, end: string) => `${start}:${end}`
const snapshotReady = computed(() => !!loadedContext.value && loadedContext.value === contextKey())
const rangeMonthCount = computed(() => monthsInScoringRange(selectedRange.value))
const isRange = computed(() => rangeMode.value !== 'month')
const rangeLabel = computed(() => selectedRange.value.start === selectedRange.value.end
  ? selectedRange.value.start
  : `${selectedRange.value.start} 至 ${selectedRange.value.end}`)
const factoryIdsWithOrders = computed(() => factoryIdsWithOrdersInRange(
  scoringOrders.value,
  selectedRange.value.start,
  selectedRange.value.end,
))

const monthlyScoreByFactory = computed(() => {
  const m: Record<string, MonthlyScore> = {}
  for (const s of scores.items) m[s.factory] = s
  return m
})

const patrolByFactory = computed(() => latestPatrolGrades(scoringPatrols.value, selectedRange.value.start, selectedRange.value.end))
const scoreByFactory = computed(() => {
  const grouped: Record<string, MonthlyScore[]> = {}
  for (const score of scores.items) (grouped[score.factory] ??= []).push(score)
  const ids = new Set([...Object.keys(grouped), ...Object.keys(patrolByFactory.value)])
  return Object.fromEntries([...ids].map((factoryId) => {
    const summary = summarizeFactoryScores(grouped[factoryId] ?? [])
    const patrol = patrolByFactory.value[factoryId]
    return [factoryId, {
      ...summary,
      monthlyGrade: summary.grade,
      grade: patrolLoadError.value ? undefined : lowerGrade(summary.grade, patrol?.grade),
    }]
  }))
})
const gradeTitle = (id: string) => {
  if (patrolLoadError.value) return patrolLoadError.value
  const summary = scoreByFactory.value[id]
  const patrol = patrolByFactory.value[id]
  return `月度评分等级：${summary?.monthlyGrade ?? '无评分'}；巡查现场：${patrol ? `${patrol.date} ${patrol.grade}级` : '所选范围内无有效评级'}；综合评级取较低等级`
}

// 产值与产值管理一致，按下单月份；货期与自动评分一致，按交货月份。
const metricsByFactory = computed(() => {
  const grouped: Record<string, { output?: number; cost?: number; delayedOrders: Set<string> }> = {}
  const metric = (id: string) => grouped[id] ??= { delayedOrders: new Set<string>() }
  const inRange = (month: string) => !!month && month >= selectedRange.value.start && month <= selectedRange.value.end
  for (const order of scoringOrders.value) {
    const row = metric(order.factory)
    if (inRange(recordMonth(order.order_date))) {
      if (order.amount != null) row.output = (row.output ?? 0) + (Number(order.amount) || 0)
      if (order.quote_labor_price != null && order.quantity != null) {
        row.cost = (row.cost ?? 0) + (Number(order.quote_labor_price) || 0) * (Number(order.quantity) || 0)
      }
    }
    if (inRange(orderMonth(order)) && order.status !== 'cancelled') {
      if (order.is_delayed || Number(order.delay_days) > 0) {
        row.delayedOrders.add(order.order_no?.trim() ? `order:${order.order_no.trim()}` : `record:${order.id}`)
      }
    }
  }
  return grouped
})
// 直接使用品质检验明细，与工厂品质统计的合格率保持相同口径。
const qualityByFactory = computed(() => {
  const grouped: Record<string, QualityInspection[]> = {}
  for (const inspection of scoringInspections.value) {
    const month = recordMonth(inspection.inspect_date)
    if (!inspection.factory || !month || month < selectedRange.value.start || month > selectedRange.value.end) continue
    ;(grouped[inspection.factory] ??= []).push(inspection)
  }
  return Object.fromEntries(Object.entries(grouped).map(([id, records]) => [id, computeFactoryStats([], records)]))
})
const passRate = (id: string) => {
  if (loadingScores.value) return '加载中…'
  return qualityByFactory.value[id]?.intRate.replace('-', '—') ?? '—'
}
const qualityTitle = (id: string) => {
  const stats = qualityByFactory.value[id]
  return stats ? `品质检验明细：合格 ${stats.intPass} / 验货 ${stats.intInspect} 条` : '品质检验明细暂无数据'
}

const rows = computed(() => {
  if (!snapshotReady.value || loadingScores.value || loadError.value) return []
  let list = filterByCraft(factories.items, null).filter((f) => allowedCrafts().includes(f.craft))
  list = list.filter((f) => factoryIdsWithOrders.value.has(f.id))
  list = list.filter((f) => myRegions.value.includes(regionOf(f)))
  if (regionFilter.value) list = list.filter((f) => regionOf(f) === regionFilter.value)
  if (deptFilter.value) list = list.filter((f) => f.craft === deptFilter.value)
  const query = search.value.trim().toLowerCase()
  if (query) list = list.filter((f) => f.name.toLowerCase().includes(query))
  return [...list].sort((a, b) => {
    const aScore = scoreByFactory.value[a.id]?.totalScore
    const bScore = scoreByFactory.value[b.id]?.totalScore
    if (aScore == null && bScore == null) return a.name.localeCompare(b.name, 'zh-CN')
    if (aScore == null) return 1
    if (bScore == null) return -1
    return bScore - aScore || a.name.localeCompare(b.name, 'zh-CN')
  })
})

async function load(force = false) {
  const request = ++loadRequest
  const range = { ...selectedRange.value }
  const context = contextKey()
  const current = () => request === loadRequest && context === contextKey()
  const cachedOrders = !force && scoringCacheOwners.get(scores)?.get(rangeKey(range.start, range.end)) === identityKey()
    ? scores.restoreScoringList(range.start, range.end) : null
  loadingScores.value = true
  loadError.value = ''
  loadedContext.value = ''
  scoringOrders.value = []
  scoringInspections.value = []
  scoringPatrols.value = []
  patrolLoadError.value = ''
  try {
    if (cachedOrders) {
      const [inspections, patrols] = await Promise.all([
        pb.collection('quality_inspections').getFullList<QualityInspection>(),
        loadPatrols(),
      ])
      if (!current()) return
      scoringOrders.value = cachedOrders
      scoringInspections.value = inspections
      scoringPatrols.value = patrols.records
      patrolLoadError.value = patrols.error
      loadedContext.value = context
      return
    }
    // Read into temporary snapshots: the stores' fetch helpers write their
    // shared state before returning, so checking only afterwards is too late.
    const [factoryRecords, scoreRecords, templateRecords, orders, inspections, patrols] = await Promise.all([
      pb.collection('factories').getFullList<Factory>({ sort: 'name' }),
      pb.collection('monthly_scores').getFullList<MonthlyScore>({
        filter: range.start === range.end ? `year_month = "${range.start}"` : `year_month >= "${range.start}" && year_month <= "${range.end}"`,
        expand: 'factory', ...(range.start === range.end ? {} : { sort: 'year_month' }),
      }),
      pb.collection('score_templates').getFullList<ScoreTemplate>({ sort: 'sort_order' }),
      pb.collection('orders').getFullList<Order>(),
      pb.collection('quality_inspections').getFullList<QualityInspection>(),
      loadPatrols(),
    ])
    if (!current()) return
    factories.items = factoryRecords.filter(factory => canViewCraft(factory.craft))
    scores.items = scoreRecords.filter(score => {
      const craft = (score as MonthlyScore & { expand?: { factory?: { craft?: Craft } } }).expand?.factory?.craft
      return !craft || canViewCraft(craft)
    })
    templates.items = templateRecords
    scoringOrders.value = orders
    scoringInspections.value = inspections
    scoringPatrols.value = patrols.records
    patrolLoadError.value = patrols.error
    scores.rememberScoringList(range.start, range.end, orders)
    const owners = scoringCacheOwners.get(scores) ?? new Map<string, string>()
    owners.set(rangeKey(range.start, range.end), identityKey())
    scoringCacheOwners.set(scores, owners)
    loadedContext.value = context
  } catch {
    if (current()) loadError.value = '评分指标加载失败，请重试。'
  } finally {
    if (current()) loadingScores.value = false
  }
}

let identity = identityKey()
function invalidateIdentity() {
  const nextIdentity = identityKey()
  if (nextIdentity === identity) return
  identity = nextIdentity
  loadRequest++
  scoringCacheOwners.delete(scores)
  loadedContext.value = ''
  scoringOrders.value = []
  scoringInspections.value = []
  scoringPatrols.value = []
  patrolLoadError.value = ''
  loadingScores.value = false
  loadError.value = '账号或权限已变更，请重新加载评分指标。'
}
watch(() => [auth.userId, auth.role, auth.crafts], invalidateIdentity, { flush: 'sync' })
const stopAuth = pb.authStore?.onChange(invalidateIdentity)
onBeforeUnmount(() => { loadRequest++; stopAuth?.() })

function changeRangeMode() {
  if (rangeMode.value === 'custom') {
    customStart.value = selectedRange.value.start
    customEnd.value = selectedRange.value.end
  }
  void load(true)
}

async function changeMonth() {
  await router.replace({ path: '/scoring', query: { ...route.query, month: month.value } })
  await load(true)
}

async function calculateMonthScores() {
  if (autoScoring.value || loadingScores.value || !snapshotReady.value || loadError.value || isRange.value) return
  const context = contextKey(), request = loadRequest, scoringMonth = month.value, submittedBy = auth.userId ?? undefined
  const current = () => request === loadRequest && context === contextKey() && snapshotReady.value
  const requireCurrent = () => { if (!current()) throw new Error('账号、月份或指标范围已变更，已停止自动评分；已保存的结果保留') }
  // Keep the clicked scope even if requests settle after navigation or login.
  const factoriesToScore = rows.value.map(factory => ({ ...factory }))
  const existing = { ...monthlyScoreByFactory.value }
  const factoryTemplates = new Map(factoriesToScore.map(factory => [factory.id, templates.applicable(factory.craft).map(template => ({ ...template }))]))
  class ProtectedScore extends Error {}
  autoScoring.value = true
  autoProgress.value = '读取货期和品质数据...'
  try {
    const [orders, inspections, checks] = await Promise.all([
      pb.collection('orders').getFullList<Order>(),
      pb.collection('quality_inspections').getFullList<QualityInspection>(),
      pb.collection('quality_5s_checks').getFullList<Quality5sCheck>(),
    ])
    requireCurrent()
    scoringOrders.value = orders
    scoringInspections.value = inspections
    let saved = 0
    let skipped = 0
    for (let index = 0; index < factoriesToScore.length; index += 1) {
      const factory = factoriesToScore[index]
      requireCurrent()
      const original = existing[factory.id]
      if (original && original.status !== 'draft') {
        skipped += 1
        continue
      }
      autoProgress.value = `正在计算 ${index + 1}/${factoriesToScore.length}：${factory.name}`
      const monthlyData = filterMonthlyScoringData({
        orders: orders.filter((item) => item.factory === factory.id),
        inspections: inspections.filter((item) => item.factory === factory.id),
        checks: checks.filter((item) => item.factory === factory.id),
      }, scoringMonth)
      try {
        await scores.save(factory.id, scoringMonth, fresh => {
          // Do not recreate a deleted snapshot or overwrite a newer protected
          // record. This is a fresh-read guard, not a server transaction/CAS.
          if ((original ? fresh?.id !== original.id : fresh !== null) || (fresh && fresh.status !== 'draft')) throw new ProtectedScore()
          return {
            score_items: mergeAutomaticScores(factoryTemplates.get(factory.id) ?? [], fresh?.score_items ?? [], factory, monthlyData),
            status: 'submitted', submitted_by: submittedBy,
          }
        }, current)
      } catch (error) {
        if (!(error instanceof ProtectedScore)) throw error
        skipped += 1
        continue
      }
      requireCurrent()
      saved += 1
    }
    await scores.fetchByMonth(scoringMonth, current)
    requireCurrent()
    scores.rememberScoringList(scoringMonth, scoringMonth, orders)
    autoProgress.value = `自动评分完成：已提交 ${saved} 家${skipped ? `，跳过已提交/已审批 ${skipped} 家` : ''}`
  } catch (error) {
    autoProgress.value = `自动评分失败：${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    autoScoring.value = false
  }
}
load()
</script>
<template>
  <AppLayout>
    <div class="page">
      <div class="toolbar">
        <h2 style="margin:0">工厂月度评分</h2>
        <span class="muted">{{ rangeLabel }}</span>
        <span class="spacer"></span>
        <input v-model="search" class="factory-search" placeholder="搜索工厂名称" />
        <select v-model="regionFilter">
          <option value="">全部厂区</option>
          <option v-for="region in myRegions" :key="region" :value="region">{{ REGION_LABELS[region] }}厂区</option>
        </select>
        <select v-model="deptFilter">
          <option value="">全部部门</option>
          <option v-for="craft in allowedCrafts()" :key="craft" :value="craft">{{ CRAFT_LABELS[craft as Craft] }}</option>
        </select>
        <select v-model="rangeMode" aria-label="评分时间范围" @change="changeRangeMode">
          <option value="month">单月</option>
          <option value="two_months">近2个月</option>
          <option value="quarter">所在季度</option>
          <option value="year">所在年度</option>
          <option value="custom">自定义范围</option>
        </select>
        <template v-if="rangeMode === 'custom'">
          <label class="range-month">从 <input v-model="customStart" type="month" aria-label="开始月份" @change="load(true)" /></label>
          <span class="muted">至</span>
          <label class="range-month"><input v-model="customEnd" type="month" aria-label="结束月份" @change="load(true)" /></label>
        </template>
        <label v-else>{{ rangeMode === 'month' ? '月份' : '基准月份' }} <input v-model="month" type="month" @change="changeMonth" /></label>
        <button v-if="!isRange" class="ghost" :disabled="autoScoring || loadingScores || !snapshotReady || !!loadError" @click="calculateMonthScores">
          {{ autoScoring ? '自动评分中...' : '自动计算并提交本月评分' }}
        </button>
      </div>
      <p v-if="autoProgress" class="auto-progress">{{ autoProgress }}</p>
      <p v-if="loadError" role="alert" class="load-error">{{ loadError }} <button class="ghost mini" :disabled="loadingScores || autoScoring" @click="load(true)">重新加载指标</button></p>
      <p v-if="patrolLoadError" class="patrol-error" role="alert">{{ patrolLoadError }} <button class="ghost mini" :disabled="loadingScores" @click="load(true)">重试</button></p>
      <p class="metrics-hint">综合评级取月度评分与所选范围内最新巡查评级中较低等级，无巡查评级沿用月度评分；加工值按下单月份汇总产值；成本按下单月份汇总核价工价 × 数量；货期按交货月份统计延期订单数（按订单号去重，无延期为0）；合格率直接采用品质检验明细，按所选月份的合格单数 ÷ 验货总单数统计；IP管控与加工类型取工厂资料。缺少数据时显示“—”。</p>
      <div class="table-scroll" tabindex="0" aria-label="工厂月度评分表格">
      <table>
        <thead><tr><th>工厂</th><th>部门</th><th>综合评级</th><th>加工值</th><th>成本</th><th>货期</th><th>合格率</th><th>IP管控</th><th>加工类型</th><th>{{ isRange ? '评分月份' : '状态' }}</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="f in rows" :key="f.id">
            <td>
              <RouterLink
                class="factory-data-link"
                :to="`/factories/${f.id}/monthly-data/${selectedRange.end}`"
                :title="`查看该工厂 ${selectedRange.end} 的货期和品质数据`"
              >{{ f.name }}</RouterLink>
            </td>
            <td class="muted">{{ CRAFT_LABELS[f.craft] }}</td>
            <td :title="gradeTitle(f.id)">
              <span v-if="scoreByFactory[f.id]?.grade" class="badge" :class="gradeCls[scoreByFactory[f.id].grade!]">{{ scoreByFactory[f.id].grade }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td>{{ formatAmount(metricsByFactory[f.id]?.output) }}</td>
            <td>{{ formatAmount(metricsByFactory[f.id]?.cost) }}</td>
            <td>{{ metricsByFactory[f.id]?.delayedOrders.size ?? 0 }}</td>
            <td :title="qualityTitle(f.id)">{{ passRate(f.id) }}</td>
            <td>{{ f.ip_control?.trim() || '—' }}</td>
            <td>{{ f.processable_types?.trim() || '—' }}</td>
            <td>
              <span v-if="isRange" class="badge range-coverage" :title="`${rangeLabel} 共 ${rangeMonthCount} 个月`">
                {{ scoreByFactory[f.id]?.monthsScored ?? 0 }}/{{ rangeMonthCount }}个月
              </span>
              <span v-else class="badge" :class="scoreByFactory[f.id]?.status === 'approved' ? 'status-active' : scoreByFactory[f.id]?.status === 'submitted' ? 'badge-B' : 'status-eliminated'">
                {{ statusLabel[scoreByFactory[f.id]?.status ?? 'draft'] }}
              </span>
            </td>
            <td><RouterLink :to="`/factories/${f.id}/score/${selectedRange.end}`"><button class="ghost mini">{{ isRange ? '末月评分' : '评分' }} →</button></RouterLink></td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="11" class="hint" style="text-align:center">
              {{ loadError ? '评分指标未加载，请重试。' : loadingScores || !snapshotReady ? '正在加载...' : '当前评分范围内暂无订单工厂' }}
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  </AppLayout>
</template>
<style scoped>
.patrol-error { color: #b91c1c; font-size: .85rem; }
.metrics-hint { color: var(--text-soft); font-size: .82rem; line-height: 1.6; }
.table-scroll { overflow-x: auto; }
.table-scroll table { min-width: 1400px; }
.table-scroll th, .table-scroll td { white-space: nowrap; }
.mini { padding: .25rem .6rem; font-size: .8rem; }
.auto-progress { margin: .6rem 0; color: var(--text-soft); font-size: .88rem; }
.factory-search { width: 190px; min-width: 150px; }
.factory-data-link { color: var(--primary, #4f46e5); font-weight: 600; text-decoration: none; }
.factory-data-link:hover { text-decoration: underline; }
.range-month { display: inline-flex; align-items: center; gap: .35rem; }
.range-month input { width: 138px; }
.range-coverage { background: #eef2ff; color: #4338ca; white-space: nowrap; }
</style>
