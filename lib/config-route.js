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

import { PRESET_NAMES } from './config-presets.js'

/**
 * Default ceiling for the request body of this route.
 *
 * The only legal payload is a small patch of switches, so the default stays
 * tiny; a deployment that posts larger patches can raise it with the row's
 * `configMaxBodyBytes` option.
 */
const DEFAULT_MAX_BODY_BYTES = 4096

/** The range `configMaxBodyBytes` (and the handler option) is clamped into. */
const MIN_MAX_BODY_BYTES = 1024
const MAX_MAX_BODY_BYTES = 1024 * 1024

/** A whole byte count for one body ceiling, never outside the accepted range. */
function clampBodyLimit(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return DEFAULT_MAX_BODY_BYTES
  return Math.max(MIN_MAX_BODY_BYTES, Math.min(MAX_MAX_BODY_BYTES, Math.trunc(raw)))
}

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

/** Read a request body, never past the caller's ceiling. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let failed = false
    const fail = (error) => {
      if (failed) return
      failed = true
      // Drain instead of destroying the socket: the handler still owes the
      // caller a 413 JSON response, and a destroy turns that into a reset.
      req.resume()
      reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error(`the request body is larger than ${limit} bytes`)
        error.code = 'BODY_TOO_LARGE'
        fail(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', (error) => { if (!failed) { failed = true; reject(error) } })
  })
}

/** Whether a request declares a JSON body. */
function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

/**
 * Validate one posted body into the config patch and the maintenance it asks for.
 *
 * @param parsed - the decoded JSON body.
 * @returns `{ patch, removeGroups }` or `{ error }`, never both.
 */
export function validateConfigPatch(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'The request body must be a JSON object.' }
  const known = new Set([
    'exposeToDsh',
    'exposeToDshMode',
    'preset',
    'removeGroups',
    'groupSessions',
    'createGroups',
    'busyMode',
    'answerApprovals',
    'answerQuestions',
    'syncOnStart',
    'openSession',
    'ackCommand',
  ])
  const unknown = Object.keys(parsed).filter((key) => !known.has(key))
  if (unknown.length > 0) return { error: `Unknown field(s): ${unknown.join(', ')}.` }
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
  if (Object.hasOwn(parsed, 'preset')) {
    if (!PRESET_NAMES.includes(parsed.preset)) {
      return { error: `"preset" must be one of ${PRESET_NAMES.map((name) => `"${name}"`).join(', ')}.` }
    }
    patch.preset = parsed.preset
  }
  if (Object.hasOwn(parsed, 'removeGroups')) {
    const value = parsed.removeGroups
    if (!Array.isArray(value) || value.some((path) => typeof path !== 'string' || !path.startsWith('/'))) {
      return { error: '"removeGroups" must be an array of absolute directory paths.' }
    }
    removeGroups = value
  }
  for (const field of ['groupSessions', 'createGroups', 'answerApprovals', 'answerQuestions']) {
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
      error: 'Send at least one of { "exposeToDsh", "exposeToDshMode", "preset", "groupSessions", "createGroups", "busyMode", "answerApprovals", "answerQuestions", "syncOnStart", "removeGroups", "openSession", "ackCommand" }.',
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
 * @param options.maxBodyBytes - POST body ceiling for this route; defaults to
 *   `DEFAULT_MAX_BODY_BYTES` and is clamped to 1 KB - 1 MB. It is separate from
 *   the endpoint's own `maxBodyBytes` on purpose: a patch is tiny, so the
 *   settings route keeps a much smaller ceiling unless asked otherwise.
 * @param options.logger - debug sink.
 * @returns an async `(req, res)` handler.
 */
export function createConfigHandler({ snapshot, write, remove, queueSession, ackCommand, trust, maxBodyBytes, logger = () => {} }) {
  const bodyLimit = clampBodyLimit(maxBodyBytes)
  return async function handleConfigRequest(req, res) {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: 'This configuration endpoint is served to the local machine only.' })
        return
      }
      if (typeof trust === 'function' && trust(req) !== true) {
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
      // A JSON content type is not a formality: it keeps the route out of the
      // CORS-simple request class a foreign page could send without a preflight.
      if (!isJsonContentType(req.headers?.['content-type'])) {
        sendJson(res, 415, { error: 'The request body must be sent as application/json.' })
        return
      }
      const raw = await readBody(req, bodyLimit)
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
      if (error?.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { error: `The request body is larger than ${bodyLimit} bytes.` })
        return
      }
      // A setting this deployment refuses to save is an answer the caller can
      // act on (it names the row to add), not an internal failure.
      if (error?.expose === true) {
        sendJson(res, 400, { error: message })
        return
      }
      // Everything else is logged; the caller gets no internal path or stack text.
      sendJson(res, 500, { error: 'The configuration request failed.' })
    }
  }
}
