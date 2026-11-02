import type { Request, Response, NextFunction } from 'express'

export const MAX_PROCESS_UPLOAD_BYTES = 50 * 1024 * 1024
export class UploadLimitError extends Error {
  constructor() { super('单次上传总量不能超过 50 MB，请分批核对'); this.name = 'UploadLimitError' }
}

/** One upload/parse at a time; disconnecting during parsing never opens a second slot. */
export function createUploadAdmission(maxBytes = MAX_PROCESS_UPLOAD_BYTES) {
  type Lease = { processing: boolean; release: () => void }
  const leases = new WeakMap<Request, Lease>()
  let busy = false

  function release(req: Request) { leases.get(req)?.release() }
  return {
    release,
    begin(req: Request) { const lease = leases.get(req); if (lease) lease.processing = true },
    admit(req: Request, res: Response, next: NextFunction) {
      const declared = Number(req.headers['content-length'] ?? 0)
      if (declared > maxBytes) {
        res.setHeader('Connection', 'close')
        res.status(413).json({ error: '单次上传总量不能超过 50 MB，请分批核对' })
        return
      }
      if (busy) {
        res.setHeader('Retry-After', '5')
        res.status(429).json({ error: '当前已有核对任务正在处理，请稍后重试' })
        return
      }
      busy = true
      let bytes = 0, released = false, rejected = false
      const lease: Lease = { processing: false, release: () => {
        if (released) return
        released = true
        busy = false
        leases.delete(req)
        req.off('data', onData)
        req.off('aborted', onAbort)
        res.off('close', onClose)
      } }
      function onAbort() { if (!lease.processing) lease.release() }
      function onClose() { if (!lease.processing) lease.release() }
      function onData(chunk: Buffer) {
        bytes += chunk.byteLength
        if (bytes <= maxBytes || rejected) return
        rejected = true
        // Multer's request-error path stops the multipart parser and releases
        // its buffers, then drains the unread body before forwarding the error.
        // Sending/closing here would race a chunked sender and produce EPIPE.
        req.emit('error', new UploadLimitError())
      }
      leases.set(req, lease)
      req.on('data', onData)
      req.once('aborted', onAbort)
      res.once('close', onClose)
      next()
    },
  }
}
