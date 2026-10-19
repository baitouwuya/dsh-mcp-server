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

import { ERROR_CODES, McpError } from './protocol.js'
import { groupSession } from './workspace-grouping.js'

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
  'Set a session\'s sandbox/approval permission preset with the `permissionPreset` argument on',
  '`dsh_run_prompt`/`dsh_continue_session`; list the available presets with',
  '`dsh_list_permission_presets`. A session created without one keeps the deployment default.',
  'Run a slash command in a session with `dsh_run_command` (for example `/compact` to compact history,',
  'or `/permission danger-full-access`) and see what that session can run with `dsh_list_commands`;',
  'a command executes immediately without a model turn, and availability is per agent preset, so list first.',
].join('\n')

/** Default per-turn ceiling for a tool call that waits for completion. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000

/** Sessions this MCP endpoint will start concurrently when waiting is requested. */
export const DEFAULT_MAX_CONCURRENT_TURNS = 8

/** Default transcript window: a read is a window, not a dump. */
const DEFAULT_TRANSCRIPT_WINDOW = 10

/** Default per-message character cap for a read; 0 disables it. */
const DEFAULT_MESSAGE_CHARS = 2000

/** Characters of a message kept in an outline row (its first line, normally). */
const OUTLINE_PREVIEW_CHARS = 120

/** How many listed sessions are probed for a title match before titles are given up on. */
const TITLE_QUERY_CANDIDATES = 200

/** How many visible sessions one search is willing to look at. */
const SEARCH_SESSION_WINDOW = 200

/** The Harness tool whose calls become user questions. */
const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/** Characters of an approval reason kept in a listing; the rest is elided. */
const REQUEST_REASON_CHARS = 240

/** How many sessions one `dsh_list_requests` scan inspects by default. */
const DEFAULT_REQUEST_SCAN = 20

/** How long an approval or question waits for an MCP answer before failing closed. */
const DEFAULT_REQUEST_ANSWER_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Sandbox modes ordered from narrowest to widest.
 *
 * This ladder is the authority vocabulary for the tools DSH itself calls: an
 * internal caller may grant at most the rung it already stands on.
 */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/** Rank of one sandbox mode on {@link SANDBOX_MODES}; `undefined` when unknown. */
export function sandboxRank(mode) {
  const index = SANDBOX_MODES.indexOf(mode)
  return index < 0 ? undefined : index
}

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

