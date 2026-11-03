<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RecordModel } from 'pocketbase'
import type { Factory } from '../types/factory'
import { usePatrolDialog } from '../composables/usePatrolDialog'
import { PATROL_FIELDS } from '../utils/qualityPatrol'
const props = defineProps<{ records: RecordModel[]; factories: Factory[]; photoUrl: (r: RecordModel, name: string) => string; photoReady: boolean; photoError: string }>()
const emit = defineEmits<{ close: []; photoFailed: []; refreshPhotos: [] }>()
const { setDialog, keydown } = usePatrolDialog(() => emit('close'))
const mode = ref<'single' | 'multiple'>('single')
const groups = computed(() => props.factories.map(f => ({
  ...f,
  visits: props.records.filter(r => r.factory === f.id).slice().sort((a, b) => a.check_date.localeCompare(b.check_date)),
})).filter(f => f.visits.length > 0))
const factory = ref('')
watch(groups, list => {
  if (!list.some(f => f.id === factory.value)) factory.value = (list.find(f => f.visits.length >= 2) || list[0])?.id || ''
}, { immediate: true })
const selected = ref<string[]>([])
const history = computed(() => groups.value.find(f => f.id === factory.value)?.visits || [])
watch(history, rows => { selected.value = rows.slice(-3).map(r => r.id) }, { immediate: true })
const multipleFactories = ref<string[]>([])
const multipleVisits = ref<string[]>([])
watch(groups, list => {
  multipleFactories.value = multipleFactories.value.filter(id => list.some(f => f.id === id))
  multipleVisits.value = multipleVisits.value.filter(id => list.some(f => f.visits.some(r => r.id === id)))
})
function toggleFactory(id: string, checked: boolean) {
  const visits = groups.value.find(f => f.id === id)?.visits || []
  multipleFactories.value = multipleFactories.value.filter(f => f !== id)
  multipleVisits.value = multipleVisits.value.filter(r => !visits.some(v => v.id === r))
  if (checked) {
    multipleFactories.value.push(id)
    multipleVisits.value.push(...visits.slice(-3).map(r => r.id))
  }
}
const compared = computed(() => mode.value === 'single'
  ? history.value.filter(r => selected.value.includes(r.id))
  : groups.value.filter(f => multipleFactories.value.includes(f.id)).flatMap(f => f.visits.filter(r => multipleVisits.value.includes(r.id))))
