import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx-js-style'
import { combinePurchaseContracts, formatPurchaseContractFonts, formatPurchaseContractTotals } from './purchaseContractWorkbook'

it('公司抬头 22 号、购销合同 18 号，其余 12 号加粗，合并后保持相同格式', () => {
  const ws = XLSX.utils.aoa_to_sheet([['标题', '明细', '合同条款', '英文名称', '物料编码'], [153], [], ['购销合同']])
  ws.A1.s = { font: { name: '宋体', sz: 22 }, alignment: { horizontal: 'center' } }
  ws.A2.s = { font: { sz: 11, bold: false }, border: { bottom: { style: 'thin' } } }
  ws.A2.f = 'SUM(B2:C2)'
  ws.A2.z = '0.00'
  formatPurchaseContractFonts(ws)
  const combined = combinePurchaseContracts([{ entity: 'HSY', ws }, { entity: 'HSY', ws }]).Sheets['华胜益']
  for (const sheet of [ws, combined]) {
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue
      const isCompanyTitle = address === 'A1' || (sheet === combined && address === 'A7')
      const isContractTitle = address === 'A4' || (sheet === combined && address === 'A10')
      expect(cell.s.font.sz).toBe(isCompanyTitle ? 22 : isContractTitle ? 18 : 12)
      expect(cell.s.font.bold).toBe(true)
    }
  }
  expect(combined.A7.v).toBe('标题')
  expect(combined.A7.s.font.sz).toBe(22)
  expect(combined.A10.v).toBe('购销合同')
  expect(combined.A10.s.font.sz).toBe(18)
  expect(ws.A1.s.font.name).toBe('宋体')
  expect(ws.A1.s.alignment.horizontal).toBe('center')
  expect(ws.A2.s.border.bottom.style).toBe('thin')
  expect(ws.A2.v).toBe(153)
  expect(ws.A2.f).toBe('SUM(B2:C2)')
  expect(ws.A2.z).toBe('0.00')
})

describe('采购合同合计与大写布局', () => {
  it.each(['人民币', '美金'])('按样表对齐%s金额且保留计算公式', currency => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['', '', '', 1636.2, '', 3.04938272, 4989.4],
      ['', '', '', '', '合计', '', 4989.4, ''],
      ['', '', '', '', '大写', currency, '肆仟玖佰捌拾玖元肆角', ''],
    ])
    ws.G2.f = 'ROUND(SUM(G1:G1),2)'
    ws.G2.z = currency === '人民币' ? '"¥"#,##0.00' : '"US$"#,##0.00'
    ws['!cols'] = Array.from({ length: 8 }, (_, index) => ({ wch: index === 7 ? 18 : 13 }))
    ws.G3.s = { font: { sz: 11 }, border: { bottom: { style: 'thin' } } }
    formatPurchaseContractTotals(ws, 1)
    expect(ws['!merges']).toEqual([
      { s: { r: 1, c: 4 }, e: { r: 1, c: 5 } },
      { s: { r: 1, c: 6 }, e: { r: 1, c: 7 } },
      { s: { r: 2, c: 6 }, e: { r: 2, c: 7 } },
    ])
    expect(ws.E3.v).toBe('大写')
    expect(ws.F3.v).toBe(currency)
    expect(ws.G3.s.alignment).toEqual({ horizontal: 'left', vertical: 'center', wrapText: true })
    expect(ws.G3.s.font.sz).toBe(11)
    expect(ws.G3.s.border.bottom.style).toBe('thin')
    expect(ws['!rows']?.[2]?.hpt).toBeGreaterThanOrEqual(24)
    const wb = combinePurchaseContracts([{ entity: 'HD_GLOBAL', ws }, { entity: 'HD_GLOBAL', ws }])
    const restored = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellStyles: true })
    const combined = restored.Sheets['华登全球']
    expect(combined.E8.v).toBe('大写')
    expect(combined.F8.v).toBe(currency)
    expect(combined.G8.v).toBe('肆仟玖佰捌拾玖元肆角')
    expect(combined.G7.f).toBe('ROUND(SUM(G6:G6),2)')
    expect(combined.G7.v).toBe(4989.4)
    expect(combined['!merges']).toContainEqual({ s: { r: 7, c: 6 }, e: { r: 7, c: 7 } })
  })

  it('长大写金额增加行高，不挤进备注的单个窄格', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['', '', '', '', '合计', '', 123456789.99, ''],
      ['', '', '', '', '大写', '人民币', '壹亿贰仟叁佰肆拾伍万陆仟柒佰捌拾玖元玖角玖分', ''],
    ])
    formatPurchaseContractTotals(ws, 0)
    expect(ws['!rows']?.[1]?.hpt).toBeGreaterThan(24)
    expect(ws.G2.v).toBe('壹亿贰仟叁佰肆拾伍万陆仟柒佰捌拾玖元玖角玖分')
  })
})

function contract(no: string) {
  const ws = XLSX.utils.aoa_to_sheet([[no], ['', '', '', 2, '', 3, 6], ['', '', '', '', '', '', 6]])
  ws.G2.f = 'ROUND(D2*F2,2)'
  ws.G3.f = 'ROUND(SUM(G2:G2),2)'
  ws.A1.s = { font: { bold: true, sz: 22 } }
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }]
  ws['!cols'] = [{ wch: 12 }]
  ws['!rows'] = [{ hpt: 30 }]
  return ws
}

describe('按采购主体合并合同', () => {
  it('每个主体一张表，同主体多张合同保留编号、样式和独立公式', () => {
    const first = contract('IRRIHS0402')
    const second = contract('IRRIHS0403')
    const wb = combinePurchaseContracts([
      { entity: 'HSY', ws: contract('2026900171') },
      { entity: 'HD_INDUSTRY', ws: first },
      { entity: 'HD_GLOBAL', ws: contract('IRRMHS0060') },
      { entity: 'HD_INDUSTRY', ws: second },
    ])
    expect(wb.SheetNames).toEqual(['华登实业', '华登全球', '华胜益'])
    const ws = wb.Sheets['华登实业']
    expect(ws.A1.v).toBe('IRRIHS0402')
    expect(ws.A6.v).toBe('IRRIHS0403')
    expect(ws.G7.f).toBe('ROUND(D7*F7,2)')
    expect(ws.G8.f).toBe('ROUND(SUM(G7:G7),2)')
    expect(ws.G8.v).toBe(6)
    expect(ws.A6.s).toEqual(first.A1.s)
    expect(ws['!rows']?.[5]).toEqual({ hpt: 30 })
    expect(ws['!cols']).toEqual(first['!cols'])
    expect(ws['!merges']?.[1]).toEqual({ s: { r: 5, c: 0 }, e: { r: 5, c: 6 } })
    expect(second.G2.f).toBe('ROUND(D2*F2,2)')
    const restored = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
    expect(restored.Sheets['华登实业'].G8.f).toBe('ROUND(SUM(G7:G7),2)')
    expect(restored.Sheets['华胜益'].A1.v).toBe('2026900171')
  })

  it('没有订单的主体不产生空表', () => {
    const wb = combinePurchaseContracts([{ entity: 'HD_GLOBAL', ws: contract('IRRMHS0060') }])
    expect(wb.SheetNames).toEqual(['华登全球'])
  })
})
