import { describe, expect, it } from 'vitest'
import { orderRegion } from '../src/utils/orderRegion'

describe('orderRegion', () => {
  it('uses the explicit management region even when the factory is in another region', () => {
    expect(orderRegion({ region: 'dongguan', expand: { factory: { name: '邵阳兴信', craft: 'sewing', region: 'hunan' } } })).toBe('dongguan')
  })

  it('falls back to the factory region for legacy orders', () => {
    expect(orderRegion({ expand: { factory: { name: '湖南厂', craft: 'sewing', region: 'hunan' } } })).toBe('hunan')
  })
})