const canCompare = computed(() => mode.value === 'single' ? compared.value.length >= 2 : new Set(compared.value.map(r => r.factory)).size >= 2)
const factoryName = (id: string) => groups.value.find(f => f.id === id)?.name || ''
const value = (r: RecordModel, key: string) => key.endsWith('_date') ? r[key]?.slice(0, 10) || '—' : r[key] === '' || r[key] == null ? '—' : r[key]
const changed = (index: number, key: string) => index > 0 && compared.value[index]!.factory === compared.value[index - 1]!.factory && value(compared.value[index]!, key) !== value(compared.value[index - 1]!, key)
</script>
<template>
  <div class="overlay"><section :ref="setDialog" class="dialog" tabindex="-1" @keydown="keydown" role="dialog" aria-modal="true" aria-labelledby="compare-title">
    <header><h3 id="compare-title">{{ mode === 'single' ? '同一工厂多次巡查对比' : '不同加工厂多次巡查对比' }}</h3><button @click="emit('close')">关闭</button></header>
    <div class="modes" role="group" aria-label="对比方式">
      <button :aria-pressed="mode === 'single'" @click="mode = 'single'">同一工厂多次巡查对比</button>
      <button :aria-pressed="mode === 'multiple'" @click="mode = 'multiple'">不同加工厂多次巡查对比</button>
    </div>
    <p v-if="!groups.length">当前厂区暂无可对比的巡查记录。</p>
    <template v-else-if="mode === 'single'">
      <label>加工厂<select v-model="factory"><option v-for="f in groups" :key="f.id" :value="f.id">{{ f.name }}</option></select></label>
      <p>选择两次或更多巡查，按日期先后并排对比。黄色单元格表示相较左侧所选巡查发生变化。</p>
      <div class="dates"><label v-for="r in history" :key="r.id"><input v-model="selected" type="checkbox" :value="r.id" />{{ r.check_date.slice(0, 10) }}</label><button v-if="history.length" @click="selected = history.map(r => r.id)">选择全部日期</button></div>
      <p v-if="history.length < 2">该工厂目前不足两次巡查记录，请先登记或导入其他日期的巡查。</p><p v-else-if="!canCompare">请至少选择两个日期。</p>
    </template>
    <template v-else>
      <p>选择至少两家加工厂及各自的巡查日期，按工厂分组、日期先后并排对比。勾选工厂时默认选中最近三次巡查；黄色表示同一工厂相较前一次所选巡查的变化。</p>
      <div class="factory-groups">
        <div v-for="f in groups" :key="f.id" class="factory-group">
          <label><input type="checkbox" :checked="multipleFactories.includes(f.id)" @change="toggleFactory(f.id, ($event.target as HTMLInputElement).checked)" />{{ f.name }}</label>
          <div v-if="multipleFactories.includes(f.id)" class="dates">
            <label v-for="r in f.visits" :key="r.id"><input v-model="multipleVisits" type="checkbox" :value="r.id" :aria-label="`${f.name} ${r.check_date.slice(0, 10)}`" />{{ r.check_date.slice(0, 10) }}</label>
            <button @click="multipleVisits = [...new Set([...multipleVisits, ...f.visits.map(r => r.id)])]">选择全部日期</button>
          </div>
        </div>
      </div>
      <p v-if="!canCompare">请至少选择两家加工厂，每家至少选择一次巡查。</p>
    </template>
    <p v-if="photoError" role="alert">{{ photoError }} <button @click="emit('refreshPhotos')">刷新照片</button></p>
    <div v-if="canCompare" class="scroll"><table><thead><tr><th>巡查项目</th><th v-for="r in compared" :key="r.id"><span v-if="mode === 'multiple'" class="factory-name">{{ factoryName(r.factory) }}</span>{{ r.check_date.slice(0, 10) }}</th></tr></thead><tbody>
      <tr v-for="f in PATROL_FIELDS" :key="f.key"><th>{{ f.label }}</th><td v-for="(r, i) in compared" :key="r.id" :class="{ changed: changed(i, f.key) }">{{ value(r, f.key) }}</td></tr>
      <tr><th>可供客户参观</th><td v-for="r in compared" :key="r.id">{{ r.visitor_ready ? '是' : '否' }}</td></tr>
      <tr><th>A级但基本条件未达标</th><td v-for="r in compared" :key="r.id">{{ r.below_standard ? '是' : '否' }}</td></tr>
      <tr><th>现场照片</th><td v-for="r in compared" :key="r.id"><a v-for="name in photoReady ? r.photos || [] : []" :key="name" :href="photoUrl(r, name)" target="_blank" rel="noopener noreferrer"><img :src="photoUrl(r, name)" alt="巡查现场照片" referrerpolicy="no-referrer" loading="lazy" @error="emit('photoFailed')" /></a><span v-if="!r.photos?.length">—</span><span v-else-if="!photoReady">照片暂不可用</span></td></tr>
    </tbody></table></div>
  </section></div>
</template>
<style scoped>
.overlay { position: fixed; inset: 0; z-index: 1000; background: #17203380; display: grid; place-items: center; padding: 20px; }
.dialog { background: white; padding: 24px; border-radius: 14px; width: min(1200px, 100%); max-height: 90vh; overflow: auto; }
header, .dates { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; } header { justify-content: space-between; } h3 { margin: 0 0 16px; }
label { display: inline-flex; align-items: center; gap: 8px; } select, button { font: inherit; padding: 8px 12px; border: 1px solid #cbd0dc; border-radius: 6px; background: white; color: #202635; } p { color: #596275; line-height: 1.6; }
.modes { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; } .modes button[aria-pressed="true"] { background: #5146e5; color: white; border-color: #5146e5; }
.factory-groups { max-height: 240px; overflow: auto; border: 1px solid #d3d7df; border-radius: 8px; } .factory-group { padding: 12px; border-bottom: 1px solid #e7e9ef; } .factory-group .dates { margin-top: 10px; } .factory-name { display: block; margin-bottom: 4px; } select { max-width: 100%; }
.scroll { overflow: auto; max-height: 60vh; margin-top: 18px; } table { border-collapse: separate; border-spacing: 0; width: 100%; } th, td { border-right: 1px solid #d3d7df; border-bottom: 1px solid #d3d7df; padding: 14px; min-width: 240px; max-width: 360px; white-space: pre-wrap; vertical-align: top; line-height: 1.6; }
th { background: #f3f4f8; } tbody th { position: sticky; left: 0; min-width: 150px; } thead th { position: sticky; top: 0; z-index: 2; } .changed { background: #fff5cc; } img { width: 100px; height: 90px; object-fit: cover; margin: 4px; }
</style>
