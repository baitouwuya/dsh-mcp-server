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

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { createDshCapabilities, DEFAULT_MAX_CONCURRENT_TURNS, DEFAULT_TURN_TIMEOUT_MS, INSTRUCTIONS } from './lib/dsh-capabilities.js'
import { createClientRegistry, DEFAULT_CLIENT_FLUSH_MS, resolveCaller } from './lib/clients.js'
import { createConfigHandler } from './lib/config-route.js'
import { createMcpHttpHandler } from './lib/http-route.js'
import { McpGateway, SERVER_NAME } from './lib/protocol.js'
import { registerDshTools } from './lib/dsh-tools-bridge.js'
import { createWorkSync } from './lib/work-sync.js'
import { groupOwnedSessions } from './lib/workspace-grouping.js'
import { assistantTextOf } from './lib/dsh-contracts.js'

/** Keep in sync with package.json; reported through `initialize`. */
const VERSION = '0.12.0'

/** This package's own name, as the profile's bundle row spells it. */
const PACKAGE_NAME = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')).name
  } catch {
    return '@local/dsh-mcp-server'
  }
})()

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
function readPresentedToken(req) {
  const header = req.headers?.authorization
  if (typeof header === 'string' && /^bearer /i.test(header)) return header.slice(7).trim()
  const direct = req.headers?.['x-dsh-mcp-token']
  if (typeof direct === 'string' && direct) return direct.trim()
  // No query-string fallback: a token in a URL lands in access logs, proxied
  // request lines, and browser history.
  return undefined
}

