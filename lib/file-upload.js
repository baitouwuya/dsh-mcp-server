/**
 * Presigned uploads: mint a slot, PUT the bytes into it, reference it later.
 *
 * The MCP transport carries JSON only, so a client cannot hand the server a
 * binary. This module adds a capability URL: `dsh_prepare_upload` mints one
 * short-lived, single-success slot per file, and the client PUTs the bytes to
 * that URL with no credential at all — the unguessable nonce *is* the
 * capability. See `docs/design/2026-11-12-file-transport.md`.
 */

import { createHash, randomBytes } from 'node:crypto'

/**
 * The four types the Harness attachment provider actually accepts; advertising a
 * fifth would only move the refusal from mint time to storage time. The
 * deployment's own list can narrow this further at mint time.
 */
export const UPLOAD_MEDIA_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

const MIB = 1024 * 1024
const MAX_PIXELS = 100 * 1024 * 1024
const SLOT_MINTED = 'minted'
const SLOT_CONSUMING = 'consuming'
const SLOT_STORED = 'stored'
const SLOT_GONE = 'gone'
const SWEEP_INTERVAL_MS = 60_000
/** How long a claimed slot may stay claimed past its deadline before it is reclaimed. */
const CONSUMING_GRACE_MS = 60_000
const ROUTE_PREFIX = '/mcp-files/'

const clamp = (value, fallback, min, max) => {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return fallback
  return Math.max(min, Math.min(max, raw))
}

/** Resolve the upload knobs out of the plugin configuration, clamped. */
export function uploadConfig(config = {}) {
  return {
    ttlMs: clamp(config.uploadTtlMs, 300_000, 60_000, 24 * 60 * 60 * 1000),
    fileIdTtlMs: clamp(config.fileIdTtlMs, 3_600_000, 60_000, 24 * 60 * 60 * 1000),
    maxFileBytes: clamp(config.uploadMaxFileBytes, 20 * MIB, 64 * 1024, 256 * MIB),
    maxFiles: clamp(config.uploadMaxFiles, 10, 1, 20),
    maxBytes: clamp(config.uploadMaxBytes, 64 * MIB, MIB, 512 * MIB),
    maxAttempts: clamp(config.uploadMaxAttempts, 3, 1, 10),
    globalBudgetBytes: clamp(config.uploadGlobalBudgetBytes, 512 * MIB, 64 * MIB, 4096 * MIB),
    requireSha256: config.uploadRequireSha256 === true,
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Magic-number sniffing: the declared type must match the bytes. */
function sniffMediaType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp' && buffer.subarray(8, 12).toString('latin1').startsWith('avif')) return 'image/avif'
  return undefined
}

/** Declared pixel count, read from the header without decoding the image. */
function declaredPixels(buffer, mediaType) {
  try {
    if (mediaType === 'image/png' && buffer.length >= 24) {
      return buffer.readUInt32BE(16) * buffer.readUInt32BE(20)
    }
    if (mediaType === 'image/gif' && buffer.length >= 10) {
      return buffer.readUInt16LE(6) * buffer.readUInt16LE(8)
    }
    if (mediaType === 'image/webp') {
      const chunk = buffer.subarray(12, 16).toString('latin1')
      if (chunk === 'VP8X' && buffer.length >= 30) {
        const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16))
        const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16))
        return width * height
      }
      if (chunk === 'VP8 ' && buffer.length >= 30) {
        return (buffer.readUInt16LE(26) & 0x3fff) * (buffer.readUInt16LE(28) & 0x3fff)
      }
      if (chunk === 'VP8L' && buffer.length >= 25) {
        const bits = buffer.readUInt32LE(21)
        return (1 + (bits & 0x3fff)) * (1 + ((bits >> 14) & 0x3fff))
      }
      return undefined
    }
    if (mediaType === 'image/avif') {
      // The ISO-BMFF image size lives in an `ispe` box; scanning for it avoids a
      // full box walk, which is more parser than this guard needs.
      let offset = buffer.indexOf('ispe', 4, 'latin1')
      while (offset !== -1) {
        if (offset + 12 <= buffer.length) return buffer.readUInt32BE(offset + 8) * buffer.readUInt32BE(offset + 12 - 4)
        offset = buffer.indexOf('ispe', offset + 4, 'latin1')
      }
      return undefined
    }
    if (mediaType === 'image/jpeg') {
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue }
        const marker = buffer[offset + 1]
        const size = buffer.readUInt16BE(offset + 2)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return buffer.readUInt16BE(offset + 7) * buffer.readUInt16BE(offset + 5)
        }
        offset += 2 + size
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

