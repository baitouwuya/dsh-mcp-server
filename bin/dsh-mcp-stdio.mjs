#!/usr/bin/env node
/**
 * `dsh-mcp-stdio` — a stdio MCP server that proxies to a running DeepSeek
 * Harness MCP endpoint.
 *
 * Harnesses that only speak MCP over stdio (Claude Code, Cursor, Codex, …) can
 * launch this file as their MCP server command; it forwards every JSON-RPC
 * message to the DSH host over Streamable HTTP and streams the replies back.
 * It has no dependencies and needs no DSH package.
 *
 * Endpoint discovery, in order:
 *   1. `--url` / `--token` arguments.
 *   2. `DSH_MCP_URL` / `DSH_MCP_TOKEN` environment variables.
 *   3. `${DSH_HOME}/mcp/dsh-mcp-endpoint.json`, written by the plugin.
 *      `DSH_HOME` defaults to `~/.dsh`.
 *
 * Usage in another harness' MCP configuration:
 *   { "command": "node", "args": ["<plugin-dir>/bin/dsh-mcp-stdio.mjs"] }
 */

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

/** Load `{ url, token }` from arguments, environment, or the plugin's endpoint file. */
function resolveEndpoint() {
  let fileValue
  const readFile = () => {
    if (fileValue !== undefined) return fileValue
    try {
      fileValue = JSON.parse(readFileSync(endpointFile, 'utf8'))
    } catch {
      fileValue = null
    }
    return fileValue
  }
  const fromEnv = process.env.DSH_MCP_URL
  const envToken = process.env.DSH_MCP_TOKEN
  const file = fromEnv && envToken ? undefined : readFile()
  const url = args.url ?? fromEnv ?? file?.url
  const token = args.token ?? envToken ?? file?.token
  return { url, token }
}

const log = (...parts) => process.stderr.write(STDERR_PREFIX + parts.join(' ') + '\n')

/** Emit one JSON-RPC message as a single stdout line. */
function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

const inFlight = new Map()
let endpoint = resolveEndpoint()
let closing = false

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
  if (!endpoint.url || !endpoint.token) {
    endpoint = resolveEndpoint()
  }
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
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    })
    if (response.status === 202 || isRequest === false) return
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