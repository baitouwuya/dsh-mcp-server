/**
 * DSH MCP Server — a DeepSeek Harness Host plugin that publishes an MCP
 * endpoint on the running Harness, so other agent harnesses can call DSH.
 *
 * The plugin registers one route on `ctx.webServer`, serves the MCP Streamable
 * HTTP transport directly from Node request/response objects, and maps every
 * MCP tool onto live Harness services (`sessionController`, `sessionQuery`,
 * `tools`). It imports no DSH package and no third-party module, so the bundle
 * installs with no dependencies at all.
 *
 * @module @local/dsh-mcp-server
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { createDshCapabilities, DEFAULT_MAX_CONCURRENT_TURNS, DEFAULT_TURN_TIMEOUT_MS, INSTRUCTIONS } from './lib/dsh-capabilities.js'
import { createClientRegistry, DEFAULT_CLIENT_FLUSH_MS, resolveCaller } from './lib/clients.js'
import { createMcpHttpHandler } from './lib/http-route.js'
import { McpGateway, SERVER_NAME } from './lib/protocol.js'

/** Keep in sync with package.json; reported through `initialize`. */
const VERSION = '0.6.1'

/** Cordis: wait for the Web carrier before registering the route. */
export const inject = ['webServer']

/** Stable loader entry name. */
export const name = 'dsh-mcp-server'

