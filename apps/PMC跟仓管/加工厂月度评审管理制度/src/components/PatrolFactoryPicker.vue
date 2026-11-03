<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { normalizeFactoryName } from '../utils/factoryName'
const props = defineProps<{ modelValue: string; factories: { id: string; name: string }[]; disabled?: boolean; rowNo: number }>()
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const query = ref('')
const matches = computed(() => {
  const q = normalizeFactoryName(query.value)
  return props.factories.filter(f => !q || normalizeFactoryName(f.name).includes(q))
})
watch(() => props.factories, () => { query.value = '' })
function search(event: Event) {
  query.value = (event.target as HTMLInputElement).value
  emit('update:modelValue', '')
}
</script>
<template>
  <div class="factory-picker">
    <input :value="query" :disabled="disabled" :aria-label="`第${rowNo}行搜索工厂`" placeholder="输入工厂名称或关键词搜索" @input="search" />
    <select :value="modelValue" :disabled="disabled" :aria-label="`第${rowNo}行选择匹配工厂`" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option value="">请选择匹配工厂</option><option v-for="f in matches" :key="f.id" :value="f.id">{{ f.name }}</option>
    </select>
    <small v-if="!matches.length">未找到工厂，请换关键词；未登记的工厂需先在工厂信息管理中新增。</small>
    <small v-else-if="query && !modelValue">找到 {{ matches.length }} 家，请在下方选项中选择。</small>
  </div>
</template>
<style scoped>
.factory-picker { display: grid; gap: 8px; min-width: 260px; }
input, select { width: 100%; min-width: 0; font: inherit; color: #202635; background: #fff; padding: 8px; border: 1px solid #cbd0dc; border-radius: 6px; }
small { color: #596275; line-height: 1.5; }
</style>
