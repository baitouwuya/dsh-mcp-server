/**
 * Node HTTP binding for the MCP Streamable HTTP transport.
 *
 * DSH's `ctx.webServer` hands a route raw Node `IncomingMessage` /
 * `ServerResponse` objects, so this module implements the transport directly:
 * one JSON-RPC message per `POST`, `405` for the optional `GET`/`DELETE`
 * session channels this server does not use, and `202` for notifications.
 *
 * A reply normally goes out as one `application/json` body. That form has a
 * failure mode for the tools that block: while `dsh_wait_session` — or a
 * `dsh_run_prompt` waiting for its turn — is running, nothing is written: no
 * status line, no headers, no bytes, until the tool finishes. Clients built on
 * undici (Node's `fetch`, hence the stdio bridge, Claude Code, Codex, and the
 * official SDK's default dispatcher) abandon a request whose response headers
 * have not arrived within `headersTimeout`, 300 s by default, and surface it as
 * `fetch failed`. A wait longer than that ceiling then reads as a dropped
 * connection, while `dsh_read_session` — answering in milliseconds — keeps
 * working.
 *
 * So a caller that advertises `text/event-stream` gets the specification's
 * other reply form once the call turns out to be slow: status line and headers
 * immediately, an SSE comment as a keep-alive every few seconds, and the
 * JSON-RPC response as the closing `message` event. Fast calls keep the plain
 * JSON body byte for byte, and a client that only sent `Accept:
 * application/json` never sees a stream at all.
 *
 * @module dsh-mcp-server/http-route
 */

import { ERROR_CODES, failure, isJsonRpcMessage, McpError } from './protocol.js'

/** Default request body ceiling: MCP arguments plus prompt text stay far below this. */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024

/** How long one call may take before its reply switches from a JSON body to SSE. */
export const DEFAULT_STREAM_AFTER_MS = 10_000

/** Interval between SSE keep-alive comments once a reply is streaming. */
export const DEFAULT_KEEPALIVE_MS = 15_000

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

/** True when the client accepts an event-streamed reply: the spec's streaming form. */
function acceptsEventStream(req) {
  return String(req.headers.accept ?? '').toLowerCase().includes('text/event-stream')
}

/** Close a streaming reply with the JSON-RPC response as its one `message` event. */
function sendStreamMessage(res, payload) {
  // JSON.stringify never emits a raw newline, so one `data:` line is the whole event.
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
  res.end()
}

/** Describe any value for diagnostics without assuming it is an Error. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
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
 * @param options.streamAfterMs - how long a call may take before its reply switches to SSE.
 * @param options.keepAliveMs - interval between SSE keep-alive comments while a reply streams.
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
    streamAfterMs = DEFAULT_STREAM_AFTER_MS,
    keepAliveMs = DEFAULT_KEEPALIVE_MS,
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
      logger('warn', 'bad request body', { error: errorText(error) })
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
    // A caller that hangs up mid-reply is a disconnect, not a server fault.
    res.on('error', (error) => logger('debug', 'response stream error', { error: errorText(error) }))

    // Attribution, not authorization: `authorize` already admitted this request,
    // and a client may name itself freely. A failure here never fails the call.
    let caller
    if (typeof identify === 'function') {
      try {
        caller = identify({ headers: req.headers, message: parsed, peer: decision.peer })
      } catch (error) {
        logger('debug', 'caller identification failed', { error: errorText(error) })
      }
    }

    const context = { signal: controller.signal, peer: decision.peer, path, ...(caller === undefined ? {} : { caller }) }
    const isNotification = parsed.id === undefined || parsed.id === null
    if (isNotification) {
      // Notifications have no reply; dispatch, then acknowledge with 202.
      gateway.handle(parsed, context).catch((error) => {
        logger('warn', 'notification failed', { error: errorText(error) })
      }).finally(() => {
        if (!res.writableEnded) {
          res.writeHead(202)
          res.end()
        }
      })
      return
    }

    // A slow call becomes a stream the moment it outlives `streamAfterMs`, so
    // headers and keep-alives reach the client while the tool is still working.
    let streaming = false
    let keepAlive
    const stopKeepAlive = () => {
      if (keepAlive === undefined) return
      clearInterval(keepAlive)
      keepAlive = undefined
    }
    const openStream = () => {
      if (streaming || res.writableEnded || res.destroyed) return
      streaming = true
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      // Send something now: from here the connection is never idle for longer
      // than `keepAliveMs`, so a headers or body timeout cannot fire mid-wait.
      res.write(': open\n\n')
      keepAlive = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          stopKeepAlive()
          return
        }
        res.write(': keep-alive\n\n')
      }, keepAliveMs)
      keepAlive.unref?.()
      logger('debug', 'reply switched to an event stream', { method: parsed.method, afterMs: streamAfterMs })
    }
    const slowTimer = acceptsEventStream(req) ? setTimeout(openStream, streamAfterMs) : undefined
    slowTimer?.unref?.()

    let response
    try {
      response = await gateway.handle(parsed, context)
    } catch (error) {
      response = failure(parsed.id, error)
    }
    if (slowTimer !== undefined) clearTimeout(slowTimer)
    stopKeepAlive()

    const payload = response ?? failure(parsed.id, new McpError(
      ERROR_CODES.internalError,
      'No response was produced.',
    ))
    if (streaming) {
      if (!res.writableEnded && !res.destroyed) {
        try {
          sendStreamMessage(res, payload)
        } catch (error) {
          logger('debug', 'stream close failed', { error: errorText(error) })
        }
      }
      return
    }
    if (!res.writableEnded) sendJson(res, 200, payload)
  }
}
