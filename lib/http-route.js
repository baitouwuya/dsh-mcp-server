/**
 * Node HTTP binding for the MCP Streamable HTTP transport.
 *
 * DSH's `ctx.webServer` hands a route raw Node `IncomingMessage` /
 * `ServerResponse` objects, so this module implements the transport directly:
 * one JSON-RPC message per `POST`, a single `application/json` response (the
 * spec's non-streaming reply form), `405` for the optional `GET`/`DELETE`
 * session channels this server does not use, and `202` for notifications.
 *
 * @module dsh-mcp-server/http-route
 */

import { ERROR_CODES, failure, isJsonRpcMessage, McpError } from './protocol.js'

/** Default request body ceiling: MCP arguments plus prompt text stay far below this. */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * Read and parse a JSON request body.
 *
 * @param req - Node request stream.
 * @param maxBytes - hard ceiling; exceeding it rejects the request.
 * @returns the parsed JSON value.
 */
async function readJsonBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes.`)
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return undefined
  return JSON.parse(text)
}

/** Write a JSON response with the headers this transport relies on. */
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * Build the MCP route handler.
 *
 * @param options - gateway, authorization, and limits.
 * @param options.gateway - the {@link import('./protocol.js').McpGateway} to dispatch into.
 * @param options.authorize - `(req, url) => { ok: true, peer? } | { ok: false, status, message? }`.
 * @param options.identify - `({ headers, message, peer }) => caller`; attribution only, never a gate.
 * @param options.logger - `(level, message, detail?) => void`.
 * @param options.maxBodyBytes - request body ceiling.
 * @param options.path - route path, used only in diagnostics.
 * @returns a Node request handler.
 */
export function createMcpHttpHandler(options) {
  const {
    gateway,
    authorize,
    identify,
    logger = () => {},
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    path = '/mcp',
  } = options

  return async function handleMcpRequest(req, res) {
    const method = (req.method ?? 'GET').toUpperCase()
    const requestUrl = new URL(req.url ?? path, 'http://localhost')

    if (method === 'OPTIONS') {
      res.writeHead(204, { allow: 'POST, OPTIONS' })
      res.end()
      return
    }
    if (method !== 'POST') {
      // This server keeps no per-client state, so it owns no GET event stream
      // and no DELETE session: advertise that precisely instead of hanging.
      res.writeHead(405, { allow: 'POST, OPTIONS', 'content-type': 'text/plain; charset=utf-8' })
      res.end('Method Not Allowed: this MCP endpoint accepts POST only.\n')
      return
    }

    const decision = authorize(req, requestUrl)
    if (!decision.ok) {
      logger('warn', 'rejected request', { status: decision.status, reason: decision.message })
      res.writeHead(decision.status, {
        'content-type': 'text/plain; charset=utf-8',
        ...(decision.status === 401 ? { 'www-authenticate': 'Bearer realm="dsh-mcp"' } : {}),
      })
      res.end(decision.message ?? 'Unauthorized\n')
      return
    }

    let parsed
    try {
      parsed = await readJsonBody(req, maxBodyBytes)
    } catch (error) {
      const tooLarge = error?.code === 'BODY_TOO_LARGE'
      logger('warn', 'bad request body', { error: error instanceof Error ? error.message : String(error) })
      sendJson(res, tooLarge ? 413 : 400, failure(null, new McpError(
        ERROR_CODES.parseError,
        tooLarge ? error.message : 'Request body is not valid JSON.',
      )))
      return
    }

    if (Array.isArray(parsed)) {
      // JSON-RPC batching was removed from MCP; refuse it explicitly.
      sendJson(res, 400, failure(null, new McpError(
        ERROR_CODES.invalidRequest,
        'JSON-RPC batches are not supported by this MCP endpoint.',
      )))
      return
    }
    if (!isJsonRpcMessage(parsed)) {
      sendJson(res, 400, failure(parsed?.id ?? null, new McpError(
        ERROR_CODES.invalidRequest,
        'Expected a JSON-RPC request object.',
      )))
      return
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    req.on('aborted', abort)
    res.on('close', () => {
      if (!res.writableEnded) abort()
    })

    // Attribution, not authorization: `authorize` already admitted this request,
    // and a client may name itself freely. A failure here never fails the call.
    let caller
    if (typeof identify === 'function') {
      try {
        caller = identify({ headers: req.headers, message: parsed, peer: decision.peer })
      } catch (error) {
        logger('debug', 'caller identification failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }

    const context = { signal: controller.signal, peer: decision.peer, path, ...(caller === undefined ? {} : { caller }) }
    const isNotification = parsed.id === undefined || parsed.id === null
    if (isNotification) {
      // Notifications have no reply; dispatch, then acknowledge with 202.
      gateway.handle(parsed, context).catch((error) => {
        logger('warn', 'notification failed', { error: error instanceof Error ? error.message : String(error) })
      }).finally(() => {
        if (!res.writableEnded) {
          res.writeHead(202)
          res.end()
        }
      })
      return
    }

    let response
    try {
      response = await gateway.handle(parsed, context)
    } catch (error) {
      response = failure(parsed.id, error)
    }
    if (!res.writableEnded) {
      sendJson(res, 200, response ?? failure(parsed.id, new McpError(
        ERROR_CODES.internalError,
        'No response was produced.',
      )))
    }
  }
}