/** Resolve the Harness home directory the same way the CLI does. */
function resolveDshHome(config) {
  const fromConfig = typeof config.dshHome === 'string' && config.dshHome ? config.dshHome : undefined
  if (fromConfig) return resolve(fromConfig)
  const fromEnv = process.env.DSH_HOME
  if (fromEnv) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/** Normalize and validate the route path. */
function resolvePath(config) {
  const raw = typeof config.path === 'string' && config.path ? config.path : '/mcp'
  if (!raw.startsWith('/')) throw new Error(`dsh-mcp-server: "path" must start with "/" (got ${raw}).`)
  if (raw.length > 1 && raw.endsWith('/')) throw new Error(`dsh-mcp-server: "path" must not end with "/" (got ${raw}).`)
  return raw
}

/** Read a bearer token from the headers or query string. */
function readPresentedToken(req, url) {
  const header = req.headers?.authorization
  if (typeof header === 'string' && /^bearer /i.test(header)) return header.slice(7).trim()
  const direct = req.headers?.['x-dsh-mcp-token']
  if (typeof direct === 'string' && direct) return direct.trim()
  const query = url?.searchParams?.get('token')
  if (typeof query === 'string' && query) return query.trim()
  return undefined
}

/** Constant-time token comparison that never throws on length mismatch. */
function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || !presented) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Plugin entry point.
 *
 * @param ctx - Cordis context for this plugin fiber.
 * @param config - row configuration from `cordis.patch.yml`; every field is optional.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger?.('dsh-mcp-server') ?? { info() {}, warn() {}, debug() {}, error() {} }
  const log = (level, message, detail) => {
    const sink = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info?.bind(logger)
    if (sink) sink(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`)
  }

  const path = resolvePath(config)
  const dshHome = resolveDshHome(config)
  const endpointFile = typeof config.endpointFile === 'string' && config.endpointFile
    ? resolve(config.endpointFile)
    : join(dshHome, 'mcp', 'dsh-mcp-endpoint.json')
  const writeEndpointFile = config.writeEndpointFile !== false
  const allowConnectionAuth = config.allowConnectionAuth !== false
  const turnTimeoutMs = Number.isFinite(Number(config.turnTimeoutMs)) ? Number(config.turnTimeoutMs) : DEFAULT_TURN_TIMEOUT_MS
  const maxConcurrentTurns = Number.isFinite(Number(config.maxConcurrentTurns))
    ? Math.max(1, Number(config.maxConcurrentTurns))
    : DEFAULT_MAX_CONCURRENT_TURNS
  // Attribution is always on; `restrictToOwner` is the opt-in gate that turns it
  // into isolation between callers that share this endpoint's token.
  const restrictToOwner = config.restrictToOwner === true
  // Answering a request is a permission decision, so this stays off unless the
  // profile asks for it: with it on, the endpoint becomes one of the answerers.
  const answerUserRequests = config.answerUserRequests === true
  const answerOwnedSessionsOnly = config.answerOwnedSessionsOnly !== false
  const requestAnswerTimeoutMs = Number.isFinite(Number(config.requestAnswerTimeoutMs))
    ? Math.max(1000, Number(config.requestAnswerTimeoutMs))
    : undefined
  const clientsFile = typeof config.clientsFile === 'string' && config.clientsFile
    ? resolve(config.clientsFile)
    : join(dshHome, 'mcp', 'dsh-mcp-clients.json')
  const clientsFlushMs = Number.isFinite(Number(config.clientsFlushMs))
    ? Math.max(0, Number(config.clientsFlushMs))
    : DEFAULT_CLIENT_FLUSH_MS

  /** Who called, and which sessions each caller created; survives a restart. */
  const clients = createClientRegistry({ file: clientsFile, logger: log, flushMs: clientsFlushMs })
  clients.load()
  /** Fingerprint -> `initialize` clientInfo, so a name sticks across stateless requests. */
  const clientInfoCache = new Map()
  const identify = ({ headers, message, peer }) => clients.touch(resolveCaller({
    headers,
    clientInfo: message?.method === 'initialize' ? message.params?.clientInfo : undefined,
    peer,
  }, clientInfoCache))

  // A caller-supplied token is authoritative; otherwise mint one per process so
  // the endpoint is never open by accident, and publish it in the endpoint file.
  const configuredToken = typeof config.token === 'string' && config.token ? config.token : undefined
  const token = configuredToken ?? randomBytes(32).toString('base64url')
  const generatedToken = configuredToken === undefined

  /** A host the listener bound to, spelled as a URL authority. */
  const authorityOf = (host, port) => {
    const spelling = typeof host === 'string' && host ? host : '127.0.0.1'
    const wildcard = spelling === '0.0.0.0' || spelling === '::' || spelling === '*'
    const chosen = wildcard ? '127.0.0.1' : spelling
    const bracketed = chosen.includes(':') && !chosen.startsWith('[') ? `[${chosen}]` : chosen
    return `${bracketed}:${port}`
  }

  /**
   * Where this endpoint is reachable.
   *
   * The listener is usually bound after this plugin applies, and its port is often
   * OS-assigned (`port: 0`), so the configured URL and `DSH_WEB_URL` come first and
   * the running `webServer` — its own `protocol`/`host`/`port` — is the authoritative
   * fallback. The static default is only a last resort for embedded hosts.
   */
  const resolveBaseUrl = () => {
    if (typeof config.url === 'string' && config.url) return config.url.replace(/\/$/, '')
    const fromEnv = process.env.DSH_WEB_URL
    if (fromEnv) return fromEnv.replace(/\/$/, '')
    const carrier = ctx.get('webServer')
    const port = Number(carrier?.port)
    if (Number.isFinite(port) && port > 0) {
      const protocol = typeof carrier?.protocol === 'string' && carrier.protocol.endsWith(':')
        ? carrier.protocol
        : 'http:'
      return `${protocol}//${authorityOf(carrier?.host, port)}`
    }
    return 'http://127.0.0.1:19387'
  }
  const endpointUrl = `${resolveBaseUrl()}${path}`

  /** Default model for newly started sessions; a continued session keeps its own model. */
  const defaultModel = (() => {
    if (config.defaultModel && typeof config.defaultModel === 'object') {
      const { provider, model, reasoningEffort } = config.defaultModel
      if (typeof provider === 'string' && typeof model === 'string') {
        return { provider, model, ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}) }
      }
    }
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
    } catch (error) {
      log('debug', 'default model lookup failed', { error: error instanceof Error ? error.message : String(error) })
    }
    return undefined
  })()

  const startedAt = Date.now()
  /** Identity of this activation; a dispose only removes the endpoint file this activation wrote. */
  const instanceId = randomUUID()
  const capabilities = createDshCapabilities(ctx, {
    logger: log,
    sessionOwners: clients,
    restrictToOwner,
    answerUserRequests,
    answerOwnedSessionsOnly,
    ...(requestAnswerTimeoutMs === undefined ? {} : { requestAnswerTimeoutMs }),
    defaultModel,
    defaultCwd: typeof config.defaultCwd === 'string' && config.defaultCwd ? resolve(config.defaultCwd) : undefined,
    turnTimeoutMs,
    maxConcurrentTurns,
    dshVersion: VERSION,
    dshHome,
    endpoint: endpointUrl,
    startedAt,
  })

  const gateway = new McpGateway({
    serverInfo: { name: SERVER_NAME, title: 'DeepSeek Harness MCP Server', version: VERSION },
    instructions: typeof config.instructions === 'string' && config.instructions ? config.instructions : INSTRUCTIONS,
    listTools: () => capabilities.tools,
    callTool: (toolName, args, context) => capabilities.callTool(toolName, args, context),
    listResources: () => capabilities.listResources(),
    listResourceTemplates: () => capabilities.listResourceTemplates(),
    readResource: (uri, context) => capabilities.readResource(uri, context),
    logger: log,
  })

  const connection = ctx.get('connection')

  /** Authorize one inbound request: bearer token first, then Harness connection trust. */
  function authorize(req, url) {
    const presented = readPresentedToken(req, url)
    if (tokensMatch(presented, token)) return { ok: true, peer: 'token' }
    if (allowConnectionAuth && connection) {
      try {
        const rejection = connection.requestRejection({ headers: req.headers })
        if (rejection === undefined) return { ok: true, peer: 'connection' }
      } catch (error) {
        log('debug', 'connection admission failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
    return {
      ok: false,
      status: 401,
      message: generatedToken
        ? 'Unauthorized: send "Authorization: Bearer <token>" using the token in the endpoint file.\n'
        : 'Unauthorized: the bearer token does not match this endpoint.\n',
    }
  }

  const handler = createMcpHttpHandler({
    gateway,
    authorize,
    identify,
    logger: log,
    path,
    maxBodyBytes: Number.isFinite(Number(config.maxBodyBytes)) ? Number(config.maxBodyBytes) : undefined,
  })

  const disposeRoute = ctx.webServer.register({ kind: 'exact', path, handler })

  /** Publish connection details so stdio bridges and humans can find the endpoint. */
  async function publishEndpoint() {
    if (!writeEndpointFile) return
    const url = `${resolveBaseUrl()}${path}`
    const payload = {
      url,
      token,
      path,
      pid: process.pid,
      version: VERSION,
      serverName: SERVER_NAME,
      instanceId,
      startedAt: new Date(startedAt).toISOString(),
      profile: process.env.DSH_PROFILE,
      stdioBridge: join(import.meta.dirname, 'bin', 'dsh-mcp-stdio.mjs'),
      tools: capabilities.tools.map((tool) => tool.name),
      updatedAt: new Date().toISOString(),
    }
    try {
      await mkdir(dirname(endpointFile), { recursive: true, mode: 0o700 })
      await writeFile(endpointFile, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
      log('info', 'endpoint published', { url, endpointFile })
    } catch (error) {
      log('warn', 'could not publish endpoint file', {
        endpointFile,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  void publishEndpoint()

  /**
   * Publish again once the listener has a port.
   *
   * `ctx.webServer.port` is undefined until the listener binds, which happens after
   * this plugin applies — so the first publish can only advertise the configured or
   * default URL. Waiting for `appReady` (the launch signal other web plugins use)
   * turns that into the real address, which is what external harnesses connect to.
   */
  function republishWhenListening() {
    if (!writeEndpointFile) return
    if (Number.isFinite(Number(ctx.get('webServer')?.port))) {
      void publishEndpoint()
      return
    }
    const ready = ctx.get('appReady')
    if (ready && typeof ready.onReady === 'function') {
      ctx.effect(() => {
        let closed = false
        const cancel = ready.onReady(() => { if (!closed) void publishEndpoint() })
        return () => { closed = true; cancel?.() }
      }, 'dsh-mcp-server: republish endpoint once listening')
      return
    }
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (Number.isFinite(Number(ctx.get('webServer')?.port))) {
        clearInterval(timer)
        void publishEndpoint()
      } else if (attempts >= 100) {
        clearInterval(timer)
      }
    }, 100)
    timer.unref?.()
  }

  republishWhenListening()

  /**
   * Remove the published endpoint file, but only while this activation still owns
   * it, and do it synchronously so a hot-reload cannot interleave.
   *
   * On a config hot-reload the reloader may apply the incoming instance before,
   * during, or after the outgoing one disposes. An asynchronous `rm` is multi-step
   * (lstat + unlink) and reliably lands after the newer write, which leaves the
   * endpoint file missing; a synchronous guarded unlink cannot. Comparing
   * `instanceId` also keeps a newer activation's file intact.
   */
  function removeOwnEndpointFile() {
    if (!writeEndpointFile) return
    let owner
    try {
      owner = JSON.parse(readFileSync(endpointFile, 'utf8'))
    } catch {
      return
    }
    if (owner?.instanceId !== instanceId) return
    try {
      rmSync(endpointFile, { force: true })
    } catch (error) {
      log('debug', 'endpoint file removal failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => () => {
    try {
      disposeRoute()
    } catch (error) {
      log('debug', 'route disposal failed', { error: error instanceof Error ? error.message : String(error) })
    }
    removeOwnEndpointFile()
    clients.flush()
    log('info', 'dsh-mcp-server stopped')
  }, 'dsh-mcp-server.dispose')

  log('info', 'listening', {
    endpoint: endpointUrl,
    path,
    auth: configuredToken ? 'configured bearer token' : 'generated bearer token',
    tools: capabilities.tools.length,
    clients: clientsFile,
    restrictToOwner,
    answerUserRequests,
    instance: instanceId,
  })
}