class UploadRejection extends Error {
  constructor(status, message, { burnsSlot = false } = {}) {
    super(message)
    this.status = status
    this.burnsSlot = burnsSlot
  }
}

/**
 * Slots live in memory on purpose: the endpoint is stateless, so a restart
 * drops every unminted file id and the client mints again. Nothing here is
 * worth persisting — an image that reached a message is already an attachment
 * reference held by the delivery path.
 */
export function createUploadStore({ attachments, getAttachments, config, logger = () => {}, now = () => Date.now() }) {
  // The service may register after this plugin loads, so resolve it per call
  // unless the caller handed over a fixed one (tests do).
  const storeAttachments = () => (typeof getAttachments === 'function' ? getAttachments() : attachments)
  const limits = uploadConfig(config)
  // Owner scoping mirrors the session rule: off by default, and only meaningful
  // when the endpoint already restricts tools to the caller that owns them.
  const restrictToOwner = config?.restrictToOwner === true
  const byNonceHash = new Map()
  const byFileId = new Map()

  const nonceKey = (nonce) => createHash('sha256').update(nonce).digest('hex').slice(0, 32)

  function drop(slot) {
    slot.state = SLOT_GONE
    byNonceHash.delete(slot.nonceKey)
    byFileId.delete(slot.fileId)
  }

  function sweep(at = now()) {
    for (const slot of byFileId.values()) {
      // A slot being consumed is mid-write, so it is given a grace period past
      // its mint deadline: without one, a half-open connection would hold it
      // until the server's own request timeout reaps the socket.
      if (slot.state === SLOT_CONSUMING) {
        if (slot.expiresAt + CONSUMING_GRACE_MS <= at) {
          drop(slot)
          counters.expired += 1
        }
        continue
      }
      const deadline = slot.state === SLOT_STORED ? slot.fileIdExpiresAt : slot.expiresAt
      if (deadline <= at) {
        drop(slot)
        counters.expired += 1
      }
    }
  }

  const timer = setInterval(() => sweep(), SWEEP_INTERVAL_MS)
  timer.unref?.()

  /** Mint one slot per requested file. */
  function mint(files, { origin, owner }) {
    if (!storeAttachments()) {
      throw new UploadRejection(501, 'this DSH deployment exposes no attachment service, so file upload is unavailable')
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new UploadRejection(400, '"files" must be a non-empty array')
    }
    if (files.length > limits.maxFiles) {
      throw new UploadRejection(400, `"files" may hold at most ${limits.maxFiles} entries`)
    }
    const planned = files.map((file, index) => {
      const mediaType = file?.mediaType
      if (typeof mediaType !== 'string' || !UPLOAD_MEDIA_TYPES.includes(mediaType)) {
        throw new UploadRejection(415, `files[${index}].mediaType must be one of ${UPLOAD_MEDIA_TYPES.join(', ')}`)
      }
      const allowed = storeAttachments().imageLimits?.mediaTypes
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(mediaType)) {
        throw new UploadRejection(415, `this deployment does not accept ${mediaType}`)
      }
      // A caller that does not say how big its file is still gets the full
      // per-file ceiling; only a *declared* size counts toward the per-mint cap,
      // so a batch of ten unnamed images is not refused for reserving ten times
      // the ceiling it will never use.
      const declaredBytes = Number.isFinite(Number(file?.expectedBytes)) && Number(file.expectedBytes) > 0
        ? Math.min(Number(file.expectedBytes), limits.maxFileBytes)
        : undefined
      const expectedBytes = declaredBytes ?? limits.maxFileBytes
      const declaredSha = typeof file?.sha256 === 'string' ? file.sha256.toLowerCase() : undefined
      if (limits.requireSha256 && !declaredSha) {
        throw new UploadRejection(400, 'files[].sha256 is required by this deployment')
      }
      return { mediaType, expectedBytes, declaredBytes, declaredSha, name: typeof file?.name === 'string' ? file.name : undefined }
    })
    const requested = planned.reduce((sum, item) => sum + (item.declaredBytes ?? 0), 0)
    if (requested > limits.maxBytes) {
      throw new UploadRejection(400, `this mint declares ${requested} bytes; the limit is ${limits.maxBytes}`)
    }
    const pending = [...byFileId.values()].reduce((sum, slot) => sum + (slot.state === SLOT_STORED ? 0 : slot.maxBytes), 0)
    if (pending + requested > limits.globalBudgetBytes) {
      throw new UploadRejection(429, 'too many bytes are already in flight; retry once the earlier uploads land')
    }

    const mintedAt = now()
    if (!underWindow(mintWindow, 60, mintedAt, planned.length)) {
      throw new UploadRejection(429, 'too many upload sessions in the last minute')
    }
    logger('debug', 'upload session minted', {
      count: planned.length,
      mediaTypes: [...new Set(planned.map((item) => item.mediaType))],
      requestedBytes: requested,
    })
    return planned.map((item) => {
      const nonce = randomBytes(32).toString('base64url')
      const fileId = 'f_' + randomBytes(9).toString('base64url')
      const slot = {
        owner,
        nonceKey: nonceKey(nonce),
        fileId,
        mediaType: item.mediaType,
        name: item.name,
        maxBytes: item.expectedBytes,
        declaredSha: item.declaredSha,
        attempts: 0,
        state: SLOT_MINTED,
        expiresAt: mintedAt + limits.ttlMs,
        fileIdExpiresAt: 0,
        ref: undefined,
        storedBytes: 0,
      }
      counters.minted += 1
      byNonceHash.set(slot.nonceKey, slot)
      byFileId.set(fileId, slot)
      return {
        fileId,
        uploadUrl: origin + ROUTE_PREFIX + nonce,
        method: 'PUT',
        expiresAt: new Date(slot.expiresAt).toISOString(),
        maxBytes: slot.maxBytes,
      }
    })
  }

  /** Resolve a file id for delivery, or explain why it cannot be used. */
  function resolve(fileId, { owner } = {}) {
    sweep()
    const slot = byFileId.get(fileId)
    if (!slot) throw new UploadRejection(404, `unknown fileId: ${fileId}`)
    // Strict equality when the endpoint restricts by owner: an anonymous caller
    // must not reach a named client's file, and a named one must not reach an
    // anonymous upload. Both sides default to `undefined`, so equals still works.
    if (restrictToOwner && slot.owner !== owner) {
      throw new UploadRejection(404, 'unknown fileId')
    }
    if (slot.state !== SLOT_STORED) {
      throw new UploadRejection(409, `fileId ${fileId} has not finished uploading`)
    }
    return slot
  }

  const counters = { minted: 0, stored: 0, failed: 0, expired: 0 }
  const mintWindow = []

  /** Sliding-window ceiling: keep the timestamps that still count, refuse past the cap. */
  function underWindow(window, cap, at, count = 1) {
    while (window.length > 0 && window[0] <= at - 60_000) window.shift()
    if (window.length + count > cap) return false
    for (let index = 0; index < count; index += 1) window.push(at)
    return true
  }

  /**
   * Claim a slot before a single byte is read.
   *
   * The claim is the CAS: two callers cannot both hold a slot, and an upload
   * that never arrives cannot leave a half-consumed entry behind.
   */
  /**
   * Spend one of a link's content-level attempts; returns true when that burned it.
   *
   * Transport failures never come here: only bytes that arrived and were judged
   * wrong (or a provider refusing to store them) are worth counting.
   */
  function chargeAttempt(slot) {
    slot.attempts += 1
    if (slot.attempts < limits.maxAttempts) return false
    drop(slot)
    counters.failed += 1
    return true
  }

  function begin(nonce, contentType) {
    sweep()
    const slot = byNonceHash.get(nonceKey(nonce))
    if (!slot) throw new UploadRejection(410, 'this upload link is unknown or expired')

    // State comes first: a spent link is spent whatever the body looks like.
    if (slot.state === SLOT_STORED) throw new UploadRejection(409, 'this upload link has already been used')
    if (slot.state === SLOT_CONSUMING) throw new UploadRejection(409, 'this upload link is already being consumed')
    const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase()
    if (declared && declared !== 'application/octet-stream' && declared !== slot.mediaType) {
      if (chargeAttempt(slot)) throw new UploadRejection(410, 'too many failed attempts on this link')
      throw new UploadRejection(415, `this link was minted for ${slot.mediaType}, not ${declared}`)
    }
    slot.putWindow ??= []
    if (!underWindow(slot.putWindow, 30, now())) {
      throw new UploadRejection(429, 'too many upload attempts on this link; wait a minute')
    }
    slot.state = SLOT_CONSUMING
    return slot
  }

  /** Hand a claimed slot back after a transport failure (no bytes were judged). */
  function release(slot) {
    if (slot.state === SLOT_CONSUMING) slot.state = SLOT_MINTED
  }

  /** Validate the received bytes and store them. */
  async function commit(slot, buffer, { declaredBytes } = {}) {
    try {
      if (Number.isFinite(declaredBytes) && declaredBytes !== buffer.length) {
        throw new UploadRejection(415, 'content-length does not match the bytes received', { burnsSlot: true })
      }
      if (buffer.length > slot.maxBytes) throw new UploadRejection(413, `this link accepts at most ${slot.maxBytes} bytes`)

      const mediaType = sniffMediaType(buffer)
      if (mediaType !== slot.mediaType) {
        throw new UploadRejection(415, `the bytes are not ${slot.mediaType}`, { burnsSlot: true })
      }
      const digest = sha256(buffer)
      if (slot.declaredSha && slot.declaredSha !== digest) {
        throw new UploadRejection(415, 'the bytes do not match the declared sha256', { burnsSlot: true })
      }
      const pixels = declaredPixels(buffer, slot.mediaType)
      if (pixels !== undefined && pixels > MAX_PIXELS) {
        throw new UploadRejection(415, 'the image dimensions exceed the 100 MP ceiling', { burnsSlot: true })
      }
      if (slot.expiresAt <= now()) {
        drop(slot)
        counters.expired += 1
        throw new UploadRejection(410, 'this upload link is unknown or expired')
      }

      const [ref] = await storeAttachments().saveImages([{ data: buffer, mediaType: slot.mediaType, ...(slot.name ? { name: slot.name } : {}) }])
      if (slot.state === SLOT_GONE) throw new UploadRejection(410, 'this upload link was dropped while the image was being stored')
      slot.ref = ref
      slot.storedBytes = Number.isFinite(ref?.bytes) ? ref.bytes : buffer.length
      slot.state = SLOT_STORED
      slot.fileIdExpiresAt = now() + limits.fileIdTtlMs
      counters.stored += 1
      logger('debug', 'file uploaded', {
        fileId: slot.fileId,
        noncePrefix: slot.nonceKey.slice(0, 8),
        bytes: slot.storedBytes,
        mediaType: slot.mediaType,
      })
      // Report what the store kept, not what arrived: the provider may normalize
      // (re-encode, downscale) before it publishes the reference.
      return {
        fileId: slot.fileId,
        storedBytes: slot.storedBytes,
        sha256: digest,
        mediaType: ref?.mediaType ?? slot.mediaType,
      }
    } catch (error) {
      // A provider refusing bytes it cannot store is a failure of this link, not
      // of the connection: without counting it, a caller could retry forever.
      const storageFailure = !(error instanceof UploadRejection)
      if ((storageFailure || error.burnsSlot) && chargeAttempt(slot)) {
        throw new UploadRejection(410, 'too many failed attempts on this link')
      }
      throw error
    } finally {
      if (slot.state === SLOT_CONSUMING) slot.state = SLOT_MINTED
    }
  }

  return {
    limits,
    get available() { return Boolean(storeAttachments()) },
    mint,
    begin,
    commit,
    release,
    resolve,
    sweep,
    stats: () => ({
      pendingSlots: [...byFileId.values()].filter((slot) => slot.state !== SLOT_STORED).length,
      storedFileIds: [...byFileId.values()].filter((slot) => slot.state === SLOT_STORED).length,
      minted: counters.minted,
      stored: counters.stored,
      failed: counters.failed,
      expired: counters.expired,
    }),
    dispose: () => clearInterval(timer),
  }
}

