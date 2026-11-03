import { expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { readBoundedShipmentXml } from './shipmentImport'

it('inflated XML is bounded incrementally and does not use whole-part async allocation', async () => {
  const zip = new JSZip()
  zip.file('xl/worksheets/large.xml', 'x'.repeat(1024 * 1024))
  const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }))
  const entry = loaded.file('xl/worksheets/large.xml')!
  const wholeAllocation = vi.spyOn(entry, 'async')
  await expect(readBoundedShipmentXml(entry, 64 * 1024)).rejects.toThrow('工作表数据过大')
  expect(wholeAllocation).not.toHaveBeenCalled()
})

it('the remaining workbook budget is shared across entries and exact limits retain every byte', async () => {
  const zip = new JSZip()
  zip.file('one.xml', new Uint8Array([1, 2, 3, 4]))
  zip.file('two.xml', new Uint8Array([5, 6, 7, 8]))
  const first = await readBoundedShipmentXml(zip.file('one.xml')!, 7)
  expect([...first]).toEqual([1, 2, 3, 4])
  await expect(readBoundedShipmentXml(zip.file('two.xml')!, 7 - first.byteLength)).rejects.toThrow('工作表数据过大')
  expect([...await readBoundedShipmentXml(zip.file('two.xml')!, 4)]).toEqual([5, 6, 7, 8])
  await expect(readBoundedShipmentXml(zip.file('one.xml')!, Infinity)).rejects.toThrow('大小限制无效')
})
