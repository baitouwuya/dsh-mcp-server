/**
 * The DSH-facing half of the MCP server: every MCP tool and resource maps onto
 * live DeepSeek Harness services (`sessionController`, `sessionQuery`,
 * `tools`, …) reached through the plugin's Cordis context.
 *
 * Nothing here imports a DSH package: services are looked up by name at call
 * time with `ctx.get(...)`, so the bundle stays installable with zero
 * dependencies and survives a Harness upgrade that keeps the service contract.
 *
 * @module dsh-mcp-server/dsh-capabilities
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import { SANDBOX_MODES, clampInternalCwd, isInsideWorkspace, sandboxRank } from './authority.js'
import { errorText, messageOfEvent, turnOfEvent } from './dsh-contracts.js'
import { busyEnterSetting, createAgentHandleResolver, createUserMessage, internalMessageSource } from './dsh-delivery.js'
import { DEFAULT_MESSAGE_CHARS, DEFAULT_TRANSCRIPT_WINDOW, MAX_READ_LIMIT, MAX_ZERO_LIMIT, createTranscriptReader } from './transcript.js'
import { ERROR_CODES, McpError } from './protocol.js'
import { groupSession } from './workspace-grouping.js'
import { TOOL_DEFINITIONS, listResourceTemplates, listResources } from './capabilities/definitions.js'
import { DEFAULT_REQUEST_ANSWER_TIMEOUT_MS, REQUEST_REASON_CHARS, createRequestHelpers, foldUserRequests, pendingSummary } from './capabilities/requests.js'

/** Text handed to the calling model on `initialize`. */
export const INSTRUCTIONS = [
  'This server is a DeepSeek Harness (DSH) deployment. Its tools start and drive real DSH agent sessions',
  'on the machine that runs the Harness: each session works in a directory with the full DSH tool set',
  '(files, shell, web, subagents, skills), its own model selection, and the user’s approval policy.',
  '',
  'Use `dsh_run_prompt` for one-shot work and hand it an absolute `cwd`; it returns the final assistant',
  'text plus a `sessionId`. Use `dsh_continue_session` with that id for follow-up turns, so context is',
  'kept. Both wait for the turn by default; for a long task start with `wait: false` and then call',
  '`dsh_wait_session`, which blocks until the running turn ends and never cancels it — reaching its',
  '`timeoutMs` returns `status: "timedOut"` with the turn still running, so wait again instead of',
  'polling `dsh_read_session`. Waiting never cancels: only `dsh_cancel_session` stops a turn.',
  'Use `dsh_list_sessions`/`dsh_read_session` to inspect work already happening in the Harness.',
  'A session can stop making progress while it waits on a user decision — an approval request (the',
  'one-shot permission decision behind a sandbox escalation) or an `ask_user_question` call. Those are',
  'audit events the model never sees, so `dsh_list_requests` reports them per session (or across the',
  'newest running sessions), and `dsh_read_session`/`dsh_wait_session` results carry a `pending` summary.',
  'Rows marked `answerable` are parked by this endpoint when the deployment enables `answerUserRequests`:',
  'settle them with `dsh_answer_request` (`decision: "allow"|"deny"` for an approval, `answers:` ',
  '[{ id, selected }] for a question). Everything else is decided in the Harness GUI.',
  'Read narrowly rather than broadly: `dsh_list_sessions` takes `query`/`mine`/`running` and pages with',
  '`cursor` (its `view: "index"` row is just id, title, running, archived, time, owner); `dsh_read_session`',
  'takes `mode` ("tail" default, "head", or "outline" for a compact table of contents), `roles`,',
  '`afterSeq` to page forward, and `maxChars` (default 2000, 0 = full) — and reports totalMessages,',
  'matchedMessages and returned so you know what you have not read; `dsh_search_sessions` finds a',
  'session by title/cwd/owner or by message text and returns snippets, bounded by `scan`;',
  '`dsh_list_tools` takes `query`. Prefer these narrow calls over fetching everything and filtering.',
  'Every session created through `dsh_run_prompt` is recorded against the calling agent: `dsh_whoami`',
  'identifies you and lists what you own, and `dsh_list_sessions` accepts `mine: true`. The label comes',
  'from the `x-dsh-mcp-client` header, else `initialize` `clientInfo`, else `User-Agent`; it is',
  'attribution, not authentication, because every caller presents this endpoint\'s token.',
  'Archive conversations with `dsh_archive_session` and restore them with `dsh_unarchive_session`;',
  'archived sessions are hidden from `dsh_list_sessions` unless you pass `includeArchived: true`, and',
  'they cannot run a turn until they are restored.',
  'Point the person at a session with `dsh_open_session`: it asks the Harness GUI page that is open to',
  'open that session and select it in the sidebar, changing nothing about the session itself.',
  'Set a session\'s sandbox/approval permission preset with the `permissionPreset` argument on',
  '`dsh_run_prompt`/`dsh_continue_session`; list the available presets with',
  '`dsh_list_permission_presets`. A session created without one keeps the deployment default.',
  'Run a slash command in a session with `dsh_run_command` (for example `/compact` to compact history,',
  'or `/permission danger-full-access`) and see what that session can run with `dsh_list_commands`;',
  'a command executes immediately without a model turn, and availability is per agent preset, so list first.',
  'Ask one session a question it must answer with `dsh_ask_session`: the question gets an id, the',
  'call does not return before the answer, so the asking turn cannot end first, and the reminder',
  '(id only, never the question again) is injected into the calls the target already makes — it never',
  'opens a turn, and a session stopped by a person is not woken. The addressed session reads the',
  'question again with `dsh_get_question` and settles it with `dsh_answer_question`.',
].join('\n')

/** Default per-turn ceiling for a tool call that waits for completion. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000

/** Sessions this MCP endpoint will start concurrently when waiting is requested. */
export const DEFAULT_MAX_CONCURRENT_TURNS = 8

/** How many listed sessions are probed for a title match before titles are given up on. */
const TITLE_QUERY_CANDIDATES = 200

/** How many visible sessions one search is willing to look at. */
const SEARCH_SESSION_WINDOW = 200

/** How many sessions one `dsh_list_requests` scan inspects by default. */
const DEFAULT_REQUEST_SCAN = 20

/** Prompt identity prefix, kept distinct from Harness browser-minted ids. */
const REQUEST_ID_PREFIX = 'mcp'

/** The Host's own slash-command shape: `/name` followed by whitespace or end. */
const COMMAND_LINE_PATTERN = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u

/** Look up a required Host service, failing with a model-readable diagnostic. */
function requireService(ctx, name) {
  const service = ctx.get(name)
  if (!service) {
    throw new McpError(
      ERROR_CODES.internalError,
      `The DeepSeek Harness service "${name}" is unavailable in this deployment, so this tool cannot run.`,
    )
  }
  return service
}

/** Validate an absolute, existing directory argument. */
function normalizeCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === '') return undefined
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new McpError(ERROR_CODES.invalidParams, '"cwd" must be an absolute directory path.')
  }
  const absolute = resolvePath(cwd)
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    throw new McpError(ERROR_CODES.invalidParams, `"cwd" does not exist or is not readable: ${absolute}`)
  }
  if (!stats.isDirectory()) throw new McpError(ERROR_CODES.invalidParams, `"cwd" is not a directory: ${absolute}`)
  return absolute
}

