/**
 * The loopback-only JSON route behind this plugin's own configuration page.
 *
 * The Web client half reads the surface's current state and writes changes
 * here; the Host then saves them through the profile configuration editor, so
 * every setting lives in `cordis.patch.yml` like any other plugin option
 * rather than in a side channel this plugin owns alone.
 *
 * Only the local machine may call it, only JSON is accepted, and every accepted
 * field is validated — so a stray local request cannot invent configuration.
 *
 * @module dsh-mcp-server/config-route
 */

/** Largest accepted request body; the only legal payload is a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/** Literal loopback spellings a socket may report. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '::1', 'localhost'])

/** The surface modes the Host accepts. */
const SURFACE_MODES = new Set(['lazy', 'full'])

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
 * Validate one posted body into the config patch and the maintenance it asks for.
 *
 * @param parsed - the decoded JSON body.
 * @returns `{ patch, removeGroups }` or `{ error }`, never both.
 */
export function validateConfigPatch(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'The request body must be a JSON object.' }
  const patch = {}
  let removeGroups = []
  if (Object.hasOwn(parsed, 'exposeToDsh')) {
    if (typeof parsed.exposeToDsh !== 'boolean') return { error: '"exposeToDsh" must be a boolean.' }
    patch.exposeToDsh = parsed.exposeToDsh
  }
  if (Object.hasOwn(parsed, 'exposeToDshMode')) {
    if (!SURFACE_MODES.has(parsed.exposeToDshMode)) return { error: '"exposeToDshMode" must be "lazy" or "full".' }
    patch.exposeToDshMode = parsed.exposeToDshMode
  }
  if (Object.hasOwn(parsed, 'removeGroups')) {
    const value = parsed.removeGroups
    if (!Array.isArray(value) || value.some((path) => typeof path !== 'string' || !path.startsWith('/'))) {
      return { error: '"removeGroups" must be an array of absolute directory paths.' }
    }
    removeGroups = value
  }
  if (Object.keys(patch).length === 0 && removeGroups.length === 0) {
    return { error: 'Send at least one of { "exposeToDsh": true|false, "exposeToDshMode": "lazy"|"full", "removeGroups": ["<absolute path>"] }.' }
  }
  return { patch, removeGroups }
}

/**
 * Build the request handler for the configuration route.
 *
 * @param options - `{ snapshot, write, logger }`.
 * @param options.snapshot - reads the current settings (may be async).
 * @param options.write - `(patch) => Promise<void>`, saves one validated patch.
 * @param options.remove - `(paths) => Promise<{ removed, missing }>`, drops project
 *   registrations the caller names; it deletes no folder, file, or Session.
 * @param options.logger - debug sink.
 * @returns an async `(req, res)` handler.
 */
export function createConfigHandler({ snapshot, write, remove, logger = () => {} }) {
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
      const validated = validateConfigPatch(parsed)
      if (validated.error) {
        sendJson(res, 400, { error: validated.error })
        return
      }
      // Maintenance first: a config write reloads this plugin, so anything that
      // needs this activation must run before it.
      let removal
      if (validated.removeGroups.length > 0) {
        if (typeof remove !== 'function') {
          sendJson(res, 400, { error: 'This deployment cannot remove a project registration.' })
          return
        }
        removal = await remove(validated.removeGroups)
      }
      let applied
      if (Object.keys(validated.patch).length > 0) {
        await write(validated.patch)
        applied = 'reloading'
      }
      // A config write reloads this plugin, so the snapshot still describes the
      // previous activation: report what was asked for, not what is loaded.
      const payload = await snapshot()
      sendJson(res, 200, { ok: true, ...payload, ...validated.patch, ...(removal ? { removal } : {}), ...(applied ? { applied } : { applied: 'unchanged' }) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('warn', 'configuration request failed', { error: message })
      sendJson(res, 500, { error: message })
    }
  }
}
