/** Preserve source delivery dates (including an intentionally empty date) across repeated merges. */
export function purchaseLineDeliveryDate(
  item: { source_po_no?: string | null; source_delivery_date?: string | null; has_delivery_date_override?: boolean; delivery_date_override?: string | null }, headerDate?: string | null,
): string {
  return String(item.has_delivery_date_override ? item.delivery_date_override || ''
    : item.source_po_no != null ? item.source_delivery_date || '' : headerDate || '').slice(0, 10)
}

export function purchaseOrderNumbers(orders: { po_no?: string; merged_po_numbers?: string[] }[]): string[] {
  return orders.flatMap(po => [po.po_no || '', ...(po.merged_po_numbers || [])]).filter(Boolean)
}

// Export and same-name line merging must not silently discard source/date information.
export function purchaseLineSourceKey(item: { source_po_no?: string | null; source_delivery_date?: string | null; has_delivery_date_override?: boolean; delivery_date_override?: string | null }): string {
  return JSON.stringify([item.source_po_no || '', item.source_delivery_date || '', item.has_delivery_date_override || false, item.delivery_date_override || ''])
}
