#!/usr/bin/env node
/**
 * `dsh-mcp-stdio` — a stdio MCP server that proxies to a running DeepSeek
 * Harness MCP endpoint.
 *
 * Harnesses that only speak MCP over stdio (Claude Code, Cursor, Codex, …) can
 * launch this file as their MCP server command; it forwards every JSON-RPC
 * message to the DSH host over Streamable HTTP and streams the replies back.
 * Both reply forms are accepted: a plain JSON body, and the event-stream the
 * endpoint switches to when a tool (a wait, a whole delegated turn) runs long.
 * It has no dependencies and needs no DSH package.
 *
 * Endpoint discovery, in order:
 *   1. `--url` / `--token` arguments.
 *   2. `DSH_MCP_URL` / `DSH_MCP_TOKEN` environment variables.
 *   3. `${DSH_HOME}/mcp/dsh-mcp-endpoint.json`, written by the plugin.
 *      `DSH_HOME` defaults to `~/.dsh`.
 *
 * It also tells the endpoint which agent it is: `--client <label>`, else
 * `DSH_MCP_CLIENT`, else the process that launched it, else `stdio-bridge`.
 *
 * Usage in another harness' MCP configuration:
 *   { "command": "node", "args": ["<plugin-dir>/bin/dsh-mcp-stdio.mjs"] }
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const STDERR_PREFIX = '[dsh-mcp-stdio] '
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** Parse `--flag value` / `--flag=value` pairs. */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i]
    else out[arg.slice(2)] = 'true'
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const dshHome = args['dsh-home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const endpointFile = args['endpoint-file'] ?? join(dshHome, 'mcp', 'dsh-mcp-endpoint.json')

/**
 * Load `{ url, token }` from arguments, environment, or the plugin's endpoint
 * file.
 *
 * The file is read on every request on purpose: the Harness assigns its
 * listener port at boot, so a bridge that cached the URL at startup goes on
 * dialling the previous instance's port after a restart.
 */
function resolveEndpoint() {
  const fromEnv = process.env.DSH_MCP_URL
  const envToken = process.env.DSH_MCP_TOKEN
  let file
  if (!(fromEnv && envToken)) {
    try {
      file = JSON.parse(readFileSync(endpointFile, 'utf8'))
    } catch {
      file = undefined
    }
  }
  return {
    url: args.url ?? fromEnv ?? file?.url,
    token: args.token ?? envToken ?? file?.token,
  }
}

const log = (...parts) => process.stderr.write(STDERR_PREFIX + parts.join(' ') + '\n')

/** Parents that name a runtime rather than the agent that launched this bridge. */
const RUNTIME_PARENTS = new Set([
  'node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'sh', 'bash', 'zsh', 'env',
  'cmd', 'cmd.exe', 'powershell', 'pwsh',
])

/** Best-effort name of the process that launched this bridge, i.e. the MCP client. */
function parentProcessName() {
  if (process.platform === 'win32') return undefined
  try {
    const out = execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000 })
    const name = out.trim().split('/').pop()
    return name || undefined
  } catch {
    return undefined
  }
}

/** The label this bridge reports to the DSH endpoint, sent as `x-dsh-mcp-client`. */
function resolveClientLabel() {
  const configured = args.client ?? process.env.DSH_MCP_CLIENT
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  const parent = parentProcessName()
  if (parent && !RUNTIME_PARENTS.has(parent.toLowerCase())) return `stdio:${parent}`
  return 'stdio-bridge'
}

const clientLabel = resolveClientLabel()

/** Emit one JSON-RPC message as a single stdout line. */
function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

const inFlight = new Map()
let endpoint = resolveEndpoint()
log(`identifying as "${clientLabel}"`)
let closing = false

