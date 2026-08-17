import { describe, it, expect } from 'vitest'
import {
  allowedCrafts,
  canApproveStatus,
  canEditOrders,
  canEditOutput,
  canViewCraft,
  setAuthorizedCrafts,
  setPermissionOverrides,
  visibleCraft,
} from '../src/utils/permissions'
import { BUYER_CRAFT, isBuyer, ROLE_LABELS } from '../src/constants/roles'

describe('permissions', () => {
  it('supports the electronics buyer role and maps it to the electronics department', () => {
    expect(ROLE_LABELS.buyer_electronics).toBe('电子部采购')
    expect(BUYER_CRAFT.buyer_electronics).toBe('electronics')
    expect(isBuyer('buyer_electronics')).toBe(true)
    expect(canEditOrders('buyer_electronics')).toBe(true)
  })
  it('only finance_cost can edit output', () => {
    expect(canEditOutput('finance_cost')).toBe(true)
    expect(canEditOutput('buyer_injection')).toBe(false)
    expect(canEditOutput('admin')).toBe(true)
  })
  it('only sc_manager/admin approve status', () => {
    expect(canApproveStatus('sc_manager')).toBe(true)
    expect(canApproveStatus('buyer_injection')).toBe(false)
  })
  it('uses the orders.edit override for all order editing actions', () => {
    setPermissionOverrides(null)
    expect(canEditOrders('buyer_injection')).toBe(true)
    expect(canEditOrders('quality_qc')).toBe(false)

    setPermissionOverrides({ 'orders.edit': false })
    expect(canEditOrders('buyer_injection')).toBe(false)

    setPermissionOverrides({ 'orders.edit': true })
    expect(canEditOrders('quality_qc')).toBe(true)
    setPermissionOverrides(null)
  })
  it('supports multiple authorized departments', () => {
    setAuthorizedCrafts(['painting', 'sewing'])
    expect(allowedCrafts()).toEqual(['painting', 'sewing'])
    expect(canViewCraft('painting')).toBe(true)
    expect(canViewCraft('injection')).toBe(false)
    expect(visibleCraft('buyer_painting')).toBeNull()
    setAuthorizedCrafts(['painting'])
    expect(visibleCraft('buyer_painting')).toBe('painting')
    setAuthorizedCrafts([])
    expect(allowedCrafts()).toHaveLength(5)
  })
})
