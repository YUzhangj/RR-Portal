<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RecordModel } from 'pocketbase'
import type { Factory } from '../types/factory'
import { REGION_LABELS, regionOf, type Region } from '../constants/roles'
import { pb } from '../pb'
import { usePatrolDialog } from '../composables/usePatrolDialog'
import { PATROL_FIELDS } from '../utils/qualityPatrol'
import { matchPatrolFactories, parsePatrolWorkbook, patrolImportStatus, validPatrolDate, type PatrolImportResult } from '../utils/qualityPatrolImport'
const props = defineProps<{ factories: Factory[]; records: RecordModel[]; regions: Region[]; initialRegion: Region | '' }>()
const emit = defineEmits<{ close: []; saved: [date: string, region: Region] }>()
const region = ref<Region | ''>(props.initialRegion || (props.regions.length === 1 ? props.regions[0]! : ''))
const checkDate = ref('')
const source = ref<PatrolImportResult | null>(null)
const busy = ref(false)
const reading = ref(false)
const error = ref('')
const message = ref('')
const existing = ref(props.records.slice())
const { setDialog, keydown } = usePatrolDialog(() => emit('close'), () => busy.value || reading.value)
const candidates = computed(() => props.factories.filter(f => regionOf(f) === region.value))
const rows = computed(() => source.value?.rows || [])
const locked = computed(() => busy.value || rows.value.some(r => r.saved))
watch(candidates, () => { if (source.value && !locked.value) matchPatrolFactories(rows.value, candidates.value) })
const status = (row: typeof rows.value[number]) => patrolImportStatus(row, rows.value, existing.value.map(r => ({ factory: r.factory, check_date: r.check_date })), checkDate.value)
const ready = computed(() => rows.value.filter(r => status(r) === '可导入'))
const invalid = computed(() => rows.value.filter(r => !['可导入', '已存在，将跳过', '已导入'].includes(status(r))))
const conflict = computed(() => source.value?.region && source.value.region !== region.value ? '文件标题厂区与所选厂区不一致，请核对。' : '')
const canConfirm = computed(() => !!region.value && validPatrolDate(checkDate.value) && ready.value.length > 0 && !invalid.value.length && !conflict.value && !reading.value && !busy.value)
async function readFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  source.value = null; error.value = ''; message.value = ''; reading.value = true
  try {
    if (!/\.xlsx$/i.test(file.name) || file.size > 50 * 1024 * 1024) throw new Error('请选择不超过50MB的 .xlsx 文件')
    source.value = parsePatrolWorkbook(await file.arrayBuffer())
    checkDate.value = source.value.checkDate
    matchPatrolFactories(rows.value, candidates.value)
  } catch (e) { error.value = (e as Error).message || '文件读取失败，请检查文件格式。' }
  finally { reading.value = false }
}
async function confirmImport() {
  if (!canConfirm.value) return
  busy.value = true; error.value = ''; message.value = ''
  let saved = 0
  try {
    // Recheck immediately before writing; existing records are never overwritten.
    existing.value = await pb.collection('quality_patrols').getFullList({ sort: '-check_date' })
    for (const row of rows.value) {
      if (status(row) !== '可导入') { if (status(row) === '已存在，将跳过') row.saveError = ''; continue }
      row.saveError = ''
      const body = new FormData()
      body.append('factory', row.factory); body.append('check_date', checkDate.value)
      for (const [key, value] of Object.entries(row.values)) body.append(key, value === null ? 'null' : String(value))
      for (const photo of row.photos) body.append('photos', photo)
      try {
        const record = await pb.collection('quality_patrols').create(body)
        existing.value.push(record); row.saved = true; saved++
      } catch { row.saveError = '保存失败，可重试；同厂同日已存在的记录不会覆盖。' }
    }
    message.value = `本次成功导入 ${saved} 条；${rows.value.filter(r => status(r) === '已存在，将跳过').length} 条已存在并跳过。${rows.value.some(r => r.saveError) ? '部分记录失败，请查看行内提示后重试。' : ''}`
    emit('saved', checkDate.value, region.value as Region)
  } catch { error.value = '无法核对已有记录，未开始导入，请重试。' }
  finally { busy.value = false }
}
</script>
<template>
  <div class="overlay"><section :ref="setDialog" class="dialog" tabindex="-1" @keydown="keydown" role="dialog" aria-modal="true" aria-labelledby="import-title">
    <header><h3 id="import-title">导入 Excel 巡查记录</h3><button :disabled="busy || reading" @click="emit('close')">关闭</button></header>
    <p>使用“2026年9月18日湖南加工厂检查总结.xlsx”格式，每行对应一家工厂的一次巡查。导入明细和内嵌现场照片，合计与评级汇总自动重新计算。</p>
    <div class="controls">
      <label>导入厂区<select v-model="region" :disabled="locked || reading"><option value="">请选择厂区</option><option v-for="r in regions" :key="r" :value="r">{{ REGION_LABELS[r] }}</option></select></label>
      <label>选择 Excel<input type="file" accept=".xlsx" :disabled="!region || locked || reading" @change="readFile" /></label>
      <label>检查日期<input v-model="checkDate" type="date" :disabled="locked || reading" /></label>
    </div>
    <p v-if="reading" role="status">正在读取明细和照片…</p>
    <p v-if="error || conflict" role="alert" class="error">{{ error || conflict }}</p>
    <template v-if="source">
      <p>已读取 {{ rows.length }} 条记录、{{ rows.reduce((sum, r) => sum + r.photos.length, 0) }} 张照片。可导入 {{ ready.length }} 条，需处理 {{ invalid.length }} 条。同厂同日已有记录将跳过，不覆盖。</p>
      <p v-for="warning in source.warnings" :key="warning" class="warning">{{ warning }}</p>
      <p v-if="!checkDate" class="warning">未识别到完整日期，请手动填写检查日期。</p>
      <div class="scroll"><table><thead><tr><th>Excel行</th><th>原厂名</th><th>匹配工厂</th><th>状态</th><th v-for="f in PATROL_FIELDS" :key="f.key">{{ f.label }}</th><th>照片</th></tr></thead><tbody>
        <tr v-for="row in rows" :key="row.rowNo"><td>{{ row.rowNo }}</td><td>{{ row.factoryName }}</td><td><select v-model="row.factory" :disabled="busy || row.saved"><option value="">请选择匹配工厂</option><option v-for="f in candidates" :key="f.id" :value="f.id">{{ f.name }}</option></select></td><td><span :class="{ error: !['可导入', '已存在，将跳过', '已导入'].includes(status(row)) }">{{ status(row) }}</span><p v-if="row.saveError" class="error">{{ row.saveError }}</p><p v-for="warning in row.warnings" :key="warning" class="warning">{{ warning }}</p></td><td v-for="f in PATROL_FIELDS" :key="f.key">{{ row.values[f.key] ?? '—' }}</td><td>{{ row.photos.length }} 张</td></tr>
      </tbody></table></div>
    </template>
    <p v-if="message" role="status">{{ message }}</p>
    <footer><button :disabled="busy || reading" @click="emit('close')">{{ rows.some(r => r.saved) ? '完成' : '取消' }}</button><button class="primary" :disabled="!canConfirm" @click="confirmImport">{{ busy ? '正在导入…' : `确认导入 ${ready.length} 条` }}</button></footer>
  </section></div>
</template>
<style scoped>
.overlay { position: fixed; inset: 0; z-index: 1000; background: #17203380; display: grid; place-items: center; padding: 20px; }
.dialog { background: white; padding: 24px; border-radius: 14px; width: min(1400px, 100%); max-height: 90vh; overflow: auto; }
header, .controls, footer { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; } header { justify-content: space-between; } footer { justify-content: flex-end; margin-top: 16px; } h3 { margin: 0; }
label { display: flex; flex-direction: column; gap: 6px; } select, input, button { font: inherit; padding: 8px 12px; border: 1px solid #cbd0dc; border-radius: 6px; background: white; max-width: 100%; } button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; } p { line-height: 1.6; }
.scroll { overflow: auto; max-height: 50vh; margin-top: 18px; } table { border-collapse: collapse; } th, td { border: 1px solid #d3d7df; padding: 10px; min-width: 120px; max-width: 300px; white-space: pre-wrap; vertical-align: top; } th { background: #f3f4f8; position: sticky; top: 0; } .error { color: #b42318; } .warning { color: #845100; } .primary { background: #4f46e5; color: white; }
</style>
