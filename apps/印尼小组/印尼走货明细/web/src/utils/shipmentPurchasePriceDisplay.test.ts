import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { shipmentDeclarationPrice, shipmentPurchaseAmount } from './shipmentPurchase'
import { withShipmentInvoicePrices } from './shipmentInvoice'
import { mergedFieldEditable } from './shipmentMergedEditor'

const page = ts.createSourceFile('page.tsx', readFileSync(new URL('../pages/ShipmentsPage.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let render = '', clipboard = '', editable = ''
function walk(node: ts.Node) {
  if (ts.isObjectLiteralExpression(node)) {
    const title = node.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(page) === 'title')
    if (title && ts.isPropertyAssignment(title) && title.initializer.getText(page) === "'采购单价'") {
      const property = node.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(page) === 'render')
      if (property && ts.isPropertyAssignment(property)) render = property.initializer.getText(page)
    }
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'mergedCellValue') clipboard = node.getText(page)
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(page).startsWith('ShipmentSheetTable')) {
    const property = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(page) === 'editableAt')
    if (property && ts.isJsxAttribute(property) && property.initializer && ts.isJsxExpression(property.initializer)) editable = property.initializer.expression!.getText(page)
  }
  ts.forEachChild(node, walk)
}
walk(page)
const js = (source: string) => ts.transpile(source, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })

it.each([
  { outbound_id: 1, price: .0817, qty: 10100, kg: 326.53 },
  { outbound_id: 2, price: .0817, qty: 10200, kg: 326.53, purchase_charge_ratio: 10100 / 10200 },
  { price: 2.5271, qty: 10100, kg: 326.53, material_snapshot: { unit_kg: 'KGM' } },
])('页面及复制均显示采购金额÷申报数量，原来源单价保留：%j', source => {
  const before = structuredClone(source)
  const [row] = withShipmentInvoicePrices([source], new Map())
  const context = createContext({ shipmentDeclarationPrice, consolidatedItems: [row], matMap: new Map(),
    React: { createElement: (_tag: string, _props: unknown, value: string) => value } })
  expect(render).toBeTruthy()
  expect(clipboard).toBeTruthy()
  const displayed = runInContext(js(`const render = ${render}; render(undefined, consolidatedItems[0]);`), context)
  const copied = runInContext(js(`${clipboard}; mergedCellValue(0, 'price');`), context)
  const expected = (shipmentPurchaseAmount(row) / row.kg!).toFixed(4)
  expect(displayed).toBe(expected)
  expect(copied).toBe(expected)
  expect(row.invoice_price!.toFixed(4)).toBe(expected)
  expect(source).toEqual(before)
})

it('自动计算的采购单价不接受快捷键覆盖，其他可编辑资料仍可编辑', () => {
  const row = { price: .0817, qty: 10100, kg: 326.53, sources: [{ _rowKey: 1 }], outbound_ids: [1] }
  const context = createContext({ consolidatedItems: [row], matMap: new Map(), mergedFieldEditable })
  expect(editable).toBeTruthy()
  runInContext(js(`const editable = ${editable}`), context)
  expect(runInContext("editable(0, 'price')", context)).toBe(false)
  expect(runInContext("editable(0, 'supplier')", context)).toBe(true)
})
