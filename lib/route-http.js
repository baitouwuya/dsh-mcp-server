/**
 * The small HTTP plumbing both of this plugin's local routes share.
 *
 * They were written once for `/mcp-config` and copied for `/mcp-scope`; the copy
 * immediately drifted (a destroyed socket turned a 413 into a reset, and the
 * body ceiling stopped being clamped). One module, two importers, no second
 * chance to drift.
 *
 * @module dsh-mcp-server/route-http
 */

/** The ceiling both routes fall back to when a deployment names none. */
export const DEFAULT_MAX_BODY_BYTES = 4096

/** The range a configured ceiling is clamped into. */
const MIN_MAX_BODY_BYTES = 1024
const MAX_MAX_BODY_BYTES = 1024 * 1024

/** Literal loopback spellings a socket may report. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '::1', 'localhost'])

/** A whole byte count for one body ceiling, never outside the accepted range. */
export function clampBodyLimit(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return DEFAULT_MAX_BODY_BYTES
  return Math.max(MIN_MAX_BODY_BYTES, Math.min(MAX_MAX_BODY_BYTES, Math.trunc(raw)))
}

/** Whether a peer address is this machine. */
export function isLoopback(address) {
  if (typeof address !== 'string' || !address) return false
  if (LOOPBACK_NAMES.has(address)) return true
  return address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** Send one JSON response. */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2) + '\n'
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read a request body, never past the caller's ceiling. */
export function readBody(req, limit) {
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
export function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

/**
 * Run the settings routes' trust rule, letting an operator-named Origin relax
 * only the Origin/Host comparison.
 *
 * The allowlist is a list of *exceptions*, not a requirement: with the default
 * empty list every browser request must still match its own Host. Requiring a
 * hit would refuse every save on a stock deployment, because a page always sends
 * an Origin.
 *
 * @param req - the incoming request.
 * @param trust - `(req) => boolean`, the Host's trust function.
 * @param allowedOrigins - origins the operator named.
 * @returns whether this call is admitted.
 */
export function admittedByTrust(req, trust, allowedOrigins) {
  // A Host that offers no trust function leaves the loopback check as the only
  // gate — exactly what `/mcp-config` did before this helper existed.
  if (typeof trust !== 'function') return true
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : []
  const origin = req.headers?.origin
  const allowlisted = typeof origin === 'string' && origins.includes(origin)
  const trustedRequest = allowlisted && typeof req.headers?.host === 'string'
    ? { ...req, headers: { ...req.headers, origin: `http://${req.headers.host}` } }
    : req
  try {
    return trust(trustedRequest) === true
  } catch {
    return false
  }
}
