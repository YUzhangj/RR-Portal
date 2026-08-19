import { computed, ref, watch } from 'vue'

export interface TableColumnOption {
  key: string
  label: string
  width: number
  hideable?: boolean
}

export function useTableColumnPreferences(storageKey: string, columns: TableColumnOption[]) {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}') as { hidden?: string[], frozenThrough?: string } }
    catch { return {} }
  })()
  const validKeys = new Set(columns.map((column) => column.key))
  const hidden = ref<string[]>((saved.hidden ?? []).filter((key) => validKeys.has(key)))
  const frozenThrough = ref(validKeys.has(saved.frozenThrough ?? '') ? saved.frozenThrough! : '')
  const columnPanelOpen = ref(false)

  const visibleColumns = computed(() => columns.filter((column) => !hidden.value.includes(column.key)))
  const frozenKeys = computed(() => {
    if (!frozenThrough.value) return []
    const index = visibleColumns.value.findIndex((column) => column.key === frozenThrough.value)
    return index < 0 ? [] : visibleColumns.value.slice(0, index + 1).map((column) => column.key)
  })

  function isVisible(key: string) { return !hidden.value.includes(key) }
  function isFrozen(key: string) { return frozenKeys.value.includes(key) }
  function columnStyle(key: string) {
    const target = columns.find((column) => column.key === key)
    if (!target) return undefined
    const style: Record<string, string> = {
      width: `${target.width}px`,
      minWidth: `${target.width}px`,
      maxWidth: `${target.width}px`,
    }
    if (!isFrozen(key)) return style
    let left = 0
    for (const column of visibleColumns.value) {
      if (column.key === key) break
      if (frozenKeys.value.includes(column.key)) left += column.width
    }
    style.left = `${left}px`
    return style
  }
  function toggleColumn(key: string) {
    const column = columns.find((item) => item.key === key)
    if (!column || column.hideable === false) return
    hidden.value = hidden.value.includes(key)
      ? hidden.value.filter((item) => item !== key)
      : [...hidden.value, key]
    if (!isVisible(frozenThrough.value)) frozenThrough.value = ''
  }
  function showAllColumns() { hidden.value = [] }

  watch([hidden, frozenThrough], () => {
    localStorage.setItem(storageKey, JSON.stringify({ hidden: hidden.value, frozenThrough: frozenThrough.value }))
  }, { deep: true })

  return {
    hidden, frozenThrough, columnPanelOpen, visibleColumns,
    isVisible, isFrozen, columnStyle, toggleColumn, showAllColumns,
  }
}