/** Constant-time token comparison that never throws on length mismatch. */
function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || !presented) return false
  // Hash both sides first: comparing the digests keeps the comparison
  // constant-time even when the presented token has a different length.
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
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
  const turnTimeoutMs = Number.isFinite(Number(config.turnTimeoutMs))
    ? Math.max(1000, Math.min(24 * 60 * 60 * 1000, Number(config.turnTimeoutMs)))
    : DEFAULT_TURN_TIMEOUT_MS
  const maxConcurrentTurns = Number.isFinite(Number(config.maxConcurrentTurns))
    ? Math.max(1, Math.min(64, Math.trunc(Number(config.maxConcurrentTurns))))
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
  // The local tool surface is on by default: the point of the plugin is that
  // DSH itself can use what it publishes. Turn it off to keep the endpoint
  // MCP-only (the settings page and this row both switch it).
  const exposeToDsh = config.exposeToDsh !== false
  const exposeToDshPage = config.exposeToDshPage !== false
  /**
   * How much of the tool table DSH sees at rest.
   *
   * `lazy` (the default) registers a three-tool front door and lets a session
   * open what it needs; `full` registers all of it up front. A typo fails at
   * load instead of silently changing what every session pays for.
   */
  const exposeToDshMode = (() => {
    const raw = config.exposeToDshMode
    if (raw === undefined || raw === null || raw === '') return 'lazy'
    if (raw === 'lazy' || raw === 'full') return raw
    throw new Error(`dsh-mcp-server: "exposeToDshMode" must be "lazy" or "full" (got ${String(raw)}).`)
  })()
  // Sessions this endpoint starts are attached to their directory's project in
  // the Web sidebar; without that they trail in "Ungrouped" forever.
  const groupSessions = config.groupSessions !== false
  /**
   * Whether this endpoint may invent a sidebar project.
   *
   * Off by default: a Session whose directory has no project is left in
   * "Ungrouped", which is where the Harness would have put it. Turn it on to let
   * the endpoint create one for each directory it runs sessions in.
   */
  const createGroups = config.createGroups === true
  /**
   * Sync a starting task with the other agents working in the same workspace.
   *
   * On by default: two sessions editing one tree is exactly the collision this
   * avoids, and a deployment running one agent at a time pays nothing for it —
   * no running peer in this workspace means no notice is ever sent.
   */
  const syncOnStart = config.syncOnStart !== false
  const syncCooldownMs = Number.isFinite(Number(config.syncCooldownMs))
    ? Math.max(0, Number(config.syncCooldownMs))
    : 300_000
  const syncWaitMs = Number.isFinite(Number(config.syncWaitMs))
    ? Math.max(1000, Number(config.syncWaitMs))
    : 120_000
  const syncMaxPeers = Number.isFinite(Number(config.syncMaxPeers))
    ? Math.max(1, Math.min(20, Number(config.syncMaxPeers)))
    : 3
  /**
   * How a prompt is delivered to a session that is already running.
   *
   * `setting` (the default) follows this deployment's own `ui-conversation.busyEnter`,
   * so "send this session a message" behaves like the user's Enter key; `queue`
   * and `steer` pin one behaviour for every call. A caller's explicit `mode`
   * argument always wins.
   */
  const busyMode = (() => {
    const raw = config.busyMode
    if (raw === undefined || raw === null || raw === '') return 'setting'
    if (raw === 'setting' || raw === 'queue' || raw === 'steer') return raw
    throw new Error(`dsh-mcp-server: "busyMode" must be "setting", "queue", or "steer" (got ${String(raw)}).`)
  })()
  const entryId = typeof config.entryId === 'string' && config.entryId ? config.entryId : name
  const configPath = typeof config.configPath === 'string' && config.configPath
    ? resolvePath({ path: config.configPath })
    : `${path}-config`

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

  /**
   * Default model for newly started sessions; a continued session keeps its own.
   *
   * Resolved per call, never captured: the Harness's selection is volatile (the
   * user can change it, and a catalog change can retire a pair), so a value
   * captured at activation would pin every later session to a stale model.
   */
  const configuredModel = (() => {
    if (config.defaultModel && typeof config.defaultModel === 'object') {
      const { provider, model, reasoningEffort } = config.defaultModel
      if (typeof provider === 'string' && typeof model === 'string') {
        return { provider, model, ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}) }
      }
    }
    return undefined
  })()
  function resolveDefaultModel() {
    if (configuredModel) return configuredModel
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
        }
      }
    } catch (error) {
      log('debug', 'default model lookup failed', { error: error instanceof Error ? error.message : String(error) })
    }
    return undefined
  }

  const startedAt = Date.now()
  /** Identity of this activation; a dispose only removes the endpoint file this activation wrote. */
  const instanceId = randomUUID()
  /** What the DSH-facing tool surface looks like right now, for `dsh_status` and the settings page. */
  const dshToolsState = { names: [], published: [], via: undefined }
  const dshTools = () => ({
    enabled: exposeToDsh,
    mode: exposeToDshMode,
    registered: dshToolsState.names,
    published: dshToolsState.published.length,
    ...(dshToolsState.via ? { via: dshToolsState.via } : {}),
  })

  /** Live work-sync state; the engine replaces this once it is built below. */
  let workSyncStatus = () => ({ enabled: syncOnStart })

  const capabilities = createDshCapabilities(ctx, {
    logger: log,
    sessionOwners: clients,
    restrictToOwner,
    answerUserRequests,
    answerOwnedSessionsOnly,
    ...(requestAnswerTimeoutMs === undefined ? {} : { requestAnswerTimeoutMs }),
    defaultModel: resolveDefaultModel,
    defaultCwd: typeof config.defaultCwd === 'string' && config.defaultCwd ? resolve(config.defaultCwd) : undefined,
    turnTimeoutMs,
    maxConcurrentTurns,
    dshVersion: VERSION,
    dshHome,
    endpoint: endpointUrl,
    startedAt,
    dshTools,
    clientPage: clientPageState,
    groupSessions,
    createGroups,
    busyMode,
    openSession: queueOpenSession,
    syncStatus: () => workSyncStatus(),
  })

  dshToolsState.published = capabilities.tools.map((tool) => tool.name)

  // Register the DSH-facing surface, so a DSH agent calls these directly; an
  // internal caller is clamped to its own authority by `lib/dsh-capabilities.js`,
  // never the endpoint's or the deployment's.
  if (exposeToDsh) {
    const registered = registerDshTools({ ctx, capabilities, logger: log, mode: exposeToDshMode })
    dshToolsState.names = registered.names
    dshToolsState.via = registered.via
  }

  /**
   * The session rows work-sync reasons about: who is running, in which
   * workspace, and under which top-level agent.
   */
  async function syncSessionRows() {
    const controller = ctx.get('sessionController')
    if (typeof controller?.list !== 'function') return []
    const listed = await controller.list({})
    const items = Array.isArray(listed?.items) ? listed.items : []
    return items.map((item) => ({
      sessionId: item.sessionId,
      running: item.running === true,
      ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
      ...(Number.isFinite(Number(item.updatedAt)) ? { updatedAt: Number(item.updatedAt) } : {}),
      ...(typeof item.parentSessionId === 'string' ? { parentSessionId: item.parentSessionId } : {}),
      ...(typeof item.origin === 'string' ? { origin: item.origin } : {}),
    }))
  }

  /**
   * Ask the other top-level agents in this workspace what they are touching,
   * without ever waiting for the answer.
   */
  const workSync = createWorkSync({
    ctx,
    settings: { enabled: syncOnStart, cooldownMs: syncCooldownMs, waitMs: syncWaitMs, maxPeers: syncMaxPeers },
    logger: log,
    listSessions: syncSessionRows,
    deliver: (sessionId, message) => capabilities.deliverInternalMessage(sessionId, message?.text, message?.meta),
    readAssistant: assistantTextOf,
    now: () => Date.now(),
  })
  workSyncStatus = () => workSync.status()
  ctx.effect(() => {
    workSync.start()
    return () => workSync.dispose()
  }, 'dsh-mcp-server: task-start work sync')

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
    const presented = readPresentedToken(req)
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

  /**
   * Admit one configuration-page request.
   *
   * The route is loopback-only, but loopback includes the user's browser: a
   * foreign page could otherwise POST settings (a CORS-simple `text/plain`
   * request) or read them through DNS rebinding. Browser-shaped requests go
   * through the Harness's own Host/Origin fence; a local tool without Origin is
   * admitted because it already needs the loopback socket.
   */
  function configTrust(req) {
    const origin = req.headers?.origin
    const site = req.headers?.['sec-fetch-site']
    const browserRequest = typeof origin === 'string' || typeof site === 'string'
    if (!browserRequest) return true
    if (site === 'cross-site') return false
    if (connection) {
      try {
        return connection.requestRejection({ headers: req.headers }) === undefined
      } catch (error) {
        log('debug', 'configuration admission failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (typeof origin === 'string' && typeof req.headers?.host === 'string') {
      try {
        return new URL(origin).host === req.headers.host
      } catch {
        return false
      }
    }
    return false
  }

  const handler = createMcpHttpHandler({
    gateway,
    authorize,
    identify,
    logger: log,
    path,
    maxBodyBytes: Number.isFinite(Number(config.maxBodyBytes))
      ? Math.max(1024, Math.min(64 * 1024 * 1024, Number(config.maxBodyBytes)))
      : undefined,
  })

  // The settings route has its own, much smaller ceiling: its payload is a
  // switch patch, not a tool call. `configMaxBodyBytes` is clamped by the route
  // itself (1 KB - 1 MB, 4 KB by default), so a malformed value cannot widen it.
  const configMaxBodyBytes = config.configMaxBodyBytes

  const disposeRoute = ctx.webServer.register({ kind: 'exact', path, handler })

  /**
   * Whether the Web client half is being served for this package.
   *
   * The browser module graph is composed at boot, so a bundle that adds or
   * changes its client half gets its Plugins-page configuration only after a
   * restart; reporting the real state keeps a missing page diagnosable.
   */
  function clientPageState() {
    const modules = ctx.get('clientModules')
    if (typeof modules?.clientPath !== 'function') return { available: false }
    let bundle
    try {
      bundle = modules.clientPath(PACKAGE_NAME)
    } catch {
      bundle = undefined
    }
    let inGraph = false
    try {
      const graph = modules.graph?.()
      inGraph = Array.isArray(graph?.entries) && graph.entries.some((row) => row?.id === PACKAGE_NAME)
    } catch {
      inGraph = false
    }
    return { available: true, inGraph, ...(bundle ? { bundle } : {}) }
  }

  /** What this plugin's own configuration page reads. */
  function configSnapshot() {
    return {
      package: PACKAGE_NAME,
      version: VERSION,
      entryId,
      exposeToDsh,
      exposeToDshMode,
      mcpPath: path,
      configPath,
      published: dshToolsState.published,
      registered: dshToolsState.names,
      groupSessions,
      createGroups,
      busyMode,
      syncOnStart,
      syncCooldownMs,
      syncWaitMs,
      syncMaxPeers,
      sync: (() => {
        try {
          return workSyncStatus()
        } catch {
          return { enabled: syncOnStart }
        }
      })(),
      url: `${resolveBaseUrl()}${path}`,
      clientPage: clientPageState(),
      // What "follow the setting" currently resolves to, so the page can show it.
      busyEffective: (() => {
        try {
          return capabilities.effectiveDeliveryMode() ?? busyMode
        } catch {
          return busyMode
        }
      })(),
      command: currentGuiCommand() ?? null,
    }
  }

  /**
   * How long a queued GUI command stays deliverable.
   *
   * A page polls this endpoint, so a command normally lands within a couple of
   * seconds; an old one would surprise whoever opened the GUI later.
   */
  const guiCommandTtlMs = 60_000

  /**
   * The one pending request for the open Web page, or `undefined`.
   *
   * DSH forwards only an allowlisted set of Host events to the browser, and that
   * list is fixed at DSH build time, so a plugin's own notification cannot ride
   * it. The page polls this endpoint instead — the same loopback route the
   * configuration page uses — which needs no DSH change and no websocket.
   */
  let guiCommand

  /** The pending command, while it is still fresh. */
  function currentGuiCommand() {
    if (!guiCommand) return undefined
    if (Date.now() - guiCommand.at > guiCommandTtlMs) {
      guiCommand = undefined
      return undefined
    }
    return { kind: guiCommand.kind, sessionId: guiCommand.sessionId, at: guiCommand.at }
  }

  /** Ask the open page to open one session. */
  async function queueOpenSession(sessionId) {
    guiCommand = { kind: 'open-session', sessionId, at: Date.now() }
    log('debug', 'queued a GUI command', { sessionId })
    return true
  }

  /** Remove project registrations this endpoint should not have made.
   *
   * A deliberate maintenance action, never something the plugin does on its own:
   * removing a registration deletes no folder, file, or Session — those Sessions
   * simply return to "Ungrouped".
   */
  async function removeDshGroups(paths) {
    const registry = ctx.get('workspaceRegistry')
    if (typeof registry?.resolveByPath !== 'function' || typeof registry?.delete !== 'function') {
      throw new Error('This Harness exposes no workspace registry, so a project registration cannot be removed here.')
    }
    const removed = []
    const missing = []
    for (const path of paths) {
      let workspace
      try {
        workspace = await registry.resolveByPath(path)
      } catch {
        // A path that does not exist is a missing registration, not a failure:
        // report it and keep removing the rest.
        missing.push(path)
        continue
      }
      if (!workspace) {
        missing.push(path)
        continue
      }
      await registry.delete(workspace.id)
      removed.push({ id: workspace.id, path: workspace.path, title: workspace.title })
    }
    log('info', 'removed project registrations', { removed: removed.map((entry) => entry.path), missing })
    return { removed, missing }
  }

  /**
   * Save one validated patch through the Harness configuration editor, so the
   * profile's `cordis.patch.yml` stays the one source of truth and the row
   * reloads exactly as a hand edit would.
   */
  async function writeDshSurface(patch) {
    const editor = ctx.get('configEditor')
    if (typeof editor?.entries !== 'function' || typeof editor.edit !== 'function') {
      throw new Error('This Harness exposes no profile configuration editor, so this setting cannot be saved here. Set it on the dsh-mcp-server row in cordis.patch.yml and restart DSH.')
    }
    const rows = [...(editor.entries() ?? [])]
    const entry = rows.find((row) => row?.options?.name === PACKAGE_NAME)
      ?? rows.find((row) => row?.options?.id === entryId)
      ?? rows.find((row) => row?.options?.id === name)
    if (!entry) {
      const seen = rows.map((row) => row?.options?.id).filter(Boolean).join(', ')
      throw new Error(`The "${entryId}" row is not addressable in this profile's patch (saw: ${seen || 'no rows'}), so the switch cannot be saved here. Edit cordis.patch.yml directly.`)
    }
    await editor.edit(entry, (current) => ({ ...(current && typeof current === 'object' ? current : {}), ...patch }))
    return patch
  }

  const disposeConfigRoute = exposeToDshPage
    ? ctx.webServer.register({
      kind: 'exact',
      path: configPath,
      handler: createConfigHandler({
        snapshot: configSnapshot,
        write: writeDshSurface,
        remove: removeDshGroups,
        queueSession: queueOpenSession,
        ackCommand: async () => { guiCommand = undefined },
        trust: configTrust,
        maxBodyBytes: configMaxBodyBytes,
        logger: log,
      }),
    })
    : undefined

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
      // `mode` only applies when the file is created; tighten a pre-existing one.
      await chmod(endpointFile, 0o600).catch(() => {})
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
   * Repair the sessions an earlier build left in "Ungrouped".
   *
   * The sidebar groups by recorded project membership, so a session created
   * before this build was fixed would stay ungrouped forever; one pass over the
   * sessions this endpoint itself attributed to a caller puts them where they
   * belong. It runs once, after the app is ready, and can never fail the plugin.
   */
  function repairGrouping() {
    if (!groupSessions) return
    const run = () => {
      void groupOwnedSessions(ctx, clients, { create: createGroups, logger: log })
        .then((result) => {
          if (result && (result.attached > 0 || result.created > 0)) {
            log('info', 'regrouped sessions this endpoint had created', result)
          }
        })
        .catch((error) => {
          log('debug', 'grouping repair failed', { error: error instanceof Error ? error.message : String(error) })
        })
    }
    // Deliberately a timer, not the launch signal: the repair is a background
    // migration and must not compete with the readiness work the listener needs.
    const timer = setTimeout(run, 5000)
    timer.unref?.()
  }

  repairGrouping()

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
    try {
      disposeConfigRoute?.()
    } catch (error) {
      log('debug', 'configuration route disposal failed', { error: error instanceof Error ? error.message : String(error) })
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
    exposeToDsh,
    exposeToDshMode,
    groupSessions,
    createGroups,
    busyMode,
    dshTools: dshToolsState.names.length,
    clientPage: clientPageState(),
    configPath: exposeToDshPage ? configPath : undefined,
    clients: clientsFile,
    restrictToOwner,
    answerUserRequests,
    instance: instanceId,
  })
}