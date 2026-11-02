import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOutputStore, OUTPUT_TTL_MS, OutputCapacityError } from './outputStore.js'

const output = (value: string) => ({ buffer: Buffer.from(value), contentType: 'application/zip', filename: 'fixture.zip' })
afterEach(() => vi.useRealTimers())

describe('bounded retryable output store', () => {
  it('keeps the same bytes available for repeat downloads for 30 minutes, then frees capacity', () => {
    vi.useFakeTimers()
    const store = createOutputStore({ maxBytes: 4, maxEntries: 1 })
    const [token] = store.publish([output('data')])
    expect(token).toMatch(/^[a-f0-9-]{36}$/)
    expect(store.get(token)?.buffer.toString()).toBe('data')
    expect(store.get(token)?.buffer.toString()).toBe('data')
    vi.advanceTimersByTime(OUTPUT_TTL_MS - 1)
    expect(store.get(token)?.buffer.toString()).toBe('data')
    vi.advanceTimersByTime(1)
    expect(store.get(token)).toBeUndefined()
    expect(() => store.publish([output('next')])).not.toThrow()
    store.dispose()
  })

  it('rejects a whole ZIP+XLSX batch at the byte limit without evicting an existing token', () => {
    const store = createOutputStore({ maxBytes: 7, maxEntries: 8 })
    const [first] = store.publish([output('keep')])
    expect(() => store.publish([output('zip'), output('xlsx')])).toThrow(OutputCapacityError)
    expect(store.get(first)?.buffer.toString()).toBe('keep')
    expect(() => store.publish([output('new')])).not.toThrow()
    store.dispose()
  })

  it('enforces the entry cap without partial publication or premature expiry', () => {
    const store = createOutputStore({ maxBytes: 100, maxEntries: 2 })
    const [first] = store.publish([output('a')])
    expect(() => store.publish([output('b'), output('c')])).toThrow(OutputCapacityError)
    const [second] = store.publish([output('d')])
    expect(first).not.toBe(second)
    expect(store.get(first)?.buffer.toString()).toBe('a')
    expect(store.get(second)?.buffer.toString()).toBe('d')
    expect(store.get('not-a-token')).toBeUndefined()
    store.dispose()
  })

  it('prunes by expiry time even when timer callbacks were delayed', () => {
    const store = createOutputStore({ ttlMs: 1000, maxBytes: 1, maxEntries: 1 })
    const [id] = store.publish([output('a')])
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 1001)
    expect(store.get(id)).toBeUndefined()
    expect(() => store.publish([output('b')])).not.toThrow()
    clock.mockRestore()
    store.dispose()
  })
})
