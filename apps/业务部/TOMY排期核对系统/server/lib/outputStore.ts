import crypto from 'crypto'

export const OUTPUT_TTL_MS = 30 * 60 * 1000
export const OUTPUT_MAX_BYTES = 128 * 1024 * 1024
export const OUTPUT_MAX_ENTRIES = 64

export interface DownloadOutput {
  buffer: Buffer
  contentType: string
  filename: string
}

export class OutputCapacityError extends Error {
  constructor() {
    super('结果缓存暂时已满，请稍后重新核对；已有下载可在生成后 30 分钟内重试')
    this.name = 'OutputCapacityError'
  }
}

/** In-memory bearer outputs; never evict an unexpired download to accept new work. */
export function createOutputStore(options: { ttlMs?: number; maxBytes?: number; maxEntries?: number } = {}) {
  const ttlMs = options.ttlMs ?? OUTPUT_TTL_MS
  const maxBytes = options.maxBytes ?? OUTPUT_MAX_BYTES
  const maxEntries = options.maxEntries ?? OUTPUT_MAX_ENTRIES
  const entries = new Map<string, DownloadOutput & { expiresAt: number; timer: ReturnType<typeof setTimeout> }>()
  let bytes = 0

  function remove(id: string) {
    const entry = entries.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    bytes -= entry.buffer.byteLength
    entries.delete(id)
  }

  function prune() {
    for (const [id, entry] of entries) if (Date.now() >= entry.expiresAt) remove(id)
  }

  function assertCapacity(additionalBytes: number, additionalEntries: number) {
    prune()
    if (additionalBytes > maxBytes - bytes || additionalEntries > maxEntries - entries.size) {
      throw new OutputCapacityError()
    }
  }

  return {
    assertCapacity,
    /** Publish every artifact together only after generation and capacity checks succeed. */
    publish(outputs: DownloadOutput[]): string[] {
      assertCapacity(outputs.reduce((sum, output) => sum + output.buffer.byteLength, 0), outputs.length)
      const ids: string[] = []
      try {
        for (const output of outputs) {
          let id = crypto.randomUUID()
          while (entries.has(id)) id = crypto.randomUUID()
          const timer = setTimeout(() => remove(id), ttlMs)
          timer.unref?.()
          entries.set(id, { ...output, expiresAt: Date.now() + ttlMs, timer })
          bytes += output.buffer.byteLength
          ids.push(id)
        }
        return ids
      } catch (error) {
        for (const id of ids) remove(id)
        throw error
      }
    },
    get(id: string): DownloadOutput | undefined {
      prune()
      const entry = entries.get(id)
      return entry && { buffer: entry.buffer, contentType: entry.contentType, filename: entry.filename }
    },
    /** Used by isolated callers to release their own store; not an HTTP endpoint. */
    dispose() { for (const id of entries.keys()) remove(id) },
  }
}
