/**
 * The loopback-only JSON route behind this plugin's own configuration page.
 *
 * The Web client half reads the switch's current value and writes it here; the
 * Host then saves it through the profile configuration editor, so the value
 * lives in `cordis.patch.yml` like every other plugin setting rather than in a
 * side channel this plugin owns alone.
 *
 * Only the local machine may call it, only JSON is accepted, and a write must
 * name a boolean — so a stray local request cannot invent configuration.
 *
 * @module dsh-mcp-server/config-route
 */

/** Largest accepted request body; the only legal payload is a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/** Literal loopback spellings a socket may report. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '::1', 'localhost'])

/** Whether a peer address is this machine. */
function isLoopback(address) {
  if (typeof address !== 'string' || !address) return false
  if (LOOPBACK_NAMES.has(address)) return true
  return address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** Send one JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2) + '\n'
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read a bounded request body as text. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`the request body is larger than ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Build the request handler for the configuration route.
 *
 * @param options - `{ snapshot, write, logger }`.
 * @param options.snapshot - reads the current settings (may be async).
 * @param options.write - `(exposeToDsh) => Promise<void>`, saves the switch.
 * @param options.logger - debug sink.
 * @returns an async `(req, res)` handler.
 */
export function createConfigHandler({ snapshot, write, logger = () => {} }) {
  return async function handleConfigRequest(req, res) {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: 'This configuration endpoint is served to the local machine only.' })
        return
      }
      const method = (req.method ?? 'GET').toUpperCase()
      if (method === 'GET' || method === 'HEAD') {
        const payload = await snapshot()
        if (method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end()
          return
        }
        sendJson(res, 200, payload)
        return
      }
      if (method !== 'POST') {
        res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' })
        res.end('Method Not Allowed\n')
        return
      }
      const raw = await readBody(req)
      let parsed
      try {
        parsed = raw.trim() ? JSON.parse(raw) : {}
      } catch {
        sendJson(res, 400, { error: 'The request body must be JSON.' })
        return
      }
      if (typeof parsed?.exposeToDsh !== 'boolean') {
        sendJson(res, 400, { error: 'Send { "exposeToDsh": true } or { "exposeToDsh": false }.' })
        return
      }
      await write(parsed.exposeToDsh)
      // The write reloads this plugin, so the snapshot still describes the
      // previous activation: report what was asked for, not what is loaded.
      const payload = await snapshot()
      sendJson(res, 200, { ok: true, ...payload, exposeToDsh: parsed.exposeToDsh, applied: 'reloading' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('warn', 'configuration request failed', { error: message })
      sendJson(res, 500, { error: message })
    }
  }
}
