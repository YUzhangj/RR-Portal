import { afterEach, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { extractSheetImages } from './engineeringImport'
import { loadShipmentImages, readBoundedShipmentImage, type ShipmentImportRow } from './shipmentImport'
import { applyShipmentImport } from './shipmentImportApply'

afterEach(() => vi.unstubAllGlobals())
const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
function workbook(wps: boolean, target: string, entry = 'xl/media/图片 1.png', external = false) {
  const zip = new JSZip()
  zip.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="合成明细" r:id="sheetRel"/></sheets></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="sheetRel" Target="worksheets/明 细.xml"/></Relationships>')
  const relationship = `<Relationship Id="imageRel" Target="${attr(target)}"${external ? ' TargetMode="External"' : ''}/>`
  if (wps) {
    zip.file('xl/worksheets/明 细.xml', '<worksheet><sheetData><row r="2"><c r="F2"><f>DISPIMG("IMAGE_TEST",1)</f></c></row></sheetData></worksheet>')
    zip.file('xl/cellimages.xml', '<root xmlns:ci="urn:wps" xmlns:d="urn:drawing" xmlns:a="urn:art" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><ci:cellImage><d:cNvPr name="IMAGE_TEST"/><a:blip r:embed="imageRel"/></ci:cellImage></root>')
    zip.file('xl/_rels/cellimages.xml.rels', `<Relationships>${relationship}</Relationships>`)
  } else {
    zip.file('xl/worksheets/明 细.xml', '<worksheet><sheetData><row r="2"/></sheetData></worksheet>')
    zip.file('xl/worksheets/_rels/明 细.xml.rels', '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/绘 图.xml"/></Relationships>')
    zip.file('xl/drawings/绘 图.xml', '<xdr:wsDr xmlns:xdr="urn:drawing" xmlns:a="urn:art" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:row>1</xdr:row><xdr:col>5</xdr:col></xdr:from><xdr:ext cy="1000"/><xdr:pic><a:blip r:embed="imageRel"/></xdr:pic></xdr:oneCellAnchor></xdr:wsDr>')
    zip.file('xl/drawings/_rels/绘 图.xml.rels', `<Relationships>${relationship}</Relationships>`)
  }
  zip.file(entry, new Uint8Array([137, 80, 78, 71]))
  return zip
}

it.each([false, true])('standard/WPS=%s retains decoded Chinese and space names through workbook and media relationships', async wps => {
  vi.stubGlobal('DOMParser', DOMParser)
  for (const target of [wps ? 'media/图片 1.png' : '../media/图片 1.png',
    wps ? 'media/%E5%9B%BE%E7%89%87%201.png' : '../media/%E5%9B%BE%E7%89%87%201.png',
    wps ? '../media/图片 1.png' : '../media/sub/../图片 1.png']) {
    const zip = await JSZip.loadAsync(await workbook(wps, target).generateAsync({ type: 'arraybuffer' }))
    expect(await extractSheetImages(zip, '合成明细', true)).toEqual([{ row: 1, col: 5, dataUrl: 'data:image/png;base64,iVBORw==' }])
  }
})

it.each([false, true])('standard/WPS=%s rejects external targets and escaping paths instead of binding another archive entry', async wps => {
  vi.stubGlobal('DOMParser', DOMParser)
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  for (const target of ['https://example.invalid/xl/media/图片%201.png', '//example.invalid/xl/media/图片%201.png',
    '../../../xl/media/图片 1.png', '%2e%2e/%2e%2e/%2e%2e/xl/media/图片 1.png', '..\\media\\图片 1.png',
    '../media/图片 1.png?x=1', '../media/图片 1.png#fragment']) {
    const zip = await JSZip.loadAsync(await workbook(wps, target).generateAsync({ type: 'arraybuffer' }))
    expect(await extractSheetImages(zip, '合成明细', true), target).toEqual([])
  }
  const external = workbook(wps, wps ? 'media/图片 1.png' : '../media/图片 1.png', undefined, true)
  expect(await extractSheetImages(external, '合成明细', true)).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
})

it('a sanitized unsafe original ZIP member is not accepted as a trusted media part', async () => {
  vi.stubGlobal('DOMParser', DOMParser)
  const zip = workbook(false, '../media/图片 1.png', 'xl/media/sub/../图片 1.png')
  const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer' }))
  expect(loaded.file('xl/media/图片 1.png')?.unsafeOriginalName).toBe('xl/media/sub/../图片 1.png')
  expect(await extractSheetImages(loaded, '合成明细', true)).toEqual([])
})

it('a bad relationship cannot erase another image and every selected row at a failed cell receives a warning', async () => {
  vi.stubGlobal('DOMParser', DOMParser)
  const zip = workbook(false, '../media/图片 1.png')
  const drawing = zip.file('xl/drawings/绘 图.xml')!
  const bad = '<xdr:oneCellAnchor><xdr:from><xdr:row>2</xdr:row><xdr:col>5</xdr:col></xdr:from><xdr:ext cy="1000"/><xdr:pic><a:blip r:embed="badRel"/></xdr:pic></xdr:oneCellAnchor>'
  zip.file(drawing.name, (await drawing.async('string')).replace('</xdr:wsDr>', bad + '</xdr:wsDr>'))
  const rels = zip.file('xl/drawings/_rels/绘 图.xml.rels')!
  zip.file(rels.name, (await rels.async('string')).replace('</Relationships>', '<Relationship Id="badRel" Target="https://example.invalid/image.png"/></Relationships>'))
  const rows: ShipmentImportRow[] = [2, 3, 3].map((row, index) => ({ key: String(index), sheet: '合成明细', row, imageCol: 5, selected: true, warnings: [], item: { material_snapshot: {} } }))
  const resize = vi.fn(async () => 'data:image/jpeg;base64,AA==')
  await loadShipmentImages(zip, rows, resize)
  expect(resize).toHaveBeenCalledOnce()
  expect(rows[0].item.material_snapshot.image).toBe('data:image/jpeg;base64,AA==')
  for (const row of rows.slice(1)) {
    expect(row.warnings).toEqual([expect.stringContaining('图片读取或压缩失败')])
    expect(row.item._fileMaterialFields || []).not.toContain('image')
  }
})

it('an unlinked existing shipment keeps its own image when a file image is missing or failed, rather than a catalog fallback', () => {
  const current = { product_code: 'SYN', name_zh: '合成物料', image: 'shipment-original' }
  const original = { material_id: -1, material_snapshot: current, qty: 7 }
  for (const fileImage of [false, true]) {
    const [next] = applyShipmentImport([original], new Map([[-1, current]]), [{
      material_snapshot: { ...current, image: fileImage ? 'real-file-image' : 'catalog-image' },
      _fileMaterialFields: fileImage ? ['image'] : ['product_code', 'name_zh'], qty: 11,
    }], [0])
    expect(next.material_snapshot?.image).toBe(fileImage ? 'real-file-image' : 'shipment-original')
    expect(next.qty).toBe(11)
    expect(original.material_snapshot.image).toBe('shipment-original')
  }
})

it('a selected image exceeding 32 MiB warns at its source row, retains an existing image and never gives a new row a failed picture', async () => {
  vi.stubGlobal('DOMParser', DOMParser)
  const zip = workbook(false, '../media/图片 1.png')
  zip.file('xl/media/图片 1.png', new Uint8Array(32 * 1024 * 1024 + 1))
  const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }))
  const entry = loaded.file('xl/media/图片 1.png')!
  const wholeAllocation = vi.spyOn(entry, 'async')
  const current = { product_code: 'SYN', name_zh: '合成物料', image: 'shipment-original' }
  const rows: ShipmentImportRow[] = [{ key: 'limit', sheet: '合成明细', row: 2, imageCol: 5, selected: true, warnings: [],
    item: { material_snapshot: { ...current, image: 'catalog-fallback' }, _fileMaterialFields: ['product_code', 'name_zh'] } }]
  await loadShipmentImages(loaded, rows, async file => { await readBoundedShipmentImage(file); return 'should-not-decode' })
  expect(wholeAllocation).not.toHaveBeenCalled()
  expect(rows[0].warnings).toEqual([expect.stringContaining('单张图片原始数据超过 32 MB')])
  expect(rows[0].item.material_snapshot.image).toBeUndefined()
  expect(rows[0].item._fileMaterialFields).not.toContain('image')
  const [updated] = applyShipmentImport([{ material_id: -1, material_snapshot: current }], new Map([[-1, current]]), [rows[0].item], [0])
  expect(updated.material_snapshot?.image).toBe('shipment-original')
  const [added] = applyShipmentImport([], new Map(), [rows[0].item], [-1])
  expect(added.material_snapshot?.image).toBeUndefined()
  expect(current.image).toBe('shipment-original')
})