/** Read a whole request body, refusing anything past *maxBytes*. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    let ended = false
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        // Stop buffering, but let the handler answer before the socket closes:
        // destroying here would reach the client as a reset instead of a 413.
        settled = true
        req.pause()
        reject(new UploadRejection(413, `the request body exceeds ${maxBytes} bytes`))
        return
      }
      if (!settled) chunks.push(chunk)
    })
    req.on('end', () => {
      ended = true
      if (!settled) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
    // A client that hangs up mid-body must not leave the slot claimed.
    req.on('close', () => {
      if (settled || ended) return
      settled = true
      reject(new UploadRejection(400, 'the client closed the connection before the body was complete'))
    })
  })
}

/**
 * The `PUT /mcp-files/<nonce>` handler.
 *
 * Registered with `kind: "prefix"`; everything after the prefix is the nonce.
 * No bearer token: the nonce is the capability, and requiring the endpoint
 * token here would make the feature unusable by a client that can only run a
 * shell command.
 */
export function createUploadRouteHandler({ store, logger = () => {} }) {
  return async function handleUpload(req, res) {
    const send = (status, body) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
      res.end(payload)
    }
    if ((req.method ?? '').toUpperCase() !== 'PUT') {
      send(405, { error: 'this endpoint accepts PUT only' })
      return
    }
    const nonce = String(req.url ?? '').slice(ROUTE_PREFIX.length)
    if (!nonce) {
      send(404, { error: 'missing upload nonce' })
      return
    }

    // Claim the slot before reading a byte: an unknown or already-used link must
    // not make the server buffer a body it will only throw away.
    let slot
    try {
      slot = store.begin(nonce, req.headers?.['content-type'])
    } catch (error) {
      const status = error instanceof UploadRejection ? error.status : 500
      send(status, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    let buffer
    try {
      buffer = await readBody(req, Math.min(store.limits.maxFileBytes, slot.maxBytes) + 1)
    } catch (error) {
      store.release(slot)
      const status = error instanceof UploadRejection ? error.status : 400
      send(status, { error: error instanceof Error ? error.message : String(error) })
      // The body was abandoned mid-stream; closing the connection is the only
      // way to stop a client that keeps sending.
      if (status === 413) req.destroy()
      return
    }

    const declared = req.headers?.['content-length']
    try {
      send(200, await store.commit(slot, buffer, { declaredBytes: declared === undefined ? undefined : Number(declared) }))
    } catch (error) {
      const status = error instanceof UploadRejection ? error.status : 500
      if (status === 500) logger('error', 'upload failed', { error: error instanceof Error ? error.message : String(error) })
      send(status, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export { ROUTE_PREFIX, UploadRejection }