/** Convert an arbitrary failure into a model-readable message. */
function messageOf(error) {
  if (error instanceof Error) {
    const code = error.code ?? error.name
    return error.message ? `${error.message}${code && error.message !== code ? ` (${code})` : ''}` : String(code)
  }
  return String(error)
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

/** Join the text blocks of one durable message. */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** Read `{ role, text }` rows out of one raw session event, or `undefined`. */
function messageOfEvent(event) {
  if (!event || typeof event !== 'object') return undefined
  if (event.type === 'user/message') {
    // The Harness also records injected context as user messages; only a real
    // user-authored prompt carries the `user` source kind.
    if (event.data?.source?.kind !== 'user') return undefined
    const text = textOfContent(event.data?.content)
    return text ? { role: 'user', text } : undefined
  }
  if (event.type === 'assistant/message') {
    const text = textOfContent(event.data?.message?.content)
    return text ? { role: 'assistant', text } : undefined
  }
  return undefined
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
    groupSessions = true,
    createGroups = false,
    busyMode = 'setting',
  } = options

  let activeTurns = 0

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

  /** The sandbox mode one session runs under right now, or `undefined`. */
  function sessionSandboxMode(session) {
    const policy = ctx.get('sandboxPolicy')
    if (typeof policy?.resolve !== 'function') return undefined
    try {
      return policy.resolve(session === undefined ? {} : { session })?.mode
    } catch (error) {
      logger('debug', 'sandbox policy lookup failed', { error: messageOf(error) })
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
      logger('debug', 'permission preset lookup failed', { error: messageOf(error) })
    }
    const mode = sessionSandboxMode(session)
    return {
      internal: true,
      ...(session?.header?.id ? { sessionId: session.header.id } : {}),
      ...(agent?.id ? { agentId: agent.id } : {}),
      mode,
      rank: sandboxRank(mode),
      ...(typeof preset === 'string' && preset ? { preset } : {}),
    }
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
   * The deployment's own Enter-key behaviour for a busy session.
   *
   * `ui-conversation.busyEnter` is the setting the Web composer obeys. A caller
   * that names no mode follows it rather than inventing a second policy, so
   * "send this session a message" behaves the way the user's own Enter does.
   */
  function deploymentBusyEnter() {
    const editor = ctx.get('configEditor')
    if (typeof editor?.entries !== 'function') return undefined
    try {
      const rows = [...(editor.entries() ?? [])]
      const row = rows.find((entry) => entry?.options?.id === 'ui-conversation')
        ?? rows.find((entry) => entry?.options?.name === '@deepseek-ai/dsh-client-ui-conversation')
      const value = row?.options?.config?.busyEnter
      return value === 'steer' || value === 'queue' ? value : undefined
    } catch (error) {
      logger('debug', 'busy-enter lookup failed', { error: messageOf(error) })
      return undefined
    }
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
    return deploymentBusyEnter() ?? 'queue'
  }

  /**
   * Build one identified user-role message, exactly as the Harness does.
   *
   * Rebuilt here rather than imported: the bundle stays dependency-free, and the
   * shape is the published contract (`role`, `content`, `source`, fresh `id`).
   */
  function createUserMessage({ content, source }) {
    return { role: 'user', content, source, id: randomUUID() }
  }

  /**
   * The durable attribution an internal caller's message carries.
   *
   * A message sent by another DSH session must not read as the user typing:
   * the source names this endpoint and the sending session.
   */
  function internalMessageSource(authority) {
    return {
      kind: 'dsh-mcp-server',
      ...(authority?.sessionId ? { sessionId: authority.sessionId } : {}),
      ...(authority?.agentId ? { agentId: authority.agentId } : {}),
    }
  }

  /** Resolve one session's live Agent so a labelled message can be queued on it. */
  async function resolveAgentHandle(sessionId) {
    const controller = ctx.get('sessionController')
    if (typeof controller?.resolveAgent !== 'function') return undefined
    try {
      const resolved = await controller.resolveAgent(sessionId)
      if (resolved?.error) return undefined
      return resolved?.agent
    } catch (error) {
      logger('debug', 'agent resolution failed', { sessionId, error: messageOf(error) })
      return undefined
    }
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
    if (!agent) return context
    const caller = sessionOwners ? sessionOwners.touch(internalCallerOf(agent)) : internalCallerOf(agent)
    return { ...context, caller, authority: authorityOf(agent), internal: true }
  }

  /** A short window of text around a match, with ellipses where it was cut. */
  function snippetAround(text, index, chars) {
    const start = Math.max(0, index - 60)
    const end = Math.min(text.length, start + chars)
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
  }

  /** Elide a long approval reason so a listing stays readable. */
  function truncateReason(reason, chars = REQUEST_REASON_CHARS) {
    if (typeof reason !== 'string') return undefined
    return reason.length > chars ? reason.slice(0, chars) + '…' : reason
  }

  /** Parse one recorded `ask_user_question` argument text into service-shaped questions. */
  function questionsOf(argumentsValue) {
    let parsed
    try {
      parsed = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue
    } catch {
      return undefined
    }
    const list = Array.isArray(parsed?.questions) ? parsed.questions : undefined
    if (!list) return undefined
    const rows = []
    for (const question of list) {
      if (!question || typeof question.id !== 'string' || typeof question.question !== 'string') continue
      rows.push({
        id: question.id,
        question: question.question,
        ...(typeof question.header === 'string' ? { header: question.header } : {}),
        ...(Array.isArray(question.options)
          ? {
            options: question.options
              .filter((option) => option && typeof option.label === 'string')
              .map((option) => ({
                label: option.label,
                ...(typeof option.description === 'string' ? { description: option.description } : {}),
              })),
          }
          : {}),
        ...(question.multi_select === true ? { multiSelect: true } : {}),
      })
    }
    return rows.length ? rows : undefined
  }

  /** First JSON text block of a recorded content array, parsed; `undefined` when unreadable. */
  function parsedResult(content) {
    const blocks = Array.isArray(content) ? content : []
    const text = blocks.find((block) => block?.type === 'text')
    if (!text || typeof text.text !== 'string') return undefined
    try {
      return JSON.parse(text.text)
    } catch {
      return undefined
    }
  }

  /**
   * Fold a session log into the user decisions it is waiting on.
   *
   * Approvals come from the `approval/asked` / `approval/decided` audit pair; questions
   * from `ask_user_question` calls that no answer batch, error, or late reply has settled
   * yet. These are the same events the Harness GUI folds into its cards — and exactly the
   * ones the model never sees, which is why a delegated session can look stuck.
   *
   * @param events - session log events in append order.
   * @param options - `{ includeSettled, reasonChars }`.
   */
  function foldUserRequests(events, { includeSettled = false, reasonChars = REQUEST_REASON_CHARS } = {}) {
    const approvals = new Map()
    const questions = new Map()
    const settledApprovals = []
    const settledQuestions = []
    for (const event of events ?? []) {
      const data = event?.data ?? {}
      if (event?.type === 'approval/asked') {
        if (typeof data.id !== 'string') continue
        approvals.set(data.id, {
          id: data.id,
          ...(typeof data.toolName === 'string' ? { toolName: data.toolName } : {}),
          ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
          ...(typeof data.reason === 'string' ? { reason: truncateReason(data.reason, reasonChars) } : {}),
          seq: Number(event.seq),
        })
        continue
      }
      if (event?.type === 'approval/decided') {
        if (typeof data.id !== 'string') continue
        const asked = approvals.get(data.id)
        approvals.delete(data.id)
        if (includeSettled) {
          settledApprovals.push({
            id: data.id,
            ...(typeof data.outcome === 'string' ? { outcome: data.outcome } : {}),
            ...(asked?.toolName ? { toolName: asked.toolName } : {}),
            seq: Number(event.seq),
          })
        }
        continue
      }
      if (event?.type === 'tool/call' && data.name === ASK_USER_QUESTION_TOOL) {
        const questionsOfCall = questionsOf(data.arguments)
        if (!questionsOfCall || typeof data.callId !== 'string') continue
        questions.set(data.callId, {
          callId: data.callId,
          state: 'open',
          questions: questionsOfCall,
          seq: Number(event.seq),
        })
        continue
      }
      // PTC agents reach the tool through their own dispatcher, which logs a *start*
      // before any answer exists: that start is the only durable trace of a question
      // still blocking the turn, so it has to open the entry.
      if (event?.type === 'tool/ptc-dispatch-start' && data.name === ASK_USER_QUESTION_TOOL) {
        const callId = typeof data.subCallId === 'string' ? data.subCallId : undefined
        const questionsOfCall = questionsOf(data.arguments)
        if (!callId || !questionsOfCall) continue
        questions.set(callId, { callId, state: 'open', questions: questionsOfCall, seq: Number(event.seq) })
        continue
      }
      if (event?.type === 'tool/ptc-dispatch' && data.name === ASK_USER_QUESTION_TOOL) {
        const callId = typeof data.subCallId === 'string' ? data.subCallId : undefined
        const open = callId ? questions.get(callId) : undefined
        const parsed = parsedResult(data.content)
        const questionsOfCall = open?.questions ?? questionsOf(data.arguments)
        if (parsed?.pending === true) {
          if (callId && questionsOfCall) {
            questions.set(callId, { callId, state: 'continued', questions: questionsOfCall, seq: Number(event.seq) })
          }
          continue
        }
        if (!callId || !open) continue
        const answers = data.isError !== true && Array.isArray(parsed?.answers) ? parsed.answers : undefined
        questions.delete(callId)
        if (includeSettled && answers) settledQuestions.push({ callId, answers, seq: Number(event.seq) })
        continue
      }
      if (event?.type === 'tool/result') {
        const callId = data.message?.toolCallId
        const open = typeof callId === 'string' ? questions.get(callId) : undefined
        if (!open) continue
        const parsed = parsedResult(data.message?.content)
        if (parsed?.pending === true || data.error?.code === 'TOOL_OUTCOME_UNKNOWN') {
          questions.set(callId, { ...open, state: 'continued' })
          continue
        }
        const answers = data.error === undefined && data.message?.isError !== true && Array.isArray(parsed?.answers)
          ? parsed.answers
          : undefined
        questions.delete(callId)
        if (includeSettled && answers) settledQuestions.push({ callId, answers, seq: Number(event.seq) })
        continue
      }
      if (event?.type === 'user/message' && data.source?.kind === 'user-question-reply') {
        const callId = data.source?.callId
        if (typeof callId !== 'string' || !questions.has(callId)) continue
        const parsed = parsedResult(data.content)
        const answers = Array.isArray(parsed?.answers) ? parsed.answers : []
        questions.delete(callId)
        if (includeSettled) settledQuestions.push({ callId, answers, seq: Number(event.seq) })
      }
    }
    return {
      approvals: [...approvals.values()],
      questions: [...questions.values()],
      ...(includeSettled ? { settled: { approvals: settledApprovals, questions: settledQuestions } } : {}),
    }
  }

  /** Compact pending-decision summary for read/wait payloads. */
  function pendingSummary(requests) {
    return {
      count: requests.approvals.length + requests.questions.length,
      ...(requests.approvals.length ? { approvals: requests.approvals } : {}),
      ...(requests.questions.length ? { questions: requests.questions } : {}),
    }
  }

    /** Requests parked for an MCP caller to answer, keyed by the id `dsh_list_requests` reports. */
  const parkedRequests = new Map()

  /** Close out one parked request; resolves its promise and clears the timer. */
  function releaseParked(entry, value) {
    if (!entry || entry.settled) return
    entry.settled = true
    if (entry.timer) clearTimeout(entry.timer)
    parkedRequests.delete(entry.id)
    entry.resolve(value)
  }

  /**
   * Park one live user request until an MCP caller answers it.
   *
   * The entry stays visible to `dsh_list_requests` (which marks it `answerable`) for
   * as long as the turn is blocked on it, and is released by `dsh_answer_request`, by
   * the request's own abort signal, or by the answer ceiling.
   */
  function parkRequest(entry, { signal } = {}) {
    const parked = { ...entry, settled: false, createdAt: Date.now() }
    parked.promise = new Promise((resolve) => { parked.resolve = resolve })
    parked.timer = setTimeout(() => releaseParked(parked, undefined), Math.max(1000, requestAnswerTimeoutMs))
    parked.timer.unref?.()
    if (signal) {
      const onAbort = () => releaseParked(parked, undefined)
      signal.addEventListener('abort', onAbort, { once: true })
      parked.cleanup = () => signal.removeEventListener('abort', onAbort)
    }
    parkedRequests.set(entry.id, parked)
    return parked
  }

  /** Pending parked requests, newest first, for listings. */
  function parkedList() {
    return [...parkedRequests.values()].sort((left, right) => right.createdAt - left.createdAt)
  }

  /** The audit id of the newest undecided `approval/asked` for one tool call. */
  async function approvalIdFor(sessionId, callId) {
    if (!callId) return undefined
    try {
      const { events } = await sessionMessages(sessionId)
      const folded = foldUserRequests(events)
      return folded.approvals.find((row) => row.callId === callId)?.id
    } catch (error) {
      logger('debug', 'could not resolve the approval id', { sessionId, error: messageOf(error) })
      return undefined
    }
  }

  /** The durable id of the newest unanswered user question in one session. */
  async function questionIdFor(sessionId) {
    try {
      const { events } = await sessionMessages(sessionId)
      const folded = foldUserRequests(events)
      return folded.questions[folded.questions.length - 1]?.callId
    } catch (error) {
      logger('debug', 'could not resolve the question id', { sessionId, error: messageOf(error) })
      return undefined
    }
  }

  /**
   * Whether this endpoint answers a request for that session.
   *
   * By default only sessions an MCP caller created (or adopted) are answered, so the
   * GUI keeps every other card; `answerOwnedSessionsOnly: false` takes them all.
   */
  function answersSession(sessionId) {
    if (!answerUserRequests) return false
    if (!answerOwnedSessionsOnly) return true
    return Boolean(sessionId && sessionOwners?.ownerOf(sessionId))
  }

  /** Park an approval request and race it against the deployment's other answerers. */
  async function answerApproval(request, next) {
    const sessionId = request?.agent?.session?.id
    if (!answersSession(sessionId)) return next()
    const callId = typeof request.callId === 'string' ? request.callId : undefined
    const id = (await approvalIdFor(sessionId, callId)) ?? (callId ? `approval:${callId}` : `approval:${sessionId}:${Date.now()}`)
    const parked = parkRequest({
      id,
      kind: 'approval',
      sessionId,
      ...(callId ? { callId } : {}),
      ...(typeof request.toolName === 'string' ? { toolName: request.toolName } : {}),
      ...(typeof request.reason === 'string' ? { reason: truncateReason(request.reason) } : {}),
    }, { signal: request.signal })
    // Let every other answerer (the GUI card, a composed terminal answerer) work in
    // parallel: whoever decides first wins, and the caller keeps the rest of the race.
    const downstream = Promise.resolve().then(() => next()).then(
      (value) => ({ value }),
      () => ({ value: 'unavailable' }),
    )
    const first = await Promise.race([
      parked.promise.then((value) => ({ from: 'caller', value })),
      downstream.then((settled) => ({ from: 'downstream', value: settled.value })),
    ])
    parked.cleanup?.()
    if (first.from === 'caller' && first.value !== undefined) return first.value
    if (first.from === 'downstream' && first.value !== 'unavailable') {
      releaseParked(parked, undefined)
      return first.value
    }
    // Nothing downstream could decide: keep waiting for the MCP caller, then fail closed.
    const late = await parked.promise
    return late ?? first.value ?? 'unavailable'
  }

  /** Park a user question and race it against the deployment's other answerers. */
  async function answerQuestion(request, next) {
    const sessionId = request?.agent?.session?.id
    if (!answersSession(sessionId)) return next()
    // A timed question carries its call id on the request; a plain blocking one does
    // not, so the durable sub-call id is resolved from the log — that is the id
    // dsh_list_requests reports and the one dsh_answer_request has to accept.
    const waitCallId = typeof request?.wait?.callId === 'string' ? request.wait.callId : undefined
    const callId = waitCallId ?? (await questionIdFor(sessionId))
    const id = callId ?? `question:${sessionId}:${Date.now()}`
    const questions = Array.isArray(request.questions)
      ? request.questions.map((question) => ({
        id: question?.id,
        question: question?.question,
        ...(typeof question?.header === 'string' ? { header: question.header } : {}),
        ...(Array.isArray(question?.options)
          ? { options: question.options.map((option) => ({ label: option?.label })) }
          : {}),
      }))
      : []
    const parked = parkRequest({ id, kind: 'question', sessionId, ...(callId ? { callId } : {}), questions }, { signal: request.signal })
    const downstream = Promise.resolve().then(() => next()).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    const first = await Promise.race([
      parked.promise.then((value) => ({ from: 'caller', value })),
      downstream,
    ])
    parked.cleanup?.()
    if (first.from === 'caller' && first.value !== undefined) return first.value
    if (first.error === undefined) {
      releaseParked(parked, undefined)
      return first.value
    }
    // No answerer accepted it: hold the question for the MCP caller, else report it.
    const late = await parked.promise
    if (late !== undefined) return late
    throw first.error
  }

  // Composed only when asked for: answering a request is a permission decision, so the
  // endpoint stays a reporter unless the profile opts in.
  if (answerUserRequests) {
    try {
      ctx.on('approval/request', (request, next) => answerApproval(request, next), { prepend: true })
      ctx.on('user-questions/request', (request, next) => answerQuestion(request, next), { prepend: true })
      logger('info', 'answering user requests over MCP', {
        timeoutMs: requestAnswerTimeoutMs,
        ownedSessionsOnly: answerOwnedSessionsOnly,
      })
    } catch (error) {
      logger('warn', 'could not register the user-request answerers', { error: messageOf(error) })
    }
  }

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
      logger('debug', 'permission catalog read failed', { error: messageOf(error) })
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
      logger('debug', 'command list failed', { error: messageOf(error) })
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
        `Permission preset "${name}" could not be applied to session "${sessionId}": ${messageOf(error)}.${hint}`,
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
      logger('debug', 'title lookup failed', { error: messageOf(error) })
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

  /** Raw transcript of one session: message rows plus the last durable preset. */
  async function sessionMessages(sessionId) {
    const sessionQuery = requireService(ctx, 'sessionQuery')
    let snapshot
    try {
      snapshot = await sessionQuery.readSession(sessionId)
    } catch (error) {
      throw new McpError(ERROR_CODES.invalidParams, `Session "${sessionId}" could not be read: ${messageOf(error)}`)
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const messages = []
    let permissionPreset
    for (const event of events) {
      const message = messageOfEvent(event)
      if (message) messages.push({ role: message.role, text: message.text, seq: Number(event.seq) })
      // The last durable permission selection; the same event the GUI's
      // `/permission` command appends, so a reader can verify what was applied.
      if (event?.type === 'permission/preset' && typeof event.data?.preset === 'string') {
        permissionPreset = event.data.preset
      }
    }
    return { snapshot, events, messages, permissionPreset }
  }

  /**
   * Progressive transcript read for one session.
   *
   * The log of a long session is megabytes, so a read is a window, not a dump:
   * `mode` picks the tail, the head, or an outline of every turn; `roles` and
   * `afterSeq` narrow it; `maxChars` caps each message so one huge answer cannot
   * flood the caller. The payload always reports how much was left out.
   *
   * @param sessionId - the DSH session.
   * @param options - `{ mode, limit, afterSeq, roles, maxChars }`.
   */
  async function readTranscript(sessionId, options = {}) {
    const {
      mode = 'tail',
      limit = DEFAULT_TRANSCRIPT_WINDOW,
      afterSeq,
      roles,
      maxChars = DEFAULT_MESSAGE_CHARS,
    } = options
    const { snapshot, events, messages: all, permissionPreset } = await sessionMessages(sessionId)
    const pending = pendingSummary(foldUserRequests(events))

    const wantedRoles = Array.isArray(roles) && roles.length ? new Set(roles) : undefined
    let matched = wantedRoles ? all.filter((row) => wantedRoles.has(row.role)) : all
    if (Number.isFinite(afterSeq)) matched = matched.filter((row) => row.seq > afterSeq)
    const cursor = Number.isFinite(afterSeq) ? Number(afterSeq) : undefined

    const windowed = mode === 'head' || mode === 'outline'
      ? matched.slice(0, limit)
      : matched.slice(-limit)

    let truncatedMessages = 0
    // An outline row is a table-of-contents line: the first line of the message,
    // shortened by `maxChars` when the caller asks for a smaller index.
    const outlinePreview = maxChars > 0 ? Math.min(OUTLINE_PREVIEW_CHARS, maxChars) : OUTLINE_PREVIEW_CHARS
    const rows = mode === 'outline'
      ? windowed.map((row) => ({
        role: row.role,
        seq: row.seq,
        chars: row.text.length,
        preview: row.text.split('\n', 1)[0].slice(0, outlinePreview),
      }))
      : windowed.map((row) => {
        const tooLong = maxChars > 0 && row.text.length > maxChars
        if (tooLong) truncatedMessages += 1
        return {
          role: row.role,
          text: tooLong ? row.text.slice(0, maxChars) : row.text,
          seq: row.seq,
          ...(tooLong ? { truncated: true, chars: row.text.length } : {}),
        }
      })

    const firstSeq = rows.length ? rows[0].seq : undefined
    const lastSeq = rows.length ? rows[rows.length - 1].seq : undefined
    const endSeq = matched.length ? matched[matched.length - 1].seq : undefined
    const owner = ownerSummary(sessionId)
    return {
      sessionId,
      cwd: snapshot?.session?.cwd,
      agentPreset: snapshot?.session?.agentPreset,
      ...(owner ? { owner } : {}),
      ...(permissionPreset === undefined ? {} : { permissionPreset }),
      createdAt: snapshot?.session?.createdAt
        ? new Date(Number(snapshot.session.createdAt)).toISOString()
        : undefined,
      mode,
      totalMessages: all.length,
      matchedMessages: matched.length,
      returned: rows.length,
      ...(wantedRoles ? { roles: [...wantedRoles] } : {}),
      window: {
        ...(cursor === undefined ? {} : { afterSeq: cursor }),
        ...(firstSeq === undefined ? {} : { firstSeq, lastSeq }),
        nextAfterSeq: lastSeq ?? cursor ?? null,
        reachedEnd: endSeq === undefined || lastSeq === endSeq,
      },
      ...(pending.count ? { pending } : {}),
      ...(truncatedMessages
        ? {
          truncatedMessages,
          note: `${truncatedMessages} message(s) were cut at ${maxChars} characters; pass maxChars: 0 for the full text or read the message by seq.`,
        }
        : {}),
      messages: rows,
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
    if (!create) {
      try {
        targetSession = await resolveLiveSession(sessionId)
      } catch (error) {
        // The prompt itself reports a session that cannot be resolved.
        targetSession = undefined
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
      const selection = create ? (model ?? defaultModel) : model
      if (selection?.provider && selection?.model) {
        await controller.selectModel({
          sessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        })
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
              error: messageOf(error),
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
        `DeepSeek Harness rejected the prompt for session "${sessionId}": ${messageOf(error)}`,
      )
    }

    if (!wait) {
      return { sessionId, status: 'started', text: '', requestId, ...appliedPermission, ...deliveryPayload(), ...(workspace ? { workspace } : {}) }
    }

    const release = await acquireTurnSlot(signal)
    const timeoutSignal = AbortSignal.timeout(Math.max(1000, timeoutMs))
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    let outcome
    try {
      outcome = await followToTurnEnd(sessionId, { beforeSeq, signal: combined })
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
  async function followToTurnEnd(sessionId, { beforeSeq, signal }) {
    const controller = requireService(ctx, 'sessionController')
    const texts = []
    let endReason
    let interrupted = false
    try {
      const stream = controller.follow(
        { address: { kind: 'session', sessionId } },
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
          const message = messageOfEvent(event)
          if (message) texts.push(message.text)
        } else if (event.type === 'turn/end') {
          endReason = event.data?.reason?.kind ?? 'completed'
          break
        }
      }
    } catch (error) {
      const aborted = signal?.aborted || error?.name === 'AbortError'
      if (!aborted) {
        logger('warn', 'follow failed', { sessionId, error: messageOf(error) })
        throw new McpError(ERROR_CODES.internalError, `Following session "${sessionId}" failed: ${messageOf(error)}`)
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
      logger('debug', 'session state lookup failed', { sessionId, error: messageOf(error) })
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
        logger('debug', 'tail read after wait failed', { sessionId, error: messageOf(error) })
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
        logger('debug', 'pending read after wait failed', { sessionId, error: messageOf(error) })
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
      logger('debug', 'status count failed', { error: messageOf(error) })
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
      defaultModel: defaultModel ?? null,
      ...(caller?.id ? { caller: describeCaller(caller) } : {}),
      ...(sessionOwners ? { clients: { seen: sessionOwners.clientCount, sessions: sessionOwners.sessionCount } } : {}),
      ...(catalog ? { defaultPermissionPreset: catalog.defaultPreset, permissionPresets: catalog.options } : {}),
      toolNames: TOOL_DEFINITIONS.map((tool) => tool.name),
      ...(typeof dshTools === 'function' ? { dshTools: dshTools() } : {}),
      // What a continued prompt will do when the session is busy, so a caller
      // can see which policy this deployment follows.
      ...(typeof busyMode === 'string' ? { busyMode: { configured: busyMode, effective: deliveryMode(undefined) } } : {}),
      // How a session this endpoint starts reaches the sidebar: joined to an
      // existing project, and whether this deployment lets one be invented.
      grouping: { attach: groupSessions, create: createGroups },
      ...(typeof clientPage === 'function' ? { clientPage: clientPage() } : {}),
    }
  }

  const TOOL_DEFINITIONS = [
    {
      name: 'dsh_run_prompt',
      title: 'Run a prompt in DeepSeek Harness',
      description: [
        'Start a NEW DeepSeek Harness session and run one prompt in it, on the machine that runs the Harness.',
        'The DSH agent has its full tool set (filesystem, shell, web, subagents) and works inside `cwd`.',
        'By default the call waits for the turn to end and returns the assistant\'s final text plus the new',
        '`sessionId`; pass `wait: false` to return as soon as the turn is admitted and poll with',
        '`dsh_read_session`. Use this for work you want to delegate to the Harness; use',
        '`dsh_continue_session` for follow-ups so the session context is reused.',
        'Optional `agentPreset`, `permissionPreset`, and `model` select how the new session is composed.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1, description: 'The user message to send to the new DSH session.' },
          cwd: {
            type: 'string',
            description: 'Absolute working directory for the new session. Defaults to the Harness default workspace.',
          },
          agentPreset: { type: 'string', description: 'Optional DSH agent preset id for the new session.' },
          permissionPreset: {
            type: 'string',
            description: 'Optional permission preset (sandbox mode + approval policy) applied to the new session before its first turn. List options with dsh_list_permission_presets.',
          },
          model: {
            type: 'string',
            description: 'Optional model override as "provider/model" (for example "deepseek-official/deepseek-v4.1-flash-anthropic").',
          },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort for an overridden model.' },
          wait: { type: 'boolean', description: 'Wait for the turn to finish (default true).' },
          timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds when waiting (default 1800000).' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_continue_session',
      title: 'Continue a DeepSeek Harness session',
      description: [
        'Send one prompt to an EXISTING DeepSeek Harness session (resuming it if it is not live) and return',
        'the assistant\'s final text. Use the `sessionId` returned by dsh_run_prompt or dsh_list_sessions',
        'so the Harness keeps the session\'s context and workspace. `permissionPreset` re-pins the',
        'session\'s sandbox mode and approval policy before this prompt is admitted.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to continue.' },
          prompt: { type: 'string', minLength: 1, description: 'The user message to send.' },
          mode: {
            type: 'string',
            enum: ['queue', 'steer'],
            description: '"queue" waits for the current turn and keeps the message for the next one; "steer" injects it mid-turn at the next step. Omit it to follow this deployment\u2019s own busy-Enter setting (ui-conversation.busyEnter), which is what the Web composer obeys.',
          },
          permissionPreset: {
            type: 'string',
            description: 'Optional permission preset (sandbox mode + approval policy) applied to the session before this prompt. List options with dsh_list_permission_presets.',
          },
          model: { type: 'string', description: 'Optional model override as "provider/model".' },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort for an overridden model.' },
          wait: { type: 'boolean', description: 'Wait for the turn to finish (default true).' },
          timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds when waiting (default 1800000).' },
        },
        required: ['sessionId', 'prompt'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_list_commands',
      title: 'List DeepSeek Harness commands',
      description: [
        'List the slash commands the session\'s agent can currently run: global commands plus whatever the',
        'agent\'s preset composes. Availability is per agent preset, so a command such as `/compact` only',
        'exists when that session\'s preset provides it.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session whose commands should be listed.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_run_command',
      title: 'Run a DeepSeek Harness command',
      description: [
        'Run one slash command in an EXISTING session and return its settled outcome. The command executes',
        'immediately without sending a model turn — for example `/compact` compacts older history and',
        '`/permission <preset>` switches the sandbox/approval preset. Commands resolve for that session\'s',
        'agent, so list them first with `dsh_list_commands`.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session the command runs in.' },
          line: {
            type: 'string',
            description: 'Complete command line, e.g. "/compact" or "/permission danger-full-access". Use either "line" or "command".',
          },
          command: {
            type: 'string',
            description: 'Command name with or without its leading slash, e.g. "compact" or "/compact".',
          },
          args: { type: 'string', description: 'Optional trailing input appended to "command".' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_list_sessions',
      title: 'List DeepSeek Harness sessions',
      description: [
        'List a page of the session index, newest activity first. The index view (default) carries only',
        'what identifies a session: id, title, running state, archival state, activity time, and the agent',
        'recorded as its owner; `view: "full"` adds cwd and liveness. Narrow server-side with `query`',
        '(title, cwd, owning agent, id), `mine`/`owner`, and `running`, then page with `cursor` — instead',
        'of pulling every session and filtering locally. Archived sessions are hidden unless',
        '`includeArchived` is true, mirroring the Web UI.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Maximum sessions to return (default 20, max 200).' },
          includeArchived: {
            type: 'boolean',
            description: 'Include archived sessions and mark them with `archived: true` (default false).',
          },
          mine: {
            type: 'boolean',
            description: 'Only sessions the calling agent created (default false; always on when the endpoint sets restrictToOwner).',
          },
          owner: {
            type: 'string',
            description: 'Only sessions owned by this caller id, for an orchestrator inspecting one agent.',
          },
          query: {
            type: 'string',
            description: 'Only sessions whose title, cwd, owning agent, or id contains this text (case-insensitive).',
          },
          running: { type: 'boolean', description: 'Only sessions with (true) or without (false) a running turn.' },
          view: {
            type: 'string',
            enum: ['index', 'full'],
            description: '"index" (default) returns id/title/running/archived/updatedAt/owner; "full" adds cwd, live, and blank.',
          },
          cursor: {
            type: 'integer',
            description: 'Offset into the filtered index; pass nextCursor from the previous page to continue.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_read_session',
      title: 'Read a DeepSeek Harness transcript',
      description: [
        'Read a window of a DSH session\'s transcript. `mode` chooses it: "tail" (default, the last',
        '`limit` messages), "head" (the first), or "outline" — one compact row per message with a preview',
        'and its length, the cheapest way to see what a long session contains. Narrow with `roles` and',
        '`afterSeq`, page forward with `window.nextAfterSeq`, and read only the seq range you need.',
        'Messages longer than `maxChars` (default 2000) are cut and marked `truncated` with their real',
        'length. The result always reports totalMessages, matchedMessages and returned, so a caller knows',
        'what it has not seen yet, and `pending` when the session is blocked on a user decision (see',
        '`dsh_list_requests`). Works while the session is archived. To follow a `wait: false` start or',
        'a GUI-driven session, call `dsh_wait_session` instead of polling this tool.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to read.' },
          mode: {
            type: 'string',
            enum: ['tail', 'head', 'outline'],
            description: '"tail" (default) reads the last messages, "head" the first, "outline" one compact row per message with no full text.',
          },
          limit: { type: 'integer', description: 'Messages in the window (default 10; 200 for an outline; max 5000).' },
          afterSeq: {
            type: 'integer',
            description: 'Only messages after this seq — pass window.nextAfterSeq from the previous read to page forward.',
          },
          roles: {
            type: 'array',
            items: { type: 'string', enum: ['user', 'assistant'] },
            description: 'Only these roles (default both).',
          },
          maxChars: {
            type: 'integer',
            description: 'Per-message character cap (default 2000, 0 = full text). Cut messages carry truncated: true and their real chars; in an outline it caps the preview length instead.',
          },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_search_sessions',
      title: 'Search DeepSeek Harness sessions',
      description: [
        'Find sessions by what they contain, server-side, and return bounded snippets instead of whole',
        'transcripts: match the title, cwd, owning agent or id (`scope: "title"`), or the messages',
        'themselves (`scope: "messages"`, `"both"` by default). The candidate set is the newest `scan`',
        'sessions visible to the caller (default 20) — narrow with `mine`/`owner`/`sessionIds` rather than',
        'raising `scan`. Every match says where it hit and carries a snippet, so the caller can then read',
        'exactly that session (or seq range) with `dsh_read_session`.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Case-insensitive substring to find.' },
          scope: { type: 'string', enum: ['title', 'messages', 'both'], description: 'What to search (default both).' },
          mine: { type: 'boolean', description: 'Only sessions the calling agent created.' },
          owner: { type: 'string', description: 'Only sessions owned by this caller id.' },
          sessionIds: { type: 'array', items: { type: 'string' }, description: 'Restrict the search to these sessions.' },
          limit: { type: 'integer', description: 'Maximum matches to return (default 10, max 100).' },
          scan: { type: 'integer', description: 'How many of the newest candidate sessions to look into, transcripts included (default 20, max 200).' },
          perSession: { type: 'integer', description: 'Maximum message matches per session (default 2).' },
          snippetChars: { type: 'integer', description: 'Characters of context per match (default 200).' },
          includeArchived: { type: 'boolean', description: 'Search archived sessions too (default false).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_list_requests',
      title: 'List pending user decisions',
      description: [
        'List the user decisions a session — or the newest visible sessions — is waiting on: approval',
        'requests (an `approval/asked` with no matching `approval/decided`, the one-shot permission decision',
        'behind a sandbox escalation or a denied tool) and unanswered `ask_user_question` calls. These are',
        'audit events the model never sees, so a delegated session that stops making progress is usually',
        'blocked here. Pass `sessionId` for one session, or scan the newest sessions (running ones first)',
        'with `mine`/`owner`/`scan`. Rows are marked `answerable: true` when this endpoint has parked the',
        'request (which needs `answerUserRequests: true`): those settle with `dsh_answer_request`, and every',
        'other decision stays in the Harness GUI.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Report only this session instead of scanning.' },
          mine: { type: 'boolean', description: 'Scan only sessions the calling agent created.' },
          owner: { type: 'string', description: 'Scan only sessions owned by this caller id.' },
          includeArchived: { type: 'boolean', description: 'Scan archived sessions too (default false).' },
          includeSettled: {
            type: 'boolean',
            description: 'Also report decisions that already resolved, with their outcome (default false).',
          },
          scan: { type: 'integer', description: 'How many of the newest sessions to inspect, running first (default 20, max 200).' },
          limit: { type: 'integer', description: 'Maximum sessions to report (default 20, max 200).' },
          reasonChars: { type: 'integer', description: 'Characters of an approval reason to keep (default 240).' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_answer_request',
      title: 'Answer a pending user decision',
      description: [
        'Answer one approval or user question this endpoint parked for you — available only when the',
        'deployment sets `answerUserRequests: true`, and only for sessions this endpoint drives. For an',
        'approval pass `decision: "allow"` (the one-shot grant the GUI would give) or `"deny"`; for a',
        'question pass `answers: [{ id, selected: [...] }]` with one entry per question. Ids come from',
        '`dsh_list_requests`, which marks the parked rows `answerable: true`. Other answerers — the Harness',
        'GUI above all — stay in the race: whoever decides first wins, and a request nobody answers still',
        'fails closed at the configured ceiling.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string',
            minLength: 1,
            description: 'The approval id or question call id reported by dsh_list_requests.',
          },
          decision: {
            type: 'string',
            enum: ['allow', 'deny'],
            description: 'Approval only: allow one-shot, or deny.',
          },
          answers: {
            type: 'array',
            description: 'Question only: one entry per question in the request.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                selected: { type: 'array', items: { type: 'string' } },
                custom: { type: 'string' },
              },
              required: ['id', 'selected'],
            },
          },
        },
        required: ['requestId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_wait_session',
      title: 'Wait for a DeepSeek Harness turn',
      description: [
        'Block until the turn a session is already running ends, then return the assistant text it produced.',
        'Use it after a `wait: false` start, for sessions started in the Harness GUI, or to follow work in',
        'another caller\'s session. It never prompts, steers, or cancels: reaching `timeoutMs` returns',
        '`status: "timedOut"` with `running: true` and leaves the DSH turn alone, so pass a ceiling below',
        'your own client\'s call timeout and call the tool again while the turn keeps running. A result also',
        'carries `pending` when the session is blocked on a user decision (see `dsh_list_requests`). Returns',
        '`status: "idle"` immediately when no turn is running; `limit` adds the transcript tail to any result.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session to wait for.' },
          timeoutMs: {
            type: 'integer',
            description: 'Wait ceiling in milliseconds (default 1800000, max 86400000). A timed-out wait leaves the turn running.',
          },
          limit: { type: 'integer', description: 'Include the last N transcript messages in the result (default 0 = none).' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_cancel_session',
      title: 'Cancel a DeepSeek Harness turn',
      description: 'Cancel the active turn of a DSH session without dropping its pending inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session whose turn should be cancelled.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_archive_session',
      title: 'Archive a DeepSeek Harness session',
      description: [
        'Archive one session durably: it disappears from every grouping surface (and from',
        '`dsh_list_sessions` unless `includeArchived` is true) and cannot run a model step until it is',
        'unarchived. A session with running work (turn, subagent, job, schedule) is refused unless you',
        'pass `stopActivity: true`, which archives first and then asks those providers to stop. Archiving',
        'also drops the session\'s pin.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to archive.' },
          stopActivity: {
            type: 'boolean',
            description: 'Archive even while work is running, stopping that work (default false).',
          },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_unarchive_session',
      title: 'Unarchive a DeepSeek Harness session',
      description: [
        'Drop a session from the archive set so it is listed again and can run model steps; it returns to',
        'its recorded position. The transcript is readable while archived and is not modified by either',
        'operation.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to unarchive.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_list_permission_presets',
      title: 'List DeepSeek Harness permission presets',
      description: [
        'List the permission presets this deployment offers: each one bundles a sandbox mode',
        '(`read-only`, `workspace-write`, `danger-full-access`) with an approval policy (`ask`, `never`).',
        'Pass a preset name as `permissionPreset` to `dsh_run_prompt` or `dsh_continue_session`.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_list_tools',
      title: 'List DeepSeek Harness tools',
      description: [
        'List the tools the Harness exposes to its own agents (names and short descriptions), for',
        'choosing what a delegated prompt can do. Pass `query` to narrow by name or description, and',
        '`limit` to cap the list instead of reading the whole catalog.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Only tools whose name or description contains this text (case-insensitive).' },
          limit: { type: 'integer', description: 'Maximum tools to return (default 0 = all).' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_status',
      title: 'DeepSeek Harness status',
      description: 'Report the MCP endpoint, Harness profile/version, session and live-agent counts, the default model, and the default permission preset with its catalog.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'dsh_whoami',
      title: 'Identify the calling agent',
      description: [
        'Report how this endpoint identifies the calling agent and list the DSH sessions that agent',
        'created. The label comes from the `x-dsh-mcp-client` request header, else the `clientInfo` block',
        'sent on `initialize`, else `User-Agent`; `client.source` says which one was used. This is',
        'attribution, not authentication: all callers present the same endpoint token, so a client may',
        'name itself. Use it to find your own sessions, or in a shared endpoint to attribute one.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Maximum owned sessions to list (default 20, 0 = count only).' },
        },
        additionalProperties: false,
      },
    },
  ]

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
      const cwd = normalizeCwd(args.cwd) ?? defaultCwd
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
          `Commands of session "${sessionId}" could not be listed: ${messageOf(error)}`,
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
      let execution
      try {
        execution = await commands.execute(agent, line, [], context?.signal)
      } catch (error) {
        throw new McpError(
          ERROR_CODES.invalidParams,
          `Command "${line}" failed in session "${sessionId}": ${messageOf(error)}`,
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
      // cannot even enumerate sessions it would not be allowed to touch.
      const mine = args.mine === true || restrictToOwner
      const ownerId = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : undefined
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
      // `limit: 0` keeps its old "everything" meaning; the default is a window.
      const requested = Number(args.limit)
      const limit = Number.isFinite(requested) && requested === 0
        ? Number.MAX_SAFE_INTEGER
        : numberArg(args.limit, mode === 'outline' ? 200 : DEFAULT_TRANSCRIPT_WINDOW, { min: 1, max: 5000 })
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
      const mine = args.mine === true || restrictToOwner
      const ownerId = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : undefined
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
          ({ messages } = await sessionMessages(row.sessionId))
        } catch (error) {
          logger('debug', 'search could not read a transcript', { sessionId: row.sessionId, error: messageOf(error) })
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
      const mine = args.mine === true || restrictToOwner
      const ownerId = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : undefined

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
          ({ events } = await sessionMessages(row.sessionId))
        } catch (error) {
          logger('debug', 'request scan could not read a session', { sessionId: row.sessionId, error: messageOf(error) })
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

    async dsh_cancel_session(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      assertCallerMay(sessionId, context?.caller)
      const controller = requireService(ctx, 'sessionController')
      try {
        controller.cancel({ sessionId })
      } catch (error) {
        throw new McpError(ERROR_CODES.invalidParams, `Session "${sessionId}" could not be cancelled: ${messageOf(error)}`)
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
        const message = messageOf(error)
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
          `Session "${sessionId}" could not be unarchived: ${messageOf(error)}`,
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
      if (!handler) throw new McpError(ERROR_CODES.methodNotFound, `Unknown tool: ${name}`)
      return handler(args ?? {}, internalContext(context))
    },
    /** Static resources: status and the session index. */
    listResources: () => [
      {
        uri: 'dsh://status',
        name: 'Harness status',
        title: 'DeepSeek Harness status',
        description: 'Endpoint, profile, version, session and agent counts, default model.',
        mimeType: 'application/json',
      },
      {
        uri: 'dsh://sessions',
        name: 'Sessions',
        title: 'DeepSeek Harness sessions',
        description: 'Visible sessions (archived ones excluded) with title, cwd, running state, archival state, and activity time.',
        mimeType: 'application/json',
      },
    ],
    /** One resource template per session transcript. */
    listResourceTemplates: () => [
      {
        uriTemplate: 'dsh://session/{sessionId}',
        name: 'Session transcript',
        title: 'DeepSeek Harness session transcript',
        description: 'Ordered user/assistant messages of one session.',
        mimeType: 'application/json',
      },
    ],
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
        const sessionId = decodeURIComponent(match[1])
        assertCallerMay(sessionId, context?.caller)
        return { text: JSON.stringify(await readTranscript(sessionId, { limit: 20, maxChars: 4000 }), null, 2), mimeType: 'application/json' }
      }
      throw new McpError(ERROR_CODES.resourceNotFound, `Unknown resource: ${uri}`)
    },
    status,
  }
}