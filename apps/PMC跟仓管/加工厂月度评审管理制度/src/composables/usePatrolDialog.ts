import { nextTick, onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from 'vue'
/** Trap keyboard focus in the active dialog and return it to its opener. */
export function usePatrolDialog(close: () => void, blocked = () => false) {
  const dialog = ref<HTMLElement | null>(null)
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  onMounted(() => { void nextTick(() => dialog.value?.querySelector<HTMLElement>('button, select, input')?.focus()) })
  onBeforeUnmount(() => { if (opener?.isConnected) opener.focus() })
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); if (!blocked()) close(); return }
    if (event.key !== 'Tab' || !dialog.value) return
    const controls = [...dialog.value.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href]')]
    const first = controls[0], last = controls.at(-1)
    if (!first || !last) { event.preventDefault(); dialog.value.focus(); return }
    if (!dialog.value.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus()
    }
  }
  function setDialog(value: Element | ComponentPublicInstance | null) { dialog.value = value instanceof HTMLElement ? value : null }
  return { setDialog, keydown }
}
