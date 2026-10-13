import { describe, expect, it } from 'vitest'
import { documentRow, rebindDocumentFormula } from './documentTemplateFormula'

const layouts = new Map([
  ['合同', [
    { start: 24, end: 30, finalStart: 24, finalTotal: 36 },
    { start: 68, end: 71, finalStart: 73, finalTotal: 83 },
  ]],
  ['发票', [{ start: 28, end: 34, finalStart: 28, finalTotal: 40 }]],
])
const context = { sheet: '合同', main: "柜'号", layouts }

describe('template formula reference binding', () => {
  it('preserves expressions and absolute anchors when copying detail rows', () => {
    expect(rebindDocumentFormula('ROUND(F24*D24,2)+$H$5+$F24+F$2+IF(A24="A24",1,0)', {
      ...context, detail: { sourceRow: 24, targetRow: 35, mainRow: 15 },
    })).toBe('ROUND(F35*D35,2)+$H$5+$F35+F$2+IF(A35="A24",1,0)')
  })

  it('preserves template lookup ranges and only moves the destination criteria', () => {
    expect(rebindDocumentFormula("LOOKUP(1,0/(('柜''号'!D:D=B24)*('柜''号'!G:G&'柜''号'!F:F=C24)),'柜''号'!K:K)", {
      ...context, detail: { sourceRow: 24, targetRow: 35, mainRow: 15 },
    })).toBe("LOOKUP(1,0/(('柜''号'!D:D=B35)*('柜''号'!G:G&'柜''号'!F:F=C35)),'柜''号'!K:K)")
    expect(rebindDocumentFormula("SUMIFS('柜''号'!$K$4:$K$50,'柜''号'!$V$4:$V$50,$H$5)", {
      ...context, detail: { sourceRow: 24, targetRow: 35, mainRow: 15 },
    })).toBe("SUMIFS('柜''号'!$K$4:$K$50,'柜''号'!$V$4:$V$50,$H$5)")
  })

  it('expands totals, including templates with a missing last detail row', () => {
    expect(rebindDocumentFormula('ROUND(SUM(G24:G29),2)', context)).toBe('ROUND(SUM(G24:G35),2)')
    expect(rebindDocumentFormula('SUM($G$68:$G$71)', context)).toBe('SUM($G$73:$G$82)')
    expect(rebindDocumentFormula('G31+G72', context)).toBe('G36+G83')
  })

  it('moves anchors with their own sheet, not the current sheet', () => {
    expect(rebindDocumentFormula("'发票'!$I$35+'其他'!A100+$H$49+LOG10(100)", context))
      .toBe("'发票'!$I$40+'其他'!A100+$H$54+LOG10(100)")
    expect(rebindDocumentFormula('F68*D68+$H$49', {
      ...context, detail: { sourceRow: 68, targetRow: 82, mainRow: 17 },
    })).toBe('F82*D82+$H$54')
    expect(rebindDocumentFormula('G23+F24*D24', {
      ...context, detail: { sourceRow: 24, targetRow: 35, mainRow: 15 },
    })).toBe('G34+F35*D35')
  })

  it('shrinks tables and shifts footers without touching string literals', () => {
    const tables = [{ start: 24, end: 37, finalStart: 24, finalTotal: 34 }]
    expect(documentRow(56, tables)).toBe(52)
    expect(rebindDocumentFormula('IF(A1="SUM(G24:G37)",SUM(G24:G37),"H56")', {
      ...context, layouts: new Map([['合同', tables]]),
    })).toBe('IF(A1="SUM(G24:G37)",SUM(G24:G33),"H56")')
  })
})