/**
 * Read an SSE reply, handing every JSON-RPC message it carries to `onMessage`.
 *
 * The endpoint sends `: keep-alive` comments while a slow tool is still running
 * and closes with a single `event: message` event, so anything that is not a
 * `data:` line is protocol noise here.
 *
 * @param response - the `fetch` response whose body is an event stream.
 * @param onMessage - callback receiving each parsed JSON-RPC message.
 */
async function readEventStream(response, onMessage) {
  if (!response.body) return
  const decoder = new TextDecoder()
  let buffer = ''
  let data = []
  const dispatch = () => {
    if (data.length === 0) return
    const text = data.join('\n')
    data = []
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      log('discarding a non-JSON event-stream message')
      return
    }
    onMessage(payload)
  }
  const handleLine = (line) => {
    if (line === '') return dispatch()
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') data.push(value)
    return undefined
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      handleLine(buffer.slice(0, index).replace(/\r$/, ''))
      buffer = buffer.slice(index + 1)
    }
  }
  buffer += decoder.decode()
  if (buffer) handleLine(buffer.replace(/\r$/, ''))
  dispatch()
}

/** Build the JSON-RPC error used when the DSH endpoint cannot be reached. */
function unreachableError(id, detail) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32000,
      message: `DeepSeek Harness MCP endpoint is unavailable: ${detail}. Start the DSH app (or load the dsh-mcp-server plugin) and retry.`,
    },
  }
}

/**
 * Forward one parsed JSON-RPC message to the DSH MCP endpoint.
 *
 * @param message - parsed JSON-RPC request or notification.
 */
async function forward(message) {
  const id = message?.id
  const isRequest = id !== undefined && id !== null
  // Re-resolve every time: a restarted Harness listens on a new port.
  endpoint = resolveEndpoint()
  if (!endpoint.url) {
    log(`no endpoint; expected ${endpointFile} or DSH_MCP_URL`)
    if (isRequest) writeMessage(unreachableError(id, 'no endpoint is configured'))
    return
  }

  const controller = new AbortController()
  if (isRequest) inFlight.set(String(id), controller)
  const timer = setTimeout(() => controller.abort(), Number(args['timeout-ms'] ?? process.env.DSH_MCP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS))
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
        'x-dsh-mcp-client': clientLabel,
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    })
    if (response.status === 202 || isRequest === false) return
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.includes('text/event-stream')) {
      // The endpoint streams a slow call's reply: keep-alive comments while the
      // tool runs, then the JSON-RPC response as one `message` event.
      await readEventStream(response, (payload) => {
        if (isRequest) writeMessage(payload)
      })
      return
    }
    const text = await response.text()
    if (!response.ok && !text.trim()) {
      if (isRequest) writeMessage(unreachableError(id, `HTTP ${response.status}`))
      return
    }
    const payload = text.trim() ? JSON.parse(text) : undefined
    if (payload !== undefined) writeMessage(payload)
    else if (isRequest) writeMessage(unreachableError(id, `HTTP ${response.status} with an empty body`))
  } catch (error) {
    if (!isRequest) return
    const detail = error?.name === 'AbortError' ? 'the request timed out' : (error?.message ?? String(error))
    writeMessage(unreachableError(id, detail))
  } finally {
    clearTimeout(timer)
    if (isRequest) inFlight.delete(String(id))
  }
}

/** Cancel an in-flight request when the client sends `notifications/cancelled`. */
function handleCancellation(message) {
  const requestId = message?.params?.requestId
  if (requestId === undefined || requestId === null) return false
  const controller = inFlight.get(String(requestId))
  if (!controller) return false
  controller.abort()
  return true
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    log('discarding a non-JSON stdin line')
    return
  }
  if (Array.isArray(message)) {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported.' } })
    return
  }
  if (message?.method === 'notifications/cancelled') {
    handleCancellation(message)
    void forward(message)
    return
  }
  void forward(message)
})

const shutdown = () => {
  if (closing) return
  closing = true
  for (const controller of inFlight.values()) controller.abort()
  process.exit(0)
}
rl.on('close', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)