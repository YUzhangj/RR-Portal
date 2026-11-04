// Stable renderer/session refs for tests executing the actual save handler in VM.
// The race tests publish real changed refs separately; payload tests keep one scope.
export function shipmentSaveTestRefs(items: unknown[], materials: unknown) {
  return {
    savePending: { current: null as number | null },
    unacknowledgedSave: { current: false },
    writtenMaterials: { current: new Map() },
    editorSession: { current: 1 },
    formRevision: { current: 0 },
    sheetRevision: { current: { rawItems: items, matMap: materials, session: 1 } },
    sheetWritePending: { current: false },
  }
}
