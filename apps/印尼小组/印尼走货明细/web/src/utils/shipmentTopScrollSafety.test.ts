import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { parseSheetClipboard, sheetPasteSelectionEdits } from './shipmentSheet'

const path = new URL('../components/ShipmentSheetTable.tsx', import.meta.url)
const source = readFileSync(path, 'utf8')
const tree = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function handler(name: string) {
  let code = ''
  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === name)
      code = ((node.initializer as ts.JsxExpression).expression!).getText(tree)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  expect(code).not.toBe('')
  return ts.transpileModule(`(${code})(event)`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
}
const keydown = handler('onKeyDownCapture')
const paste = handler('onPasteCapture')
const copy = handler('onCopyCapture')

function focusedRail(nested: boolean) {
  const records: Array<Record<string, string>> = [{ qty: '12', note: 'first' }, { qty: '34', note: 'second' }]
  const original = JSON.stringify(records)
  const rail = { className: 'shipment-sheet-top-scroll' }
  const target = { closest: (selector: string) => selector === '.shipment-sheet-top-scroll' ? rail : null,
    getAttribute: () => null, ...(nested ? {} : rail) }
  const preventDefault = vi.fn(), stopPropagation = vi.fn(), setData = vi.fn()
  const getData = vi.fn(() => '999\tchanged')
  const focus = vi.fn(), setEditingCell = vi.fn()
  const clearSelection = vi.fn(() => { records[0].qty = '' })
  const fillDown = vi.fn(() => { records[1].qty = records[0].qty })
  const onUndo = vi.fn(() => { records[0].qty = 'old' })
  const runBatch = vi.fn((make: () => Array<{ row: number; field: string; value: string }>) => {
    for (const edit of make()) records[edit.row][edit.field] = edit.value
    return Promise.resolve(true)
  })
  const context = createContext({
    event: { target, key: '', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault, stopPropagation,
      clipboardData: { getData, setData } },
    batchPending: { current: false }, anchor: { row: 0, col: 0 }, end: { row: 0, col: 1 },
    point: () => null, editingCell: null, count: records.length, fields: ['qty', 'note'],
    canEdit: () => true, hasCell: () => true, cellAt: () => null,
    sheetArrowKeys: new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']),
    sheetArrowPoint: () => ({ row: 0, col: 1 }), sheetArrowUsesEditor: () => false,
    focus, setEditingCell, clearSelection, fillDown, onUndo, undoDisabled: false,
    runBatch, parseSheetClipboard, sheetPasteSelectionEdits,
    valueAt: (row: number, field: string) => records[row][field], displayAt: () => '',
    cellText: () => '', quote: (value: string) => value, message: { error: vi.fn() },
  })
  return { context, records, original, preventDefault, stopPropagation, setData, getData,
    focus, setEditingCell, clearSelection, fillDown, onUndo, runBatch }
}

for (const nested of [false, true]) {
  it.each([
    { key: 'ArrowRight' }, { key: 'ArrowLeft' }, { key: 'Delete' }, { key: 'Backspace' },
    { key: 'd', ctrlKey: true }, { key: 'd', metaKey: true }, { key: 'z', ctrlKey: true },
    { key: 'Tab' }, { key: 'Enter' }, { key: '7' },
  ])(`focused top scrollbar preserves native keys and the old grid selection (nested=${nested}): %j`, key => {
    const test = focusedRail(nested)
    Object.assign(test.context.event, key)
    runInContext(keydown, test.context)
    for (const action of [test.preventDefault, test.stopPropagation, test.focus, test.setEditingCell,
      test.clearSelection, test.fillDown, test.onUndo, test.runBatch]) expect(action).not.toHaveBeenCalled()
    expect(JSON.stringify(test.records)).toBe(test.original)
  })
  it(`focused top scrollbar does not paste over the old grid selection (nested=${nested})`, () => {
    const test = focusedRail(nested)
    runInContext(paste, test.context)
    expect(test.getData).not.toHaveBeenCalled()
    expect(test.runBatch).not.toHaveBeenCalled()
    expect(test.preventDefault).not.toHaveBeenCalled()
    expect(JSON.stringify(test.records)).toBe(test.original)
  })
  it(`focused top scrollbar does not replace the clipboard with an old selection (nested=${nested})`, () => {
    const test = focusedRail(nested)
    runInContext(copy, test.context)
    expect(test.setData).not.toHaveBeenCalled()
    expect(test.preventDefault).not.toHaveBeenCalled()
    expect(JSON.stringify(test.records)).toBe(test.original)
  })
}
