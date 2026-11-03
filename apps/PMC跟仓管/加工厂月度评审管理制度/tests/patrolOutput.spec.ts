import { expect, it } from 'vitest'
import { patrolOutputAmounts, outputAmounts } from '../src/utils/outputPeriod'
it('supports independent inspection years, inclusive days, decimals and missing dates', () => {
 const orders=[{factory:'a',order_date:'2025-12-31',amount:2},{factory:'a',order_date:'2026-01-01',amount:3.125},{factory:'a',order_date:'2026-02-01',amount:9},{factory:'a',amount:100}]
 expect(patrolOutputAmounts(orders,'2025-12-31')).toEqual({a:2})
 expect(patrolOutputAmounts(orders,'2026-01-01')).toEqual({a:3.125})
 expect(patrolOutputAmounts(orders,'2026-02-30')).toBeNull()
 expect(patrolOutputAmounts(orders,'')).toBeNull()
 expect(patrolOutputAmounts(orders,'2026-01-31')).toEqual(outputAmounts(orders,{start:'2026-01',end:'2026-01'}))
})
