<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RecordModel } from 'pocketbase'
import type { Factory } from '../types/factory'
import { usePatrolDialog } from '../composables/usePatrolDialog'
import { PATROL_FIELDS } from '../utils/qualityPatrol'
const props = defineProps<{ records: RecordModel[]; factories: Factory[]; photoUrl: (r: RecordModel, name: string) => string; photoReady: boolean; photoError: string }>()
const emit = defineEmits<{ close: []; photoFailed: []; refreshPhotos: [] }>()
const { setDialog, keydown } = usePatrolDialog(() => emit('close'))
const factory = ref(props.factories.find(f => props.records.filter(r => r.factory === f.id).length >= 2)?.id || props.factories[0]?.id || '')
const selected = ref<string[]>([])
const history = computed(() => props.records.filter(r => r.factory === factory.value).slice().sort((a, b) => a.check_date.localeCompare(b.check_date)))
watch(history, rows => { selected.value = rows.slice(-3).map(r => r.id) }, { immediate: true })
const compared = computed(() => history.value.filter(r => selected.value.includes(r.id)))
const value = (r: RecordModel, key: string) => key.endsWith('_date') ? r[key]?.slice(0, 10) || '—' : r[key] === '' || r[key] == null ? '—' : r[key]
const changed = (index: number, key: string) => index > 0 && value(compared.value[index]!, key) !== value(compared.value[index - 1]!, key)
</script>
<template>
  <div class="overlay"><section :ref="setDialog" class="dialog" tabindex="-1" @keydown="keydown" role="dialog" aria-modal="true" aria-labelledby="compare-title">
    <header><h3 id="compare-title">同一工厂多次巡查对比</h3><button @click="emit('close')">关闭</button></header>
    <label>加工厂<select v-model="factory"><option v-for="f in factories" :key="f.id" :value="f.id">{{ f.name }}</option></select></label>
    <p>选择两次或更多巡查，按日期先后并排对比。黄色单元格表示相较左侧所选巡查发生变化。</p>
    <p v-if="photoError" role="alert">{{ photoError }} <button @click="emit('refreshPhotos')">刷新照片</button></p>
    <div class="dates"><label v-for="r in history" :key="r.id"><input v-model="selected" type="checkbox" :value="r.id" />{{ r.check_date.slice(0, 10) }}</label><button v-if="history.length" @click="selected = history.map(r => r.id)">选择全部日期</button></div>
    <p v-if="history.length < 2">该工厂目前不足两次巡查记录，请先登记或导入其他日期的巡查。</p><p v-else-if="compared.length < 2">请至少选择两个日期。</p>
    <div v-if="compared.length >= 2" class="scroll"><table><thead><tr><th>巡查项目</th><th v-for="r in compared" :key="r.id">{{ r.check_date.slice(0, 10) }}</th></tr></thead><tbody>
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
.scroll { overflow: auto; max-height: 60vh; margin-top: 18px; } table { border-collapse: separate; border-spacing: 0; width: 100%; } th, td { border-right: 1px solid #d3d7df; border-bottom: 1px solid #d3d7df; padding: 14px; min-width: 240px; max-width: 360px; white-space: pre-wrap; vertical-align: top; line-height: 1.6; }
th { background: #f3f4f8; } tbody th { position: sticky; left: 0; min-width: 150px; } thead th { position: sticky; top: 0; z-index: 2; } .changed { background: #fff5cc; } img { width: 100px; height: 90px; object-fit: cover; margin: 4px; }
</style>
