import { describe, expect, it } from 'vitest'
import { bindInvoiceLookupSerial, documentRow, rebindDocumentFormula } from './documentTemplateFormula'

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

describe('invoice lookup serial binding', () => {
  const vector = "0/(('MAIN'!D:D=B32)*('MAIN'!G:G&'MAIN'!F:F=C32))"
  const lookup = `LOOKUP(1,${vector},'MAIN'!Z:Z)`
  const bound = `LOOKUP(1,(${vector})/('MAIN'!A:A=A32),'MAIN'!Z:Z)`

  it('retains all material conditions and the result expression inside outer rounding', () => {
    expect(bindInvoiceLookupSerial(`ROUND(${lookup}*G32, 2)`, 'MAIN', 32)).toBe(`ROUND(${bound}*G32, 2)`)
    expect(bindInvoiceLookupSerial(bound, 'MAIN', 32)).toBe(bound)
  })

  it('reads final row anchors after the document formula has been rebound', () => {
    const rebound = rebindDocumentFormula(lookup, {
      sheet: '发票', main: 'MAIN', layouts,
      detail: { sourceRow: 32, targetRow: 48, mainRow: 15 },
    })
    expect(bindInvoiceLookupSerial(rebound, 'MAIN', 48)).toBe(
      "LOOKUP(1,(0/(('MAIN'!D:D=B48)*('MAIN'!G:G&'MAIN'!F:F=C48)))/('MAIN'!A:A=A48),'MAIN'!Z:Z)",
    )
  })

  it('skips literal LOOKUP text and doubled double quotes while binding a real call', () => {
    const literal = `"LOOKUP(1,${vector},'MAIN'!Z:Z), say ""LOOKUP"""`
    expect(bindInvoiceLookupSerial(`IF(A32=${literal}, ${lookup}, ${literal})`, 'MAIN', 32))
      .toBe(`IF(A32=${literal}, ${bound}, ${literal})`)
  })

  it('handles escaped apostrophes, commas and LOOKUP text in quoted sheet names', () => {
    const name = "柜'号,LOOKUP(1)"
    const prefix = "'柜''号,LOOKUP(1)'!"
    const formula = `LOOKUP(1,0/(${prefix}D:D=B48),${prefix}G:G&${prefix}F:F)`
    expect(bindInvoiceLookupSerial(formula, name, 48)).toBe(
      `LOOKUP(1,(0/(${prefix}D:D=B48))/(${prefix}A:A=A48),${prefix}G:G&${prefix}F:F)`,
    )
  })

  it('accepts unquoted sheet names case insensitively and preserves whitespace', () => {
    expect(bindInvoiceLookupSerial('lookup ( 1 , 0 / (Main!D:D=B7) , Main!Z:Z )', 'MAIN', 7))
      .toBe("lookup ( 1 ,( 0 / (Main!D:D=B7) )/('MAIN'!A:A=A7), Main!Z:Z )")
  })

  it('does not mistake nested function or array commas for LOOKUP arguments', () => {
    const vector = `0/(('MAIN'!D:D=B32)*ISNUMBER(MATCH('MAIN'!F:F,{"A","B"},0)))`
    const result = `IF(B32="A,B",'MAIN'!Z:Z,ROUND('MAIN'!Z:Z,2))`
    expect(bindInvoiceLookupSerial(`LOOKUP(1,${vector},${result})`, 'MAIN', 32))
      .toBe(`LOOKUP(1,(${vector})/('MAIN'!A:A=A32),${result})`)
  })

  it('binds multiple and nested real calls without corrupting their offsets', () => {
    const other = "LOOKUP(1,0/('OTHER'!D:D=B32),'OTHER'!Z:Z)"
    const nested = `LOOKUP(1,${vector},IF(A32,${lookup},${other}))`
    expect(bindInvoiceLookupSerial(`${lookup}+${other}+${nested}`, 'MAIN', 32))
      .toBe(`${bound}+${other}+${nested.replace(lookup, bound)}`)
    const nestedCurrent = `LOOKUP(1,${vector},IF(A32,${lookup},'MAIN'!Z:Z))`
    expect(bindInvoiceLookupSerial(nestedCurrent, 'MAIN', 32))
      .toBe(`LOOKUP(1,(${vector})/('MAIN'!A:A=A32),IF(A32,${bound},'MAIN'!Z:Z))`)
  })

  it.each([
    "LOOKUP(1,0/('OTHER'!D:D=B32),'OTHER'!Z:Z)",
    "LOOKUP(1,0/('MAIN-OTHER'!D:D=B32),'MAIN-OTHER'!Z:Z)",
    'LOOKUP(1,0/(D:D="MAIN!A:A"),Z:Z)',
    "LOOKUP(1,'MAIN'!D:D,'MAIN'!Z:Z)",
    "LOOKUP(2,0/('MAIN'!D:D=B32),'MAIN'!Z:Z)",
    "LOOKUP(1,0/('MAIN'!D:D=B32))",
    "LOOKUP(1,0/('MAIN'!D:D=B32),'MAIN'!Z:Z,2)",
    "LOOKUP(1,0/(('MAIN'!D:D=B32)*('OTHER'!A:A=A32)),'MAIN'!Z:Z)",
    "LOOKUP(1,0/('MAIN'!D:D=B32),'OTHER'!Z:Z)",
    'LOOKUP(1,0/([Book.xlsx]MAIN!D:D=B32),[Book.xlsx]MAIN!Z:Z)',
    "NOTLOOKUP(1,0/('MAIN'!D:D=B32),'MAIN'!Z:Z)",
    "_xlfn.LOOKUP(1,0/('MAIN'!D:D=B32),'MAIN'!Z:Z)",
    "LOOKUP(1,0/('MAIN'!D:D=B32),'MAIN'!Z:Z",
    "LOOKUP(1,0/('MAIN'!D:D=B32),'MAIN!Z:Z)",
    "ROUND(LOOKUP(1,0/('MAIN'!D:D=B32),'MAIN'!Z:Z)",
    'LOOKUP(1,0/(\'MAIN\'!D:D=B32),\'MAIN\'!Z:Z)+"unfinished',
  ])('leaves unsupported or non-current-table expressions intact: %s', formula => {
    expect(bindInvoiceLookupSerial(formula, 'MAIN', 32)).toBe(formula)
  })

  it.each([0, -1, 1.5, NaN, 1_048_577])('does not write an invalid target row %s', row => {
    expect(bindInvoiceLookupSerial(lookup, 'MAIN', row)).toBe(lookup)
  })
})
