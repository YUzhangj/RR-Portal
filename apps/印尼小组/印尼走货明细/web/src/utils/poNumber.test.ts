import { afterEach, describe, expect, it, vi } from 'vitest'
import { poCorrectHsyNumber, poDetermineEntity, poLineCurrency, poGenContractNo, PO_ENTITY_META } from './poNumber'

describe('排期来源对应采购主体', () => {
  it('非华胜益报关的 RRM 排期使用全球采购单', () => {
    const entity = poDetermineEntity('东莞市台聚印刷有限公司', '', 'RRM')
    expect(entity).toBe('HD_GLOBAL')
    expect(poGenContractNo([], entity, 'HS')).toBe('IRRMHS0060')
  })

  it.each(['RRI', 'RRM', ' rrm ', '', undefined])('华胜益报关优先于排期来源 %s', source => {
    for (const customs of ['深圳市华胜益出口贸易有限公司', ' 华胜益 ']) {
      const entity = poDetermineEntity('东莞市星徽纸品有限公司', customs, source)
      expect(entity).toBe('HSY')
      expect(PO_ENTITY_META[entity]).toMatchObject({ name: '深圳市华胜益出口贸易有限公司', currency: 'RMB' })
    }
  })

  it('其他报关公司不改变 RRM 的全球采购主体', () => {
    expect(poDetermineEntity('供应商', '供应商', 'RRM')).toBe('HD_GLOBAL')
    expect(poDetermineEntity('供应商', '其他报关公司', 'RRM')).toBe('HD_GLOBAL')
    expect(poDetermineEntity('华胜益', '其他报关公司', 'RRI')).toBe('HD_INDUSTRY')
  })

  it('非 RRM 排期沿用原有主体判断', () => {
    expect(poDetermineEntity('供应商', '', 'RRI')).toBe('HD_INDUSTRY')
    expect(poDetermineEntity('供应商', '深圳市华胜益出口贸易有限公司', 'RRI')).toBe('HSY')
  })
})

describe('采购订单衔接线下编号', () => {
  afterEach(() => vi.useRealTimers())

  it.each(['IRRMHS0061', 'IRRIHS0411'])('明确修正旧单 %s 时接续华胜益号码，不修改其他编号', oldNo => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 12))
    const existing = [oldNo, '2026900172', 'IRRMHS0062']
    const snapshot = [...existing]
    expect(poCorrectHsyNumber(oldNo, ['深圳市华胜益出口贸易有限公司', '华胜益'], existing)).toBe('2026900173')
    expect(existing).toEqual(snapshot)
  })

  it('已使用华胜益编号的旧单保持原号，包括往年编号', () => {
    expect(poCorrectHsyNumber('2026900171', ['华胜益'], ['2026900172'])).toBe('2026900171')
    expect(poCorrectHsyNumber('2025000001', ['华胜益'], ['2026900172'])).toBe('2025000001')
  })

  it.each([[], [undefined], [''], ['华胜益', undefined], ['华胜益', '供应商自报关'], ['其他公司']].map(customs => ({ customs })))('缺失或混合报关资料不能重编 $customs', ({ customs }) => {
    expect(() => poCorrectHsyNumber('IRRMHS0061', customs, [])).toThrow(/报关/)
  })

  it('不自动改写自定义采购编号', () => {
    expect(() => poCorrectHsyNumber('CUSTOM-001', ['华胜益'], [])).toThrow('当前不是可识别')
  })

  it('RRM 的华胜益报关物料使用华胜益编号且不重编旧订单', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 12))
    const existing = ['IRRMHS0061', '2026900172']
    const entity = poDetermineEntity('东莞市星徽纸品有限公司', '深圳市华胜益出口贸易有限公司', 'RRM')
    expect(poGenContractNo(existing, entity, 'HS')).toBe('2026900173')
    expect(existing).toEqual(['IRRMHS0061', '2026900172'])
  })

  it('RRI 和 RRM 从指定编号之后起排，已有更大编号时继续递增', () => {
    expect(poGenContractNo([], 'HD_INDUSTRY', 'HS')).toBe('IRRIHS0405')
    expect(poGenContractNo(['IRRIHS0401'], 'HD_INDUSTRY', 'HS')).toBe('IRRIHS0405')
    expect(poGenContractNo(['IRRIHS0404'], 'HD_INDUSTRY', 'HS')).toBe('IRRIHS0405')
    expect(poGenContractNo(['IRRIHS0405'], 'HD_INDUSTRY', 'HS')).toBe('IRRIHS0406')
    expect(poGenContractNo(['IRRIHS0450'], 'HD_INDUSTRY', 'HS')).toBe('IRRIHS0451')
    expect(poGenContractNo(['IRRMHS0059'], 'HD_GLOBAL', 'HS')).toBe('IRRMHS0060')
    expect(poGenContractNo(['IRRMHS0100'], 'HD_GLOBAL', 'HS')).toBe('IRRMHS0101')
    expect(poGenContractNo([], 'HD_INDUSTRY', 'HD')).toBe('IRRIHD0001')
  })

  it('批量下单各自连续编号，不修改已有号码', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 12))
    const existing = ['IRRIHS0404', 'IRRMHS0067', '2026900170']
    const original = [...existing]
    const generated: string[] = []
    for (const entity of ['HD_INDUSTRY', 'HD_GLOBAL', 'HSY', 'HD_INDUSTRY', 'HD_GLOBAL', 'HSY'] as const) {
      generated.push(poGenContractNo([...existing, ...generated], entity, 'HS'))
    }
    expect(generated).toEqual(['IRRIHS0405', 'IRRMHS0068', '2026900171', 'IRRIHS0406', 'IRRMHS0069', '2026900172'])
    expect(existing).toEqual(original)
  })

  it('华胜益 2026 年从 2026900171 开始并保持连续', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 8))
    expect(poGenContractNo([], 'HSY', 'HS')).toBe('2026900171')
    expect(poGenContractNo(['2026900170'], 'HSY', 'HS')).toBe('2026900171')
    expect(poGenContractNo(['2026900200'], 'HSY', 'HS')).toBe('2026900201')
    expect(poGenContractNo(['2026900171', '2026900172'], 'HSY', 'HS')).toBe('2026900173')
  })

  it('华胜益其他年份不继承 2026 年的基线', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2027, 0, 1))
    expect(poGenContractNo(['2026900170'], 'HSY', 'HS')).toBe('2027000001')
  })
})

describe('采购单追加明细币种', () => {
  it('keeps the existing contract currency until its entity number is explicitly corrected', () => {
    expect(poLineCurrency('IRRMHS0060', '供应商', '华胜益', 'RRM')).toBe('US$')
    expect(poLineCurrency('IRRIHS0405', '供应商', '华胜益', 'RRI')).toBe('US$')
    expect(poLineCurrency('2026900171', '供应商', '华胜益', 'RRM')).toBe('¥')
    expect(poLineCurrency('', '供应商', '华胜益', 'RRM')).toBe('¥')
  })
})
