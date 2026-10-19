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

/** The delivery policies the Host accepts. */
const BUSY_MODES = new Set(['setting', 'queue', 'steer'])

/** Longest session id accepted by the GUI command; ids are short and opaque. */
const MAX_SESSION_ID = 200

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
  let openSession
  let ackCommand = false
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
  for (const field of ['groupSessions', 'createGroups']) {
    if (!Object.hasOwn(parsed, field)) continue
    if (typeof parsed[field] !== 'boolean') return { error: `"${field}" must be a boolean.` }
    patch[field] = parsed[field]
  }
  if (Object.hasOwn(parsed, 'busyMode')) {
    if (!BUSY_MODES.has(parsed.busyMode)) return { error: '"busyMode" must be "setting", "queue", or "steer".' }
    patch.busyMode = parsed.busyMode
  }
  if (Object.hasOwn(parsed, 'syncOnStart')) {
    if (typeof parsed.syncOnStart !== 'boolean') return { error: '"syncOnStart" must be a boolean.' }
    patch.syncOnStart = parsed.syncOnStart
  }
  if (Object.hasOwn(parsed, 'openSession')) {
    const value = parsed.openSession
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_SESSION_ID) {
      return { error: '"openSession" must be a session id.' }
    }
    openSession = value.trim()
  }
  if (Object.hasOwn(parsed, 'ackCommand')) {
    if (typeof parsed.ackCommand !== 'boolean') return { error: '"ackCommand" must be a boolean.' }
    ackCommand = parsed.ackCommand
  }
  const empty = Object.keys(patch).length === 0 && removeGroups.length === 0
    && openSession === undefined && ackCommand === false
  if (empty) {
    return {
      error: 'Send at least one of { "exposeToDsh", "exposeToDshMode", "groupSessions", "createGroups", "busyMode", "syncOnStart", "removeGroups", "openSession", "ackCommand" }.',
    }
  }
  return { patch, removeGroups, openSession, ackCommand }
}

/**
 * Build the request handler for the configuration route.
 *
 * @param options - `{ snapshot, write, logger }`.
 * @param options.snapshot - reads the current settings (may be async).
 * @param options.write - `(patch) => Promise<void>`, saves one validated patch.
 * @param options.remove - `(paths) => Promise<{ removed, missing }>`, drops project
 *   registrations the caller names; it deletes no folder, file, or Session.
 * @param options.queueSession - `(sessionId) => Promise<boolean>`, asks the open Web
 *   page to open one Session; the request changes nothing about the Session.
 * @param options.ackCommand - `() => Promise<void>`, clears a consumed GUI command.
 * @param options.logger - debug sink.
 * @returns an async `(req, res)` handler.
 */
export function createConfigHandler({ snapshot, write, remove, queueSession, ackCommand, logger = () => {} }) {
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
      if (validated.openSession !== undefined) {
        if (typeof queueSession !== 'function') {
          sendJson(res, 400, { error: 'This deployment cannot drive a Web GUI.' })
          return
        }
        await queueSession(validated.openSession)
      }
      if (validated.ackCommand === true && typeof ackCommand === 'function') await ackCommand()
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