/** Coerce a numeric argument with bounds. */
function numberArg(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * Build the MCP capability set backed by a live Harness context.
 *
 * @param ctx - Cordis context of the plugin fiber.
 * @param options - resolved plugin configuration.
 * @returns tool definitions, resource providers, and a status reader.
 */
export function createDshCapabilities(ctx, options) {
  const {
    logger = () => {},
    sessionOwners = undefined,
    restrictToOwner = false,
    answerUserRequests = false,
    requestAnswerTimeoutMs = DEFAULT_REQUEST_ANSWER_TIMEOUT_MS,
    answerOwnedSessionsOnly = true,
    defaultModel = undefined,
    maxConcurrentTurns = DEFAULT_MAX_CONCURRENT_TURNS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    defaultCwd = undefined,
    dshTools = undefined,
    clientPage = undefined,
    openSession = undefined,
    questions = undefined,
    sessionStopped = undefined,
    groupSessions = true,
    createGroups = false,
    busyMode = 'setting',
    configPreset = undefined,
  } = options

  let activeTurns = 0

  /** Resolve one session's live Agent so a labelled message can be queued on it. */
  const resolveAgentHandle = createAgentHandleResolver({ ctx, logger })

  /**
   * Progressive transcript reads. The windowing arithmetic lives in
   * `lib/transcript.js`; this module supplies what only it knows — the pending
   * decisions folded into a read and the owner recorded for a session.
   */
  const { sessionMessages, readTranscript } = createTranscriptReader({
    ctx,
    pendingOf: (events) => pendingSummary(foldUserRequests(events)),
    ownerOf: ownerSummary,
  })

  /** Caller-facing identity summary, as reported by `dsh_whoami` and `dsh_status`. */
  function describeCaller(caller) {
    if (!caller?.id) return { id: 'unknown', name: 'unknown', source: 'none' }
    return {
      id: caller.id,
      name: caller.name,
      ...(caller.version ? { version: caller.version } : {}),
      ...(caller.source ? { source: caller.source } : {}),
      ...(caller.firstSeenAt ? { firstSeenAt: new Date(caller.firstSeenAt).toISOString() } : {}),
      ...(caller.lastSeenAt ? { lastSeenAt: new Date(caller.lastSeenAt).toISOString() } : {}),
      ...(Number.isFinite(caller.requests) ? { requests: caller.requests } : {}),
    }
  }

  /** Ownership row for one session, or `undefined` when nobody is recorded. */
  function ownerSummary(sessionId) {
    const owner = sessionOwners?.ownerOf(sessionId)
    if (!owner) return undefined
    return {
      id: owner.ownerId,
      name: owner.ownerName,
      ...(owner.ownerVersion ? { version: owner.ownerVersion } : {}),
      ...(owner.createdAt ? { since: new Date(owner.createdAt).toISOString() } : {}),
      ...(owner.adopted ? { adopted: true } : {}),
    }
  }

  /**
   * Refuse a session the calling agent does not own, when this endpoint is scoped.
   *
   * Off by default: several agents may deliberately share one endpoint\'s sessions.
   * With `restrictToOwner` on, attribution becomes isolation, and a caller can only
   * touch what it created (or adopted).
   */
  function assertCallerMay(sessionId, caller) {
    if (!restrictToOwner || !sessionOwners) return
    const owner = sessionOwners.ownerOf(sessionId)
    if (!owner) return
    if (owner.ownerId === (caller?.id ?? 'unknown')) return
    throw new McpError(
      ERROR_CODES.invalidParams,
      `Session "${sessionId}" belongs to client "${owner.ownerName ?? owner.ownerId}"; this endpoint sets restrictToOwner, so only that caller can use it.`,
    )
  }

  /**
   * Apply the endpoint's owner scope to a listing filter.
   *
   * `owner` narrows a shared endpoint; it must never widen a restricted one.
   */
  function scopedOwnerFilter(args, caller) {
    const requested = typeof args?.owner === 'string' && args.owner.trim() ? args.owner.trim() : undefined
    if (restrictToOwner) {
      const own = caller?.id
      if (requested && requested !== own) {
        throw new McpError(
          ERROR_CODES.invalidParams,
          '"owner" cannot select another client while this endpoint sets restrictToOwner; it only exposes the calling client\'s sessions.',
        )
      }
      return { mine: true, ownerId: undefined }
    }
    return { mine: args?.mine === true, ownerId: requested }
  }

  /** The sandbox mode one session runs under right now, or `undefined`. */
  function sessionSandboxMode(session) {
    const policy = ctx.get('sandboxPolicy')
    if (typeof policy?.resolve !== 'function') return undefined
    try {
      return policy.resolve(session === undefined ? {} : { session })?.mode
    } catch (error) {
      logger('debug', 'sandbox policy lookup failed', { error: errorText(error) })
      return undefined
    }
  }

  /**
   * The file policy a DSH caller holds right now, and the preset it came from.
   *
   * Read live from the Host rather than remembered, so a session that switched
   * mode in the GUI is clamped against what it holds at call time.
   *
   * @param agent - the calling DSH agent, from a tool execution context.
   */
  function authorityOf(agent) {
    const session = agent?.session
    let preset
    try {
      preset = ctx.get('permissionPresets')?.current?.(session)
    } catch (error) {
      logger('debug', 'permission preset lookup failed', { error: errorText(error) })
    }
    const mode = sessionSandboxMode(session)
    const workspaceRoot = typeof session?.header?.cwd === 'string' && session.header.cwd ? session.header.cwd : undefined
    return {
      internal: true,
      ...(session?.header?.id ? { sessionId: session.header.id } : {}),
      ...(agent?.id ? { agentId: agent.id } : {}),
      mode,
      rank: sandboxRank(mode),
      ...(typeof preset === 'string' && preset ? { preset } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
    }
  }

  /**
   * Refuse to drive a session that runs wider than the internal caller's grant.
   *
   * The permission preset the caller grants is clamped elsewhere; this is the
   * other direction: the session being driven already exists, and driving it
   * would execute at its policy rather than the caller's.
   */
  function assertTargetWithinAuthority(authority, session) {
    if (!authority?.internal || !session) return
    const mode = sessionSandboxMode(session)
    const rank = sandboxRank(mode)
    if (rank !== undefined && authority.rank !== undefined && rank > authority.rank) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        `This DSH caller runs at "${authority.mode ?? 'unknown'}" but the target session runs at "${mode}"; an internal caller may drive only a session at or below its own authority.`,
      )
    }
    if (mode !== 'read-only' && authority.workspaceRoot) {
      const targetCwd = session?.header?.cwd
      if (typeof targetCwd === 'string' && targetCwd && !isInsideWorkspace(authority.workspaceRoot, targetCwd)) {
        throw new McpError(
          ERROR_CODES.invalidParams,
          `The target session works in "${targetCwd}", outside this caller's workspace (${authority.workspaceRoot}); an internal caller may drive a writable session only inside its own workspace.`,
        )
      }
    }
  }

  /**
   * The default model for a new session, read at call time.
   *
   * The option may be a getter: the Harness's selection is volatile (the user
   * can change it, and a catalog change can retire the old pair), so capturing
   * it once at activation would pin every later session to a stale model.
   */
  function resolveDefaultSelection() {
    if (typeof defaultModel === 'function') {
      try {
        return defaultModel()
      } catch (error) {
        logger('debug', 'default model lookup failed', { error: errorText(error) })
        return undefined
      }
    }
    return defaultModel
  }

  /** The sandbox one preset would grant, or `undefined` when this Host cannot say. */
  function presetSandbox(name) {
    if (typeof name !== 'string' || !name) return undefined
    try {
      const spec = ctx.get('permissionPresets')?.resolve?.(name)
      if (typeof spec?.sandbox === 'string') return spec.sandbox
    } catch {
      // An unknown preset name lands here; the catalog below may still explain it.
    }
    const option = (readPermissionCatalog()?.options ?? [])
      .find((entry) => entry?.value === name || entry?.name === name)
    return typeof option?.sandbox === 'string' ? option.sandbox : undefined
  }

  /**
   * Refuse a permission preset wider than the calling DSH agent's own policy.
   *
   * @param authority - the caller's live authority, from {@link authorityOf}.
   * @param name - the preset this call is trying to grant.
   * @returns the preset name, when it is at or below the caller's own rung.
   */
  function assertGrantWithinAuthority(authority, name) {
    const available = (readPermissionCatalog()?.options ?? []).map((option) => option.value).filter(Boolean)
    if (authority?.rank === undefined) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        `This DSH caller's own file policy could not be read, so permission preset "${name}" cannot be granted: an internal caller may grant at most its own authority. Set the preset in the Harness GUI instead.`,
      )
    }
    const requested = presetSandbox(name)
    const requestedRank = sandboxRank(requested)
    if (requestedRank === undefined) {
      const hint = available.length ? ` Available presets: ${available.join(', ')}.` : ''
      throw new McpError(
        ERROR_CODES.invalidParams,
        `Permission preset "${name}" has no sandbox mode this Host can read, so an internal DSH caller cannot check it against its own policy.${hint}`,
      )
    }
    if (requestedRank > authority.rank) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        `Permission preset "${name}" (${requested}) is wider than the calling DSH agent's own file policy (${authority.mode}). An internal caller may grant at most its own authority, so this was refused; raise this session's preset in the Harness GUI and retry.`,
      )
    }
    return name
  }

  /**
   * A preset at, and no wider than, the caller's own rung.
   *
   * The caller's own preset wins while it still matches; otherwise the widest
   * configured preset that does not exceed the caller is used, so a session an
   * internal caller starts never outranks the caller.
   */
  function presetWithinAuthority(authority) {
    if (authority?.rank === undefined) return undefined
    const own = authority.preset
    if (typeof own === 'string' && own && own !== 'custom' && sandboxRank(presetSandbox(own)) === authority.rank) return own
    const names = [...new Set((readPermissionCatalog()?.options ?? [])
      .flatMap((option) => [option?.value, option?.name])
      .filter((value) => typeof value === 'string' && value))]
    let best
    for (const name of names) {
      const rank = sandboxRank(presetSandbox(name))
      if (rank === undefined || rank > authority.rank) continue
      if (best === undefined || rank > best.rank) best = { name, rank }
    }
    return best?.name
  }

  /**
   * Refuse an approval an internal caller could not grant.
   *
   * An approval hands the requesting session a sandbox strictly wider than that
   * session's own, so the only internal caller that can be sure the grant stays
   * inside its own authority is one already holding the widest rung.
   */
  function assertMaySettleApproval(authority) {
    if (authority?.rank !== undefined && authority.rank === SANDBOX_MODES.length - 1) return
    throw new McpError(
      ERROR_CODES.invalidParams,
      `An internal DSH caller at "${authority?.mode ?? 'unknown'}" cannot settle an approval: an approval grants a session a sandbox strictly wider than its own, which may exceed this caller's authority. Decide it in the Harness GUI, or raise this session's preset to danger-full-access first.`,
    )
  }

  /**
   * The delivery mode one continued prompt uses.
   *
   * @param requested - the caller's own `mode` argument, when it named one.
   * @returns 'steer' or 'queue'.
   */
  function deliveryMode(requested) {
    if (requested === 'steer' || requested === 'queue') return requested
    if (busyMode === 'steer' || busyMode === 'queue') return busyMode
    return busyEnterSetting(ctx) ?? 'queue'
  }

  /** The preset a `/permission <name>` line would switch to. */
  function permissionPresetOfCommand(line) {
    const match = COMMAND_LINE_PATTERN.exec(String(line ?? ''))
    if (!match || match[1] !== 'permission') return undefined
    const rest = String(line).slice(match[0].length).trim()
    return rest ? rest.split(/\s+/u)[0] : undefined
  }

  /** The caller row an internal DSH agent is recorded under. */
  function internalCallerOf(agent) {
    const key = agent?.session?.header?.id ?? agent?.id
    return {
      id: `dsh-agent:${key ?? 'unknown'}`,
      name: 'dsh-agent',
      ...(typeof options.dshVersion === 'string' && options.dshVersion ? { version: options.dshVersion } : {}),
      source: 'dsh-agent',
    }
  }

  /** Fold a DSH agent into the same context an inbound MCP request produces. */
  function internalContext(context) {
    const agent = context?.agent
    if (!agent) {
      // A DSH-facing call whose Agent is unavailable is still an internal call:
      // fail closed by carrying an authority with no rank rather than falling
      // back to the unrestricted external-caller path.
      if (context?.surface === 'dsh') return { ...context, authority: authorityOf(undefined), internal: true }
      return context
    }
    const caller = sessionOwners ? sessionOwners.touch(internalCallerOf(agent)) : internalCallerOf(agent)
    return { ...context, caller, authority: authorityOf(agent), internal: true }
  }

  /** A short window of text around a match, with ellipses where it was cut. */
  function snippetAround(text, index, chars) {
    const start = Math.max(0, index - 60)
    const end = Math.min(text.length, start + chars)
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
  }

  /**
   * Parked user decisions, plus the answerers that let an MCP caller settle one.
   * The fold helpers are module-level; the live log, ownership registry, and
   * request hooks are injected so this module keeps the service lookup.
   */
  const { parkedRequests, parkedList, releaseParked } = createRequestHelpers({
    ctx,
    logger,
    sessionMessages,
    sessionOwners,
    answerUserRequests,
    requestAnswerTimeoutMs,
    answerOwnedSessionsOnly,
  })

  /** Record that the calling agent created (or first adopted) a session. */
  function recordOwnership(sessionId, caller, meta = {}, { adopt = false } = {}) {
    if (!sessionOwners || !caller?.id) return undefined
    if (adopt) sessionOwners.adopt(sessionId, caller, meta)
    else sessionOwners.claim(sessionId, caller, meta)
    return ownerSummary(sessionId)
  }

  /** Wait until a slot for one concurrent waited turn is free. */
  async function acquireTurnSlot(signal) {
    while (activeTurns >= maxConcurrentTurns) {
      if (signal?.aborted) throw new McpError(ERROR_CODES.internalError, 'The request was cancelled.')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    activeTurns += 1
    return () => { activeTurns -= 1 }
  }

  /** Highest turn number currently in the session log, or undefined. */
  async function currentTurn(sessionId) {
    const sessionQuery = ctx.get('sessionQuery')
    if (!sessionQuery) return undefined
    try {
      const snapshot = await sessionQuery.readSession(sessionId)
      let turn
      for (const event of snapshot?.events ?? []) {
        if (event?.type !== 'turn/start') continue
        const value = turnOfEvent(event)
        if (value !== undefined) turn = value
      }
      return turn
    } catch {
      return undefined
    }
  }

  /**
   * The address the Harness expects for following one session.
   *
   * A subagent-owned session is followed through its durable parent address;
   * the plain `{ kind: 'session' }` form is refused by the API controller.
   */
  function followAddress(sessionId) {
    try {
      const session = ctx.get('sessions')?.get?.(sessionId)
      const header = session?.header
      if (header?.origin === 'subagent' && typeof header.parentSession === 'string' && header.parentSession) {
        return {
          kind: 'subagent',
          parentSessionId: header.parentSession,
          childSessionId: sessionId,
          mode: 'unknown',
        }
      }
    } catch (error) {
      logger('debug', 'session address lookup failed', { sessionId, error: errorText(error) })
    }
    return { kind: 'session', sessionId }
  }

  /** Highest durable event seq currently in the session log, or -1. */
  async function currentSeq(sessionId) {
    const sessionQuery = ctx.get('sessionQuery')
    if (!sessionQuery) return -1
    try {
      const snapshot = await sessionQuery.readSession(sessionId)
      const events = snapshot?.events ?? []
      let max = -1
      for (const event of events) {
        const seq = Number(event?.seq)
        if (Number.isFinite(seq) && seq > max) max = seq
      }
      return max
    } catch {
      return -1
    }
  }

  /**
   * The registry-global archive set, or `undefined` when this deployment has no
   * workspace registry; callers then omit archival state instead of guessing.
   */
  function archivedSessionIds() {
    const ids = ctx.get('workspaceRegistry')?.archivedSessionIds
    return Array.isArray(ids) ? ids : undefined
  }

  /**
   * The deployment's permission-preset catalog, or `undefined` when the Host
   * composes no permission-preset service; callers then omit permission state
   * instead of guessing.
   */
  function readPermissionCatalog() {
    const service = ctx.get('permissionPresets')
    if (!service) return undefined
    try {
      if (typeof service.catalog === 'function') {
        const catalog = service.catalog()
        if (Array.isArray(catalog?.options)) {
          return {
            defaultPreset: catalog.defaultPreset,
            options: catalog.options,
          }
        }
      }
      const names = Array.isArray(service.names) ? service.names : []
      return {
        defaultPreset: service.defaultPreset,
        options: names.map((value) => ({ value, name: value })),
      }
    } catch (error) {
      logger('debug', 'permission catalog read failed', { error: errorText(error) })
      return undefined
    }
  }

  /** One model-readable diagnostic for a session the Host refused to resolve. */
  function sessionResolutionError(sessionId, error) {
    const detail = error?.message ?? error?.code ?? JSON.stringify(error)
    return new McpError(
      ERROR_CODES.invalidParams,
      `Session "${sessionId}" could not be resolved: ${detail}`,
    )
  }

  /**
   * Resolve the live Session behind one id, resuming a cold session through the
   * Host session controller when the store holds no live entry.
   */
  async function resolveLiveSession(sessionId) {
    const store = ctx.get('sessions')
    const live = typeof store?.get === 'function' ? store.get(sessionId) : undefined
    if (live) return live
    const controller = ctx.get('sessionController')
    if (typeof controller?.resolveAgent !== 'function') return undefined
    const resolved = await controller.resolveAgent(sessionId)
    if (resolved?.error) throw sessionResolutionError(sessionId, resolved.error)
    return resolved?.agent?.session
  }

  /**
   * Resolve the live Agent behind one id, resuming a cold session if needed.
   *
   * Commands are registered per Agent — a global layer plus the layers of the
   * preset that Agent is mounted under — so every command operation must be
   * addressed by an Agent rather than by a Session.
   */
  async function resolveLiveAgent(sessionId) {
    const agents = ctx.get('agents')
    const live = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (live) return live
    const controller = ctx.get('sessionController')
    if (typeof controller?.resolveAgent !== 'function') return undefined
    const resolved = await controller.resolveAgent(sessionId)
    if (resolved?.error) throw sessionResolutionError(sessionId, resolved.error)
    return resolved?.agent
  }

  /** Resolve the Agent a command tool must act on, failing readably when absent. */
  async function requireAgent(sessionId) {
    const agent = await resolveLiveAgent(sessionId)
    if (!agent) {
      throw new McpError(
        ERROR_CODES.internalError,
        `The DeepSeek Harness session "${sessionId}" is not live, so its commands cannot be used.`,
      )
    }
    return agent
  }

  /** The names of the commands the given Agent can currently run. */
  function commandNames(commands, agent) {
    try {
      const descriptors = typeof commands.list === 'function' ? commands.list(agent) : []
      return (Array.isArray(descriptors) ? descriptors : [])
        .map((entry) => entry?.name)
        .filter((name) => typeof name === 'string' && name)
    } catch (error) {
      logger('debug', 'command list failed', { error: errorText(error) })
      return []
    }
  }

  /**
   * Build and validate the exact slash-command line for one call.
   *
   * Accepts a complete `line` (e.g. `"/permission danger-full-access"`) or a
   * bare `command` name plus optional `args`, and rejects anything the Host's
   * own parser would not recognize as a command, so the failure names the shape
   * instead of silently returning "not a command".
   *
   * @param args - raw tool arguments.
   * @returns the exact command line, leading slash included.
   */
  function parseCommandLine(args) {
    const explicitLine = typeof args.line === 'string' ? args.line.trim() : ''
    let line = explicitLine
    if (!line) {
      const name = typeof args.command === 'string' ? args.command.trim().replace(/^\/+/, '') : ''
      if (name) {
        const suffix = typeof args.args === 'string' && args.args.trim() ? ` ${args.args.trim()}` : ''
        line = `/${name}${suffix}`
      }
    }
    if (!line) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        'Provide "line" (for example "/compact") or "command" (for example "compact").',
      )
    }
    if (!COMMAND_LINE_PATTERN.test(line)) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        `"${line}" is not a slash-command line; it must look like "/name" or "/name args".`,
      )
    }
    return line
  }

  /**
   * Apply one permission preset to a session before its prompt is admitted, so
   * the turn's own tool calls already see the chosen sandbox mode and approval
   * policy. Uses the Host `permissionPresets` service, the same write path as
   * the GUI `/permission` command.
   *
   * @param sessionId - target session.
   * @param name - preset name from {@link readPermissionCatalog}.
   * @returns the applied preset name.
   */
  async function applyPermissionPreset(sessionId, name, provided) {
    const service = requireService(ctx, 'permissionPresets')
    const session = provided ?? await resolveLiveSession(sessionId)
    if (!session) {
      throw new McpError(
        ERROR_CODES.internalError,
        `The DeepSeek Harness session "${sessionId}" is not live, so permission preset "${name}" cannot be applied.`,
      )
    }
    try {
      await service.set(session, name)
    } catch (error) {
      const available = (readPermissionCatalog()?.options ?? []).map((option) => option.value).filter(Boolean)
      const hint = available.length ? ` Available presets: ${available.join(', ')}.` : ''
      throw new McpError(
        ERROR_CODES.invalidParams,
        `Permission preset "${name}" could not be applied to session "${sessionId}": ${errorText(error)}.${hint}`,
      )
    }
    return name
  }

  /**
   * Session list rows enriched with their title and archival state.
   *
   * Archived sessions are hidden by default, mirroring the Web UI's grouping
   * surfaces; `includeArchived` reveals them. Rows carry `archived` whenever the
   * archive set is known.
   *
   * @param signal - optional abort signal from the MCP request.
   * @param limit - maximum rows to return.
   * @param options - `{ includeArchived }`.
   */
  /**
   * Title snapshots for a batch of sessions, as a Map of sessionId to title.
   *
   * @param items - controller list items.
   * @param signal - optional abort signal.
   */
  async function fetchTitles(items, signal) {
    const sessionQuery = ctx.get('sessionQuery')
    if (!sessionQuery || !items.length) return new Map()
    try {
      const observed = await sessionQuery.readTitleSnapshots(items.map((item) => item.sessionId), signal)
      return new Map((observed ?? []).map((entry) => [
        entry.sessionId,
        entry.status === 'fulfilled' ? entry.value?.title?.title : undefined,
      ]))
    } catch (error) {
      logger('debug', 'title lookup failed', { error: errorText(error) })
      return new Map()
    }
  }

  /**
   * One page of the caller's session index.
   *
   * Progressive disclosure: the index is compact by default (`view: "index"`),
   * narrowed server-side by owner, running state and a text query, and paged with
   * an offset cursor, so a caller never has to pull every session to find one.
   *
   * @param signal - optional abort signal from the MCP request.
   * @param limit - maximum rows in this page.
   * @param options - `{ includeArchived, caller, mineOnly, ownerId, query, running, cursor, view }`.
   */
  async function listSessionRows(signal, limit, options = {}) {
    const {
      includeArchived = false,
      caller,
      mineOnly = false,
      ownerId,
      query,
      running,
      cursor = 0,
      view = 'index',
    } = options
    const controller = requireService(ctx, 'sessionController')
    const listed = await controller.list({}, signal)
    const items = Array.isArray(listed?.items) ? listed.items : []
    const archivedIds = archivedSessionIds()
    const archivedSet = new Set(archivedIds ?? [])
    const visible = includeArchived ? items : items.filter((item) => !archivedSet.has(item.sessionId))
    // Scope before paging, so a caller's own older sessions are never pushed out
    // of the window by sessions it is not allowed to see.
    const wantedOwner = ownerId ?? (mineOnly ? (caller?.id ?? 'unknown') : undefined)
    let matched = wantedOwner === undefined
      ? visible
      : visible.filter((item) => sessionOwners?.ownerOf(item.sessionId)?.ownerId === wantedOwner)

    if (running !== undefined) matched = matched.filter((item) => (item.running === true) === running)

    const needle = typeof query === 'string' && query.trim() ? query.trim().toLowerCase() : undefined
    if (needle) {
      // Cheap matches first (id, cwd, owning agent); titles need a Host lookup, so
      // only the first candidates are probed for them.
      const cheap = new Set()
      for (const item of matched) {
        const owner = sessionOwners?.ownerOf(item.sessionId)
        if ([item.sessionId, item.cwd, owner?.ownerName].some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))) {
          cheap.add(item.sessionId)
        }
      }
      const probe = matched.filter((item) => !cheap.has(item.sessionId)).slice(0, TITLE_QUERY_CANDIDATES)
      const probedTitles = await fetchTitles(probe, signal)
      const byTitle = new Set()
      for (const [sessionId, title] of probedTitles) {
        if (typeof title === 'string' && title.toLowerCase().includes(needle)) byTitle.add(sessionId)
      }
      matched = matched.filter((item) => cheap.has(item.sessionId) || byTitle.has(item.sessionId))
    }

    const total = matched.length
    const start = Math.min(Math.max(0, Number(cursor) || 0), total)
    const page = matched.slice(start, start + limit)
    const titles = await fetchTitles(page, signal)
    const ownerKnown = caller?.id !== undefined

    return {
      rows: page.map((item) => {
        const owner = ownerSummary(item.sessionId)
        const row = {
          sessionId: item.sessionId,
          title: titles.get(item.sessionId) ?? undefined,
          running: item.running === true,
          ...(archivedIds === undefined ? {} : { archived: archivedSet.has(item.sessionId) }),
          updatedAt: new Date(Number(item.updatedAt) || Date.now()).toISOString(),
          ...(owner ? { owner, mine: ownerKnown && owner.id === caller.id } : {}),
        }
        // The full view adds the fields an index does not need to carry.
        if (view === 'full') {
          row.cwd = item.cwd
          row.live = item.agentAvailable === true
          row.blank = item.blank === true
        }
        return row
      }),
      total,
      ...(start + page.length < total ? { nextCursor: start + page.length } : {}),
      archivedTotal: archivedIds?.length,
      archivedHidden: includeArchived ? 0 : items.length - visible.length,
    }
  }

  /**
   * Admit one prompt and (optionally) wait for its turn to end.
   *
   * @param request - `{ sessionId, prompt, create, cwd, agentPreset, model, permissionPreset, wait, timeoutMs, signal, mode }`.
   * @returns the turn outcome.
   */
  async function runTurn(request) {
    const {
      sessionId,
      prompt,
      create = false,
      cwd,
      agentPreset,
      model,
      permissionPreset,
      wait = true,
      timeoutMs = turnTimeoutMs,
      signal,
      // Left undefined when the caller named no mode: the delivery policy below
      // then follows the deployment's own busy-Enter setting.
      mode,
      authority,
    } = request
    /**
     * The preset this turn applies, after the internal-caller ceiling.
     *
     * An internal DSH caller may set at most its own file policy: a wider preset
     * is refused, and a session it starts without naming one is pinned to a
     * preset at the caller's own rung rather than the deployment default, which
     * could be wider than the caller.
     */
    let permission = permissionPreset
    if (authority?.internal) {
      if (permission) {
        permission = assertGrantWithinAuthority(authority, permission)
      } else if (create) {
        permission = presetWithinAuthority(authority)
        if (!permission) {
          throw new McpError(
            ERROR_CODES.invalidParams,
            `This DSH caller runs at "${authority.mode ?? 'unknown'}", which matches no configured permission preset, so a session it starts could exceed the caller's own authority. Raise this session's preset in the Harness GUI first.`,
          )
        }
      }
    }
    /** Present only when the caller asked for one, so results stay quiet otherwise. */
    const appliedPermission = permission ? { permissionPreset: permission } : {}
    /** Delivery facts, added to every return below. */
    const deliveryPayload = () => ({
      ...(deliveryInfo?.mode ? { mode: deliveryInfo.mode } : {}),
      ...(deliveryInfo?.via === 'agent' && authority?.sessionId ? { from: authority.sessionId } : {}),
    })

    const controller = requireService(ctx, 'sessionController')
    const requestId = `${REQUEST_ID_PREFIX}-${randomUUID()}`
    const beforeSeq = create ? -1 : await currentSeq(sessionId)
    /** The sidebar project this session joined, when one did. */
    let workspace
    /**
     * The target session, resolved once.
     *
     * The permission pin and the sidebar group both need its identity, and a
     * cold session must resume exactly once for one call.
     */
    let targetSession
    /** Whether the target was already running when the prompt is admitted. */
    let wasRunning = false
    if (!create) {
      try {
        targetSession = await resolveLiveSession(sessionId)
      } catch (error) {
        // The prompt itself reports a session that cannot be resolved.
        targetSession = undefined
      }
      assertTargetWithinAuthority(authority, targetSession)
      try {
        wasRunning = ctx.get('agents')?.get?.(sessionId)?.status === 'running'
      } catch {
        wasRunning = false
      }
    }
    /** How the prompt was admitted: which delivery mode, and whether it was labelled. */
    let deliveryInfo

    try {
      if (create) {
        await controller.create({
          sessionId,
          ...(cwd ? { cwd } : {}),
          ...(agentPreset ? { agentPreset } : {}),
        })
        // The sidebar groups by recorded project membership, so a session this
        // endpoint started has to be attached or it stays in Ungrouped.
        if (groupSessions) workspace = await groupSession(ctx, sessionId, { create: createGroups, logger })
      } else if (groupSessions) {
        workspace = await groupSession(ctx, sessionId, { session: targetSession, logger })
      }
      if (permission) await applyPermissionPreset(sessionId, permission, targetSession)
      // A new session starts on the default model, but an existing session keeps the
      // model it already runs unless the caller overrides it explicitly: a plain
      // continuation must not silently re-pin a session to the Harness default.
      // The default is resolved here, at call time: the Harness's selection is
      // volatile and a value captured at activation goes stale.
      const selection = create ? (model ?? resolveDefaultSelection()) : model
      if (selection?.provider && selection?.model) {
        try {
          await controller.selectModel({
            sessionId,
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          })
        } catch (error) {
          // An explicit model is the caller's decision: fail loudly. A default
          // that went stale (a retired model pair, a changed selection) must not
          // cost the session; the Host's own default applies instead.
          if (!(create && model === undefined)) throw error
          logger('warn', 'default model unavailable; the session keeps the Host default', {
            sessionId,
            provider: selection.provider,
            model: selection.model,
            error: errorText(error),
          })
        }
      }
      const delivery = create ? 'queue' : deliveryMode(mode)
      // An internal caller's message carries its own durable source, so the
      // target session's transcript shows which session sent it. Every other
      // caller keeps the controller's own `user` source.
      let delivered
      if (authority?.internal) {
        const handle = await resolveAgentHandle(sessionId)
        if (handle) {
          const message = createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: internalMessageSource(authority),
          })
          try {
            if (delivery === 'steer') handle.steer(message)
            else handle.followup(message)
            delivered = { via: 'agent', mode: delivery }
          } catch (error) {
            // A handle that refuses the message must not cost the prompt: the
            // controller path below is the fallback, without the label.
            logger('debug', 'labelled prompt refused; falling back to the session controller', {
              sessionId,
              error: errorText(error),
            })
          }
        }
      }
      if (!delivered) {
        await controller.prompt(
          { sessionId, requestId, mode: delivery, content: [{ type: 'text', text: prompt }] },
          signal,
        )
        delivered = { mode: delivery }
      }
      deliveryInfo = delivered
    } catch (error) {
      // A permission failure already carries the model-readable diagnostic.
      if (error instanceof McpError) throw error
      throw new McpError(
        ERROR_CODES.invalidParams,
        `DeepSeek Harness rejected the prompt for session "${sessionId}": ${errorText(error)}`,
      )
    }

    if (!wait) {
      return { sessionId, status: 'started', text: '', requestId, ...appliedPermission, ...deliveryPayload(), ...(workspace ? { workspace } : {}) }
    }

    const timeoutSignal = AbortSignal.timeout(Math.max(1000, timeoutMs))
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const release = await acquireTurnSlot(combined)
    // A queued prompt joins the *next* turn, so the running turn's end is not
    // this prompt's answer: ignore it and wait for the turn that consumes it.
    const skipTurnEndThrough = wasRunning && deliveryInfo?.mode === 'queue'
      ? await currentTurn(sessionId)
      : undefined
    let outcome
    try {
      outcome = await followToTurnEnd(sessionId, { beforeSeq, signal: combined, skipTurnEndThrough })
    } finally {
      release()
    }

    const { text, endReason, interrupted } = outcome
    if (interrupted) {
      // Waiting is not owning: this call stops waiting, but the DSH turn keeps
      // running, so a caller with a shorter ceiling loses its answer, not the work.
      const timedOut = timeoutSignal.aborted && !signal?.aborted
      return {
        sessionId,
        status: timedOut ? 'timeout' : 'cancelled',
        text,
        requestId,
        note: timedOut
          ? `The wait exceeded ${timeoutMs} ms and stopped; the DSH turn is still running. Call dsh_wait_session to keep waiting, or dsh_cancel_session to stop it.`
          : 'The MCP caller stopped waiting; the DSH turn keeps running.',
        ...appliedPermission,
        ...deliveryPayload(),
        ...(workspace ? { workspace } : {}),
      }
    }
    return {
      sessionId,
      status: endReason === 'error' ? 'error' : 'completed',
      text,
      requestId,
      turnEndReason: endReason,
      ...appliedPermission,
      ...deliveryPayload(),
      ...(workspace ? { workspace } : {}),
    }
  }

  /**
   * Follow one session's stream until its next `turn/end`.
   *
   * Returns the assistant text produced after `beforeSeq`, the Host's end reason,
   * and whether the wait was interrupted (its ceiling was reached, or the caller
   * vanished). It never cancels the session: callers decide what an interruption
   * means.
   */
  async function followToTurnEnd(sessionId, { beforeSeq, signal, skipTurnEndThrough }) {
    const controller = requireService(ctx, 'sessionController')
    const texts = []
    let endReason
    let interrupted = false
    try {
      const stream = controller.follow(
        { address: followAddress(sessionId) },
        signal,
      )
      for await (const frame of stream) {
        if (frame?.type === 'snapshot') {
          for (const record of frame.records ?? []) {
            const recordEvent = record?.event
            if (!recordEvent || Number(recordEvent.seq) <= beforeSeq) continue
            const message = messageOfEvent(recordEvent)
            if (message?.role === 'assistant') texts.push(message.text)
          }
          continue
        }
        const event = frame?.type === 'event' ? frame.event : undefined
        if (!event) continue
        const seq = Number(event.seq)
        if (!Number.isFinite(seq) || seq <= beforeSeq) continue
        if (event.type === 'assistant/message') {
          // A queued prompt's answer is the next turn's text; the turn that was
          // already running when it arrived is not part of the answer.
          const turn = turnOfEvent(event)
          if (Number.isFinite(skipTurnEndThrough) && Number.isFinite(turn)
            && turn <= skipTurnEndThrough) {
            continue
          }
          const message = messageOfEvent(event)
          if (message) texts.push(message.text)
        } else if (event.type === 'turn/end') {
          const ended = turnOfEvent(event)
          if (Number.isFinite(skipTurnEndThrough) && Number.isFinite(ended)
            && ended <= skipTurnEndThrough) {
            continue
          }
          endReason = event.data?.reason?.kind ?? 'completed'
          break
        }
      }
    } catch (error) {
      const aborted = signal?.aborted || error?.name === 'AbortError'
      if (!aborted) {
        logger('warn', 'follow failed', { sessionId, error: errorText(error) })
        throw new McpError(ERROR_CODES.internalError, `Following session "${sessionId}" failed: ${errorText(error)}`)
      }
      interrupted = true
    }
    return { text: texts.filter(Boolean).join('\n\n'), endReason, interrupted }
  }

  /** Whether the Host reports a running turn for one session, or `undefined` when unlisted. */
  async function sessionRunning(sessionId, signal) {
    try {
      const listed = await requireService(ctx, 'sessionController').list({}, signal)
      const items = Array.isArray(listed?.items) ? listed.items : []
      const item = items.find((entry) => entry.sessionId === sessionId)
      return item ? item.running === true : undefined
    } catch (error) {
      logger('debug', 'session state lookup failed', { sessionId, error: errorText(error) })
      return undefined
    }
  }

  /**
   * Wait for the turn a session is already running, without touching it.
   *
   * `runTurn` answers "what did the prompt I just sent produce"; this answers "let
   * that work finish", for turns started with `wait: false`, from the Harness GUI,
   * or by another caller. It never prompts and never cancels: reaching `timeoutMs`
   * only ends the wait (`status: "timedOut"`, turn still running), so a caller can
   * wait again instead of polling the transcript.
   */
  async function waitForTurn(sessionId, { timeoutMs = turnTimeoutMs, limit = 0, signal } = {}) {
    const startedAt = Date.now()
    /** Transcript tail, only when the caller asked for one. */
    const tail = async () => {
      if (!(limit > 0)) return {}
      try {
        const read = await readTranscript(sessionId, { limit, maxChars: 0 })
        return { totalMessages: read.totalMessages, messages: read.messages }
      } catch (error) {
        logger('debug', 'tail read after wait failed', { sessionId, error: errorText(error) })
        return {}
      }
    }

  /** Pending user decisions, so a wait that ends says what the turn is blocked on. */
    const pending = async () => {
      try {
        const { events } = await sessionMessages(sessionId)
        const summary = pendingSummary(foldUserRequests(events))
        return summary.count ? { pending: summary } : {}
      } catch (error) {
        logger('debug', 'pending read after wait failed', { sessionId, error: errorText(error) })
        return {}
      }
    }
    const running = await sessionRunning(sessionId, signal)
    if (running !== true) {
      // Nothing to wait for: answer with the current transcript instead of blocking.
      return {
        sessionId,
        status: 'idle',
        running: false,
        ...(running === undefined ? { listed: false } : {}),
        waitedMs: Date.now() - startedAt,
        text: '',
        ...(await tail()),
        ...(await pending()),
      }
    }

    const beforeSeq = await currentSeq(sessionId)
    const timeoutSignal = AbortSignal.timeout(Math.max(1000, timeoutMs))
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const { text, endReason, interrupted } = await followToTurnEnd(sessionId, { beforeSeq, signal: combined })
    const waitedMs = Date.now() - startedAt
    if (interrupted) {
      const timedOut = timeoutSignal.aborted && !signal?.aborted
      return {
        sessionId,
        status: timedOut ? 'timedOut' : 'disconnected',
        running: true,
        waitedMs,
        text,
        note: timedOut
          ? `Still running after ${timeoutMs} ms. Call dsh_wait_session again to keep waiting, or dsh_cancel_session to stop the turn.`
          : 'The MCP caller stopped waiting; the DSH turn keeps running.',
        ...(await tail()),
        ...(await pending()),
      }
    }
    return {
      sessionId,
      status: endReason === 'error' ? 'error' : 'completed',
      running: false,
      waitedMs,
      text,
      turnEndReason: endReason,
      ...(await tail()),
      ...(await pending()),
    }
  }

  /** Session status row used by `dsh_status`. */
  async function status(caller) {
    const sessionQuery = ctx.get('sessionQuery')
    let sessionCount
    let liveAgents
    try {
      if (sessionQuery) {
        const records = await sessionQuery.listSessions()
        sessionCount = records.length
        liveAgents = records.filter((record) => record.live).length
      }
    } catch (error) {
      logger('debug', 'status count failed', { error: errorText(error) })
    }
    const catalog = readPermissionCatalog()
    return {
      server: 'dsh-mcp-server',
      dshVersion: options.dshVersion,
      // Omitted rather than `undefined`: an internal (PTC) call validates the
      // canonical value, and `undefined` is not lossless JSON.
      ...(process.env.DSH_PROFILE ? { profile: process.env.DSH_PROFILE } : {}),
      dshHome: options.dshHome,
      endpoint: options.endpoint,
      uptimeMs: Date.now() - options.startedAt,
      activeTurns,
      maxConcurrentTurns,
      sessions: sessionCount,
      liveAgents,
      defaultCwd: defaultCwd ?? null,
      defaultModel: resolveDefaultSelection() ?? null,
      ...(caller?.id ? { caller: describeCaller(caller) } : {}),
      ...(sessionOwners ? { clients: { seen: sessionOwners.clientCount, sessions: sessionOwners.sessionCount } } : {}),
      ...(catalog ? { defaultPermissionPreset: catalog.defaultPreset, permissionPresets: catalog.options } : {}),
      toolNames: TOOL_DEFINITIONS.map((tool) => tool.name),
      ...(typeof dshTools === 'function' ? { dshTools: dshTools() } : {}),
      // What a continued prompt will do when the session is busy, so a caller
      // can see which policy this deployment follows.
      ...(typeof busyMode === 'string' ? { busyMode: { configured: busyMode, effective: deliveryMode(undefined) } } : {}),
      ...(typeof configPreset === 'string' ? { configPreset } : {}),
      // How a session this endpoint starts reaches the sidebar: joined to an
      // existing project, and whether this deployment lets one be invented.
      grouping: { attach: groupSessions, create: createGroups },
      ...(typeof clientPage === 'function' ? { clientPage: clientPage() } : {}),
      // Whether a starting task asks the other agents in this workspace what
      // they are touching, and what it is currently waiting on.
      ...(typeof options.syncStatus === 'function' ? { sync: options.syncStatus() } : {}),
      // Must-reply questions this endpoint is currently holding open.
      ...(questions ? { questions: questions.status() } : {}),
    }
  }

  /** Parse an optional `"provider/model"` override argument. */
  function parseModelArg(args) {
    if (typeof args.model !== 'string' || !args.model.trim()) return undefined
    const raw = args.model.trim()
    const slash = raw.indexOf('/')
    if (slash <= 0 || slash === raw.length - 1) {
      throw new McpError(ERROR_CODES.invalidParams, '"model" must look like "provider/model".')
    }
    return {
      provider: raw.slice(0, slash),
      model: raw.slice(slash + 1),
      ...(typeof args.reasoningEffort === 'string' && args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    }
  }

  /** Parse the optional permission-preset argument into a trimmed name. */
  function parsePermissionPreset(args) {
    if (typeof args.permissionPreset !== 'string') return undefined
    const name = args.permissionPreset.trim()
    return name ? name : undefined
  }

  const handlers = {
    async dsh_run_prompt(args, context) {
      const prompt = String(args.prompt ?? '')
      if (!prompt.trim()) throw new McpError(ERROR_CODES.invalidParams, '"prompt" must not be empty.')
      const sessionId = `session-${randomUUID()}`
      const requestedCwd = args.cwd !== undefined
      let cwd = normalizeCwd(args.cwd) ?? defaultCwd
      // An internal caller may start a session only inside its own workspace:
      // the session's cwd is what DSH uses as its workspace-write root.
      if (context?.authority?.internal) cwd = clampInternalCwd(context.authority, requestedCwd ? cwd : undefined)
      const agentPreset = typeof args.agentPreset === 'string' && args.agentPreset ? args.agentPreset : undefined
      const outcome = await runTurn({
        sessionId,
        prompt,
        create: true,
        cwd,
        agentPreset,
        permissionPreset: parsePermissionPreset(args),
        model: parseModelArg(args),
        wait: args.wait !== false,
        timeoutMs: numberArg(args.timeoutMs, turnTimeoutMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
        signal: context?.signal,
        authority: context?.authority,
      })
      // Attribution is recorded only after the Host admitted the prompt, so a
      // rejected call never claims a session it did not create.
      const owner = recordOwnership(sessionId, context?.caller, { cwd, agentPreset })
      const payload = { ...outcome, ...(owner ? { owner } : {}) }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_continue_session(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      const prompt = String(args.prompt ?? '')
      if (!prompt.trim()) throw new McpError(ERROR_CODES.invalidParams, '"prompt" must not be empty.')
      assertCallerMay(sessionId, context?.caller)
      // An unnamed mode stays unnamed: the delivery policy decides, which is what
      // lets this follow the deployment's own busy-Enter setting.
      const mode = args.mode === 'steer' ? 'steer' : args.mode === 'queue' ? 'queue' : undefined
      const outcome = await runTurn({
        sessionId,
        prompt,
        create: false,
        permissionPreset: parsePermissionPreset(args),
        model: parseModelArg(args),
        mode,
        wait: args.wait !== false,
        timeoutMs: numberArg(args.timeoutMs, turnTimeoutMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
        signal: context?.signal,
        authority: context?.authority,
      })
      // A session with no recorded owner — one the GUI or an older build made —
      // is adopted by the first caller that drives it.
      const owner = recordOwnership(sessionId, context?.caller, {}, { adopt: true })
      const payload = { ...outcome, ...(owner ? { owner } : {}) }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_ask_session(args, context) {
      if (!questions) {
        throw new McpError(ERROR_CODES.internalError, 'This endpoint has no must-reply question service.')
      }
      const sessionId = String(args.sessionId ?? '').trim()
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      const question = String(args.question ?? '')
      if (!question.trim()) throw new McpError(ERROR_CODES.invalidParams, '"question" must not be empty.')
      assertCallerMay(sessionId, context?.caller)
      // A human stop is durable, so it is checked against the recorded turn
      // history as well as the live flag: a question must not be the thing that
      // wakes a session its person deliberately stopped.
      if (typeof sessionStopped === 'function') {
        let stopped = false
        try {
          stopped = (await sessionStopped(sessionId)) === true
        } catch (error) {
          logger('debug', 'session stop state lookup failed', { sessionId, error: errorText(error) })
        }
        if (stopped) {
          throw new McpError(
            ERROR_CODES.invalidParams,
            `Session "${sessionId}" was stopped by a human, so it will not be woken by a question. Resume it first, then ask again.`,
          )
        }
      }
      // Resolving here resumes a cold target once, and produces a readable
      // failure when the id names no session at all — before a request is kept.
      let targetSession
      try {
        targetSession = await resolveLiveSession(sessionId)
      } catch (error) {
        if (error instanceof McpError) throw error
        throw sessionResolutionError(sessionId, error)
      }
      assertTargetWithinAuthority(context?.authority, targetSession)
      const from = {
        ...(context?.authority?.sessionId ? { sessionId: context.authority.sessionId } : {}),
        ...(context?.authority?.agentId ? { agentId: context.authority.agentId } : {}),
        ...(context?.caller?.name ? { name: context.caller.name } : {}),
      }
      let outcome
      try {
        outcome = await questions.ask({
          targetSessionId: sessionId,
          question,
          timeoutMs: args.timeoutMs,
          signal: context?.signal,
          from,
        })
      } catch (error) {
        if (error instanceof McpError) throw error
        throw new McpError(ERROR_CODES.internalError, `The must-reply question failed: ${errorText(error)}`)
      }
      return { text: JSON.stringify(outcome, null, 2), structuredContent: outcome }
    },

    async dsh_answer_question(args, context) {
      if (!questions) {
        throw new McpError(ERROR_CODES.internalError, 'This endpoint has no must-reply question service.')
      }
      // The answer path exists only for the addressed DSH session: an external
      // MCP client has a caller identity but no session to answer as.
      const answerer = context?.authority
      if (!answerer?.internal || !answerer.sessionId) {
        throw new McpError(
          ERROR_CODES.invalidParams,
          'Only the addressed DSH session may answer a must-reply question; an external MCP client has no session to answer as.',
        )
      }
      const id = String(args.id ?? '').trim()
      if (!id) throw new McpError(ERROR_CODES.invalidParams, '"id" is required.')
      const answer = String(args.answer ?? '')
      if (!answer.trim()) throw new McpError(ERROR_CODES.invalidParams, '"answer" must not be empty.')
      const payload = questions.answer({ id, answer, from: answerer })
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_get_question(args) {
      if (!questions) {
        throw new McpError(ERROR_CODES.internalError, 'This endpoint has no must-reply question service.')
      }
      const id = String(args.id ?? '').trim()
      if (!id) throw new McpError(ERROR_CODES.invalidParams, '"id" is required.')
      const payload = questions.get({ id })
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_list_commands(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      assertCallerMay(sessionId, context?.caller)
      const commands = requireService(ctx, 'commands')
      const agent = await requireAgent(sessionId)
      let descriptors
      try {
        descriptors = typeof commands.list === 'function' ? commands.list(agent) : []
      } catch (error) {
        throw new McpError(
          ERROR_CODES.internalError,
          `Commands of session "${sessionId}" could not be listed: ${errorText(error)}`,
        )
      }
      const payload = {
        sessionId,
        count: Array.isArray(descriptors) ? descriptors.length : 0,
        commands: (Array.isArray(descriptors) ? descriptors : [])
          .map((entry) => ({
            name: entry?.name,
            description: entry?.description,
            ...(entry?.input === undefined ? {} : { input: entry.input }),
          }))
          .filter((entry) => entry.name),
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_run_command(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      assertCallerMay(sessionId, context?.caller)
      const line = parseCommandLine(args)
      // A slash command is another grant path: `/permission <preset>` must respect
      // the same ceiling an explicit `permissionPreset` argument does.
      if (context?.authority?.internal) {
        const preset = permissionPresetOfCommand(line)
        if (preset) assertGrantWithinAuthority(context.authority, preset)
      }
      const commands = requireService(ctx, 'commands')
      const agent = await requireAgent(sessionId)
      assertTargetWithinAuthority(context?.authority, agent?.session)
      let execution
      try {
        execution = await commands.execute(agent, line, [], context?.signal)
      } catch (error) {
        throw new McpError(
          ERROR_CODES.invalidParams,
          `Command "${line}" failed in session "${sessionId}": ${errorText(error)}`,
        )
      }
      if (!execution) {
        const available = commandNames(commands, agent)
        const hint = available.length ? ` Available commands: ${available.join(', ')}.` : ''
        throw new McpError(
          ERROR_CODES.invalidParams,
          `"${line}" is not a command of session "${sessionId}".${hint}`,
        )
      }
      const payload = {
        sessionId,
        command: line,
        commandId: execution.commandId,
        kind: execution.result?.kind,
        ...(execution.result?.text === undefined ? {} : { text: execution.result.text }),
        ...(execution.result?.sourceEventSeq === undefined ? {} : { sourceEventSeq: execution.result.sourceEventSeq }),
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_list_sessions(args, context) {
      const limit = numberArg(args.limit, 20, { min: 1, max: 200 })
      const includeArchived = args.includeArchived === true
      // `mine` is implicit while the endpoint is scoped, so a restricted caller
      // cannot even enumerate sessions it would not be allowed to touch, and
      // `owner` cannot widen that scope.
      const scoped = scopedOwnerFilter(args, context?.caller)
      const mine = scoped.mine
      const ownerId = scoped.ownerId
      const caller = context?.caller
      const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined
      const running = args.running === true ? true : args.running === false ? false : undefined
      const view = args.view === 'full' ? 'full' : 'index'
      const cursor = numberArg(args.cursor, 0, { min: 0, max: 100000 })
      const { rows, total, nextCursor, archivedTotal, archivedHidden } = await listSessionRows(context?.signal, limit, {
        includeArchived,
        caller,
        mineOnly: mine && ownerId === undefined,
        ownerId,
        query,
        running,
        cursor,
        view,
      })
      const payload = {
        count: rows.length,
        ...(total === undefined ? {} : { total }),
        ...(nextCursor === undefined ? {} : { nextCursor }),
        includeArchived,
        view,
        ...(query ? { query } : {}),
        ...(running === undefined ? {} : { running }),
        ...(mine && ownerId === undefined ? { mine: true } : {}),
        ...(ownerId ? { owner: ownerId } : {}),
        ...(caller?.id ? { caller: caller.id } : {}),
        ...(archivedTotal === undefined ? {} : { archivedTotal, archivedHidden }),
        sessions: rows,
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_read_session(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      assertCallerMay(sessionId, context?.caller)
      const mode = ['tail', 'head', 'outline'].includes(args.mode) ? args.mode : 'tail'
      const roles = Array.isArray(args.roles)
        ? args.roles.filter((role) => role === 'user' || role === 'assistant')
        : []
      // `limit: 0` keeps its old "everything" meaning, bounded by a hard ceiling;
      // the default is a window.
      const requested = Number(args.limit)
      const limit = Number.isFinite(requested) && requested === 0
        ? MAX_ZERO_LIMIT
        : numberArg(args.limit, mode === 'outline' ? 200 : DEFAULT_TRANSCRIPT_WINDOW, { min: 1, max: MAX_READ_LIMIT })
      const read = await readTranscript(sessionId, {
        mode,
        limit,
        ...(Number.isFinite(Number(args.afterSeq)) ? { afterSeq: Number(args.afterSeq) } : {}),
        ...(roles.length ? { roles } : {}),
        maxChars: numberArg(args.maxChars, DEFAULT_MESSAGE_CHARS, { min: 0, max: 200000 }),
      })
      const payload = { ...read, ...(read.owner ? { mine: read.owner.id === context?.caller?.id } : {}) }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_search_sessions(args, context) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) throw new McpError(ERROR_CODES.invalidParams, '"query" must not be empty.')
      const needle = query.toLowerCase()
      const scope = ['title', 'messages', 'both'].includes(args.scope) ? args.scope : 'both'
      const limit = numberArg(args.limit, 10, { min: 1, max: 100 })
      const scan = numberArg(args.scan, 20, { min: 1, max: 200 })
      const snippetChars = numberArg(args.snippetChars, 200, { min: 40, max: 2000 })
      const perSession = numberArg(args.perSession, 2, { min: 1, max: 20 })
      const caller = context?.caller
      const scoped = scopedOwnerFilter(args, caller)
      const mine = scoped.mine
      const ownerId = scoped.ownerId
      const requested = Array.isArray(args.sessionIds) && args.sessionIds.length
        ? new Set(args.sessionIds.map((value) => String(value)))
        : undefined

      // The candidate set is an index page, not the whole Harness: a search is
      // bounded by `scan` so a broad query can never read every transcript.
      const { rows, total } = await listSessionRows(context?.signal, SEARCH_SESSION_WINDOW, {
        includeArchived: args.includeArchived === true,
        caller,
        mineOnly: mine && ownerId === undefined,
        ownerId,
        view: 'full',
      })
      const visible = requested ? rows.filter((row) => requested.has(row.sessionId)) : rows
      const candidates = visible.slice(0, scan)
      const matches = []
      let scanned = 0
      let truncated = false
      for (const row of candidates) {
        if (matches.length >= limit) {
          truncated = true
          break
        }
        scanned += 1
        if (scope !== 'messages') {
          const fields = [['title', row.title], ['cwd', row.cwd], ['owner', row.owner?.name], ['sessionId', row.sessionId]]
          for (const [field, value] of fields) {
            if (typeof value === 'string' && value.toLowerCase().includes(needle)) {
              matches.push({
                sessionId: row.sessionId,
                ...(row.title ? { title: row.title } : {}),
                ...(row.owner ? { owner: row.owner } : {}),
                updatedAt: row.updatedAt,
                where: field,
                snippet: value.length > snippetChars ? `${value.slice(0, snippetChars)}…` : value,
              })
              break
            }
          }
        }
        if (scope === 'title') continue
        let messages
        try {
          assertCallerMay(row.sessionId, caller)
          const transcript = await sessionMessages(row.sessionId)
          messages = transcript.messages
        } catch (error) {
          logger('debug', 'search could not read a transcript', { sessionId: row.sessionId, error: errorText(error) })
          continue
        }
        let perSessionHits = 0
        for (const message of messages) {
          if (perSessionHits >= perSession || matches.length >= limit) break
          const index = message.text.toLowerCase().indexOf(needle)
          if (index === -1) continue
          perSessionHits += 1
          matches.push({
            sessionId: row.sessionId,
            ...(row.title ? { title: row.title } : {}),
            updatedAt: row.updatedAt,
            where: 'message',
            role: message.role,
            seq: message.seq,
            snippet: snippetAround(message.text, index, snippetChars),
          })
        }
        if (matches.length >= limit) truncated = true
      }
      const payload = {
        query,
        scope,
        scanned,
        candidateSessions: visible.length,
        ...(total === undefined ? {} : { visibleSessions: total }),
        matchCount: matches.length,
        ...(truncated ? { truncated: true } : {}),
        matches,
        note: truncated
          ? `Stopped at ${limit} match(es); narrow with a shorter query, owner, sessionIds, or a smaller scan.`
          : `Scanned ${scanned} session transcript(s); raise scan to search further back.`,
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_list_requests(args, context) {
      const caller = context?.caller
      const includeSettled = args.includeSettled === true
      const scan = numberArg(args.scan, DEFAULT_REQUEST_SCAN, { min: 1, max: 200 })
      const limit = numberArg(args.limit, 20, { min: 1, max: 200 })
      const reasonChars = numberArg(args.reasonChars, REQUEST_REASON_CHARS, { min: 40, max: 2000 })
      const single = typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : undefined
      const scoped = scopedOwnerFilter(args, caller)
      const mine = scoped.mine
      const ownerId = scoped.ownerId

      let candidates
      let visibleTotal
      if (single) {
        assertCallerMay(single, caller)
        candidates = [{ sessionId: single }]
      } else {
        const { rows, total } = await listSessionRows(context?.signal, SEARCH_SESSION_WINDOW, {
          includeArchived: args.includeArchived === true,
          caller,
          mineOnly: mine && ownerId === undefined,
          ownerId,
          view: 'index',
        })
        // A blocked turn is what the caller is looking for, so look at running
        // sessions first and only then walk back through recent history.
        const runningFirst = [...rows].sort((left, right) => Number(right.running === true) - Number(left.running === true))
        visibleTotal = total
        candidates = runningFirst.slice(0, scan)
      }

      const sessions = []
      let scanned = 0
      for (const row of candidates) {
        if (sessions.length >= limit) break
        let events
        try {
          assertCallerMay(row.sessionId, caller)
          const transcript = await sessionMessages(row.sessionId)
          events = transcript.events
        } catch (error) {
          logger('debug', 'request scan could not read a session', { sessionId: row.sessionId, error: errorText(error) })
          continue
        }
        scanned += 1
        const folded = foldUserRequests(events, { includeSettled, reasonChars })
        // Requests this endpoint parked are the ones it can answer right now.
        const parkedIds = new Set(parkedList().map((entry) => entry.id))
        const mark = (row, id) => (parkedIds.has(id) ? { ...row, answerable: true } : row)
        folded.approvals = folded.approvals.map((row) => mark(row, row.id))
        folded.questions = folded.questions.map((row) => mark(row, row.callId))
        const pendingCount = folded.approvals.length + folded.questions.length
        const settledCount = folded.settled
          ? folded.settled.approvals.length + folded.settled.questions.length
          : 0
        if (pendingCount === 0 && settledCount === 0) continue
        sessions.push({
          sessionId: row.sessionId,
          ...(row.title ? { title: row.title } : {}),
          ...(row.running === undefined ? {} : { running: row.running }),
          ...(row.owner ? { owner: row.owner } : {}),
          pending: {
            count: pendingCount,
            ...(folded.approvals.length ? { approvals: folded.approvals } : {}),
            ...(folded.questions.length ? { questions: folded.questions } : {}),
          },
          ...(includeSettled ? { settled: folded.settled } : {}),
        })
      }

      const payload = {
        count: sessions.length,
        scanned,
        ...(visibleTotal === undefined ? {} : { visibleSessions: visibleTotal }),
        ...(includeSettled ? { includeSettled: true } : {}),
        sessions,
        note: sessions.length
          ? 'These are audit events the model never sees: a session that stops progressing is usually blocked on one. Rows marked answerable are parked by this endpoint and can be settled with dsh_answer_request; the rest are decided in the Harness GUI.'
          : `No session among the ${scanned} inspected (running first) is waiting on a user decision.`,
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_answer_request(args, context) {
      const requestId = typeof args.requestId === 'string' ? args.requestId.trim() : ''
      if (!requestId) throw new McpError(ERROR_CODES.invalidParams, '"requestId" is required; list ids with dsh_list_requests.')
      if (!answerUserRequests) {
        throw new McpError(
          ERROR_CODES.invalidParams,
          'This endpoint does not answer user requests. Set "answerUserRequests: true" on the dsh-mcp-server row and restart DSH, then answer ids reported as answerable; until then decisions stay in the Harness GUI.',
        )
      }
      // Accept either the audit id the log carries or the tool call id a caller may
      // be holding: both identify the same parked decision.
      const parked = parkedRequests.get(requestId)
        ?? parkedList().find((entry) => entry.callId === requestId)
      if (!parked) {
        throw new McpError(
          ERROR_CODES.invalidParams,
          `No live request "${requestId}": it is already decided, it was never parked (another answerer owns that session), or the ceiling expired. Call dsh_list_requests for what is waiting now.`,
        )
      }
      assertCallerMay(parked.sessionId, context?.caller)

      if (parked.kind === 'approval') {
        const outcome = args.decision === 'allow' ? 'allowed-once' : args.decision === 'deny' ? 'rejected' : undefined
        if (!outcome) {
          throw new McpError(ERROR_CODES.invalidParams, 'An approval needs "decision": "allow" (one-shot grant) or "deny".')
        }
        if (context?.authority?.internal) assertMaySettleApproval(context.authority)
        releaseParked(parked, outcome)
        const payload = {
          requestId,
          sessionId: parked.sessionId,
          kind: 'approval',
          outcome,
          ...(parked.toolName ? { toolName: parked.toolName } : {}),
        }
        return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
      }

      const answers = Array.isArray(args.answers) ? args.answers : undefined
      if (!answers || !answers.length) {
        throw new McpError(ERROR_CODES.invalidParams, 'A question needs "answers": [{ "id", "selected": [...] }], one entry per question.')
      }
      const normalized = answers.map((answer) => ({
        id: String(answer?.id ?? ''),
        selected: Array.isArray(answer?.selected) ? answer.selected.map(String) : [],
        ...(typeof answer?.custom === 'string' ? { custom: answer.custom } : {}),
      }))
      const unanswered = (parked.questions ?? [])
        .filter((question) => question.id && !normalized.some((answer) => answer.id === question.id))
        .map((question) => question.id)
      if (unanswered.length) {
        throw new McpError(ERROR_CODES.invalidParams, `Every question needs an answer; missing: ${unanswered.join(', ')}.`)
      }
      releaseParked(parked, { answers: normalized })
      const payload = { requestId, sessionId: parked.sessionId, kind: 'question', answers: normalized }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_wait_session(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      assertCallerMay(sessionId, context?.caller)
      const waited = await waitForTurn(sessionId, {
        timeoutMs: numberArg(args.timeoutMs, turnTimeoutMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
        limit: numberArg(args.limit, 0, { min: 0, max: 5000 }),
        signal: context?.signal,
      })
      const owner = ownerSummary(sessionId)
      const payload = { ...waited, ...(owner ? { owner, mine: owner.id === context?.caller?.id } : {}) }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_whoami(args, context) {
      const client = describeCaller(context?.caller)
      const limit = numberArg(args.limit, 20, { min: 0, max: 200 })
      const owned = sessionOwners?.sessionsOf(client.id) ?? []
      const payload = {
        client,
        ownedSessionCount: owned.length,
        ...(limit > 0 ? {
          ownedSessions: owned.slice(0, limit).map((entry) => ({
            sessionId: entry.sessionId,
            ...(entry.cwd ? { cwd: entry.cwd } : {}),
            ...(entry.agentPreset ? { agentPreset: entry.agentPreset } : {}),
            ...(entry.adopted ? { adopted: true } : {}),
            ...(entry.createdAt ? { createdAt: new Date(entry.createdAt).toISOString() } : {}),
          })),
        } : {}),
        ...(sessionOwners ? { clientsSeen: sessionOwners.clientCount } : {}),
        note: "Attribution only: callers share this endpoint's token, so the label is what the client sends.",
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_open_session(args, context) {
      const sessionId = String(args.sessionId ?? '').trim()
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      if (typeof openSession !== 'function') {
        throw new McpError(
          ERROR_CODES.internalError,
          'This deployment composes no Web GUI, so no page can be asked to open a session.',
        )
      }
      assertCallerMay(sessionId, context?.caller)
      // A session the Harness cannot resolve would open an empty view; refuse it
      // here, where the caller can still fix the id.
      const registry = ctx.get('workspaceRegistry')
      if (typeof registry?.sessionKnown === 'function') {
        let known
        try {
          known = await registry.sessionKnown(sessionId)
        } catch {
          known = undefined
        }
        if (known === false) {
          throw new McpError(
            ERROR_CODES.invalidParams,
            `Unknown session "${sessionId}": pass an id from dsh_list_sessions or dsh_run_prompt.`,
          )
        }
      }
      const queued = await openSession(sessionId, { caller: context?.caller })
      const payload = {
        sessionId,
        queued: queued !== false,
        note: 'The open Harness page opens this session within a couple of seconds; no page means no consumer.',
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_cancel_session(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      assertCallerMay(sessionId, context?.caller)
      const controller = requireService(ctx, 'sessionController')
      try {
        controller.cancel({ sessionId })
      } catch (error) {
        throw new McpError(ERROR_CODES.invalidParams, `Session "${sessionId}" could not be cancelled: ${errorText(error)}`)
      }
      return { text: JSON.stringify({ sessionId, status: 'cancel-requested' }) }
    },

    async dsh_archive_session(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      assertCallerMay(sessionId, context?.caller)
      const registry = requireService(ctx, 'workspaceRegistry')
      const stopActivity = args.stopActivity === true
      try {
        await registry.archiveSession(sessionId, stopActivity ? { stopActivity: true } : undefined)
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        const message = errorText(error)
        if (/ActiveSession/.test(name) || /running work|still active/i.test(message)) {
          throw new McpError(
            ERROR_CODES.invalidParams,
            `Session "${sessionId}" still has running work; retry with stopActivity: true to archive it and stop that work (${message}).`,
          )
        }
        throw new McpError(ERROR_CODES.invalidParams, `Session "${sessionId}" could not be archived: ${message}`)
      }
      const payload = { sessionId, archived: true, stoppedActivity: stopActivity }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_unarchive_session(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      assertCallerMay(sessionId, context?.caller)
      const registry = requireService(ctx, 'workspaceRegistry')
      try {
        await registry.unarchiveSession(sessionId)
      } catch (error) {
        throw new McpError(
          ERROR_CODES.invalidParams,
          `Session "${sessionId}" could not be unarchived: ${errorText(error)}`,
        )
      }
      const payload = { sessionId, archived: false }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_list_permission_presets() {
      const catalog = readPermissionCatalog()
      if (!catalog) {
        throw new McpError(
          ERROR_CODES.internalError,
          'The DeepSeek Harness service "permissionPresets" is unavailable in this deployment, so no permission presets can be listed.',
        )
      }
      const payload = {
        defaultPreset: catalog.defaultPreset,
        count: catalog.options.length,
        presets: catalog.options,
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_list_tools(args = {}, context) {
      const tools = requireService(ctx, 'tools')
      const schemas = typeof tools.schemas === 'function' ? tools.schemas() : []
      const all = (Array.isArray(schemas) ? schemas : []).map((schema) => ({
        name: schema?.name ?? schema?.function?.name,
        description: schema?.description ?? schema?.function?.description,
      })).filter((entry) => entry.name)
      const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined
      const needle = query?.toLowerCase()
      const matched = needle
        ? all.filter((entry) => `${entry.name} ${entry.description ?? ''}`.toLowerCase().includes(needle))
        : all
      const limit = numberArg(args.limit, 0, { min: 0, max: 5000 })
      const shown = limit > 0 ? matched.slice(0, limit) : matched
      const payload = {
        count: shown.length,
        total: all.length,
        ...(shown.length < matched.length ? { truncated: true } : {}),
        ...(query ? { query } : {}),
        tools: shown,
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_status(args, context) {
      const payload = await status(context?.caller)
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },
  }

  return {
    tools: TOOL_DEFINITIONS,
    /** Dispatch one MCP tool call. */
    async callTool(name, args, context) {
      const handler = handlers[name]
      if (!handler) {
        throw new McpError(ERROR_CODES.invalidParams, `Unknown tool: ${name}`, { unknownTool: true })
      }
      return handler(args ?? {}, internalContext(context))
    },
    /** The delivery policy in force right now (`deliveryMode(undefined)`). */
    effectiveDeliveryMode: () => deliveryMode(undefined),
    listResources,
    listResourceTemplates,
    /** Read one `dsh://` resource. */
    async readResource(uri, context) {
      if (uri === 'dsh://status') {
        return { text: JSON.stringify(await status(context?.caller), null, 2), mimeType: 'application/json' }
      }
      if (uri === 'dsh://sessions') {
        const { rows, archivedTotal, archivedHidden } = await listSessionRows(undefined, 50, {
          caller: context?.caller,
          mineOnly: restrictToOwner,
          view: 'full',
        })
        const payload = {
          count: rows.length,
          ...(archivedTotal === undefined ? {} : { archivedTotal, archivedHidden }),
          sessions: rows,
        }
        return { text: JSON.stringify(payload, null, 2), mimeType: 'application/json' }
      }
      const match = /^dsh:\/\/session\/(.+)$/.exec(uri)
      if (match) {
        let sessionId
        try {
          sessionId = decodeURIComponent(match[1])
        } catch {
          throw new McpError(ERROR_CODES.invalidParams, `Malformed session id in resource URI: ${uri}`)
        }
        assertCallerMay(sessionId, context?.caller)
        return { text: JSON.stringify(await readTranscript(sessionId, { limit: 20, maxChars: 4000 }), null, 2), mimeType: 'application/json' }
      }
      throw new McpError(ERROR_CODES.resourceNotFound, `Unknown resource: ${uri}`)
    },
    status,
  }
}