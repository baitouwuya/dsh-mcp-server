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

/** Text handed to the calling model on `initialize`. */
export const INSTRUCTIONS = [
  'This server is a DeepSeek Harness (DSH) deployment. Its tools start and drive real DSH agent sessions',
  'on the machine that runs the Harness: each session works in a directory with the full DSH tool set',
  '(files, shell, web, subagents, skills), its own model selection, and the user’s approval policy.',
  '',
  'Use `dsh_run_prompt` for one-shot work and hand it an absolute `cwd`; it returns the final assistant',
  'text plus a `sessionId`. Use `dsh_continue_session` with that id for follow-up turns, so context is',
  'kept. Long tasks: call `dsh_run_prompt` with `wait: false`, then poll `dsh_read_session`.',
  'Use `dsh_list_sessions`/`dsh_read_session` to inspect work already happening in the Harness, and',
  '`dsh_cancel_session` to stop a turn.',
].join('\n')

/** Default per-turn ceiling for a tool call that waits for completion. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000

/** Sessions this MCP endpoint will start concurrently when waiting is requested. */
export const DEFAULT_MAX_CONCURRENT_TURNS = 8

/** Prompt identity prefix, kept distinct from Harness browser-minted ids. */
const REQUEST_ID_PREFIX = 'mcp'

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
    defaultModel = undefined,
    maxConcurrentTurns = DEFAULT_MAX_CONCURRENT_TURNS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    defaultCwd = undefined,
  } = options

  let activeTurns = 0

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

  /** Session list row enriched with its title. */
  async function listSessionRows(signal, limit) {
    const controller = requireService(ctx, 'sessionController')
    const sessionQuery = ctx.get('sessionQuery')
    const listed = await controller.list({}, signal)
    const items = Array.isArray(listed?.items) ? listed.items : []
    const chosen = items.slice(0, limit)
    let titles = new Map()
    if (sessionQuery && chosen.length) {
      try {
        const observed = await sessionQuery.readTitleSnapshots(chosen.map((item) => item.sessionId), signal)
        titles = new Map((observed ?? []).map((entry) => [
          entry.sessionId,
          entry.status === 'fulfilled' ? entry.value?.title?.title : undefined,
        ]))
      } catch (error) {
        logger('debug', 'title lookup failed', { error: messageOf(error) })
      }
    }
    return chosen.map((item) => ({
      sessionId: item.sessionId,
      title: titles.get(item.sessionId) ?? undefined,
      cwd: item.cwd,
      running: item.running === true,
      live: item.agentAvailable === true,
      blank: item.blank === true,
      updatedAt: new Date(Number(item.updatedAt) || Date.now()).toISOString(),
    }))
  }

  /** Ordered `{ role, text }` transcript rows for one session. */
  async function readTranscript(sessionId, limit) {
    const sessionQuery = requireService(ctx, 'sessionQuery')
    let snapshot
    try {
      snapshot = await sessionQuery.readSession(sessionId)
    } catch (error) {
      throw new McpError(ERROR_CODES.invalidParams, `Session "${sessionId}" could not be read: ${messageOf(error)}`)
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const rows = []
    for (const event of events) {
      const message = messageOfEvent(event)
      if (message) rows.push({ ...message, seq: Number(event.seq) })
    }
    return {
      sessionId,
      cwd: snapshot?.session?.cwd,
      agentPreset: snapshot?.session?.agentPreset,
      createdAt: snapshot?.session?.createdAt
        ? new Date(Number(snapshot.session.createdAt)).toISOString()
        : undefined,
      totalMessages: rows.length,
      messages: limit > 0 ? rows.slice(-limit) : rows,
    }
  }

  /**
   * Admit one prompt and (optionally) wait for its turn to end.
   *
   * @param request - `{ sessionId, prompt, create, cwd, agentPreset, model, wait, timeoutMs, signal, mode }`.
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
      wait = true,
      timeoutMs = turnTimeoutMs,
      signal,
      mode = 'queue',
    } = request

    const controller = requireService(ctx, 'sessionController')
    const requestId = `${REQUEST_ID_PREFIX}-${randomUUID()}`
    const beforeSeq = create ? -1 : await currentSeq(sessionId)

    try {
      if (create) {
        await controller.create({
          sessionId,
          ...(cwd ? { cwd } : {}),
          ...(agentPreset ? { agentPreset } : {}),
        })
      }
      const selection = model ?? defaultModel
      if (selection?.provider && selection?.model) {
        await controller.selectModel({
          sessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        })
      }
      await controller.prompt(
        { sessionId, requestId, mode, content: [{ type: 'text', text: prompt }] },
        signal,
      )
    } catch (error) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        `DeepSeek Harness rejected the prompt for session "${sessionId}": ${messageOf(error)}`,
      )
    }

    if (!wait) {
      return { sessionId, status: 'started', text: '', requestId }
    }

    const release = await acquireTurnSlot(signal)
    const timeoutSignal = AbortSignal.timeout(Math.max(1000, timeoutMs))
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const texts = []
    let endReason
    let cancelled = false
    try {
      const stream = controller.follow(
        { address: { kind: 'session', sessionId } },
        combined,
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
      const aborted = combined.aborted || error?.name === 'AbortError'
      if (aborted) {
        cancelled = true
        try {
          controller.cancel({ sessionId })
        } catch (cancelError) {
          logger('debug', 'cancel after abort failed', { error: messageOf(error) ?? messageOf(cancelError) })
        }
      } else {
        logger('warn', 'follow failed', { sessionId, error: messageOf(error) })
        throw new McpError(ERROR_CODES.internalError, `Following session "${sessionId}" failed: ${messageOf(error)}`)
      }
    } finally {
      release()
    }

    const text = texts.filter(Boolean).join('\n\n')
    if (cancelled) {
      const timedOut = timeoutSignal.aborted && !signal?.aborted
      return {
        sessionId,
        status: timedOut ? 'timeout' : 'cancelled',
        text,
        requestId,
        note: timedOut
          ? `The turn exceeded ${timeoutMs} ms and was cancelled; the DSH session keeps its history, so dsh_continue_session can resume it.`
          : 'The turn was cancelled because the MCP caller disconnected.',
      }
    }
    return { sessionId, status: endReason === 'error' ? 'error' : 'completed', text, requestId, turnEndReason: endReason }
  }

  /** Session status row used by `dsh_status`. */
  async function status() {
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
    return {
      server: 'dsh-mcp-server',
      dshVersion: options.dshVersion,
      profile: process.env.DSH_PROFILE,
      dshHome: options.dshHome,
      endpoint: options.endpoint,
      uptimeMs: Date.now() - options.startedAt,
      activeTurns,
      maxConcurrentTurns,
      sessions: sessionCount,
      liveAgents,
      defaultCwd: defaultCwd ?? null,
      defaultModel: defaultModel ?? null,
      toolNames: TOOL_DEFINITIONS.map((tool) => tool.name),
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
        'so the Harness keeps the session\'s context and workspace.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to continue.' },
          prompt: { type: 'string', minLength: 1, description: 'The user message to send.' },
          mode: {
            type: 'string',
            enum: ['queue', 'steer'],
            description: '"queue" waits for the current turn (default); "steer" injects mid-turn.',
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
      name: 'dsh_list_sessions',
      title: 'List DeepSeek Harness sessions',
      description: 'List the Harness\'s visible sessions, newest activity first, with title, working directory, and whether a turn is running.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Maximum sessions to return (default 20, max 200).' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_read_session',
      title: 'Read a DeepSeek Harness transcript',
      description: [
        'Read a DSH session\'s user/assistant transcript as ordered `{ role, text }` rows. Use it to poll a',
        'session started with `wait: false` or to inspect work in progress in the Harness GUI.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to read.' },
          limit: { type: 'integer', description: 'Return only the last N messages (default 50, 0 = all).' },
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
      name: 'dsh_list_tools',
      title: 'List DeepSeek Harness tools',
      description: 'List the tools the Harness exposes to its own agents (names and short descriptions), for choosing what a delegated prompt can do.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_status',
      title: 'DeepSeek Harness status',
      description: 'Report the MCP endpoint, Harness profile/version, session and live-agent counts, and the default model.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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

  const handlers = {
    async dsh_run_prompt(args, context) {
      const prompt = String(args.prompt ?? '')
      if (!prompt.trim()) throw new McpError(ERROR_CODES.invalidParams, '"prompt" must not be empty.')
      const sessionId = `session-${randomUUID()}`
      const outcome = await runTurn({
        sessionId,
        prompt,
        create: true,
        cwd: normalizeCwd(args.cwd) ?? defaultCwd,
        agentPreset: typeof args.agentPreset === 'string' && args.agentPreset ? args.agentPreset : undefined,
        model: parseModelArg(args),
        wait: args.wait !== false,
        timeoutMs: numberArg(args.timeoutMs, turnTimeoutMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
        signal: context?.signal,
      })
      return { text: JSON.stringify(outcome, null, 2), structuredContent: outcome }
    },

    async dsh_continue_session(args, context) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      const prompt = String(args.prompt ?? '')
      if (!prompt.trim()) throw new McpError(ERROR_CODES.invalidParams, '"prompt" must not be empty.')
      const mode = args.mode === 'steer' ? 'steer' : 'queue'
      const outcome = await runTurn({
        sessionId,
        prompt,
        create: false,
        model: parseModelArg(args),
        mode,
        wait: args.wait !== false,
        timeoutMs: numberArg(args.timeoutMs, turnTimeoutMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
        signal: context?.signal,
      })
      return { text: JSON.stringify(outcome, null, 2), structuredContent: outcome }
    },

    async dsh_list_sessions(args, context) {
      const limit = numberArg(args.limit, 20, { min: 1, max: 200 })
      const sessions = await listSessionRows(context?.signal, limit)
      const payload = { count: sessions.length, sessions }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_read_session(args) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      const limit = numberArg(args.limit, 50, { min: 0, max: 5000 })
      const payload = await readTranscript(sessionId, limit)
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_cancel_session(args) {
      const sessionId = String(args.sessionId ?? '')
      if (!sessionId) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
      const controller = requireService(ctx, 'sessionController')
      try {
        controller.cancel({ sessionId })
      } catch (error) {
        throw new McpError(ERROR_CODES.invalidParams, `Session "${sessionId}" could not be cancelled: ${messageOf(error)}`)
      }
      return { text: JSON.stringify({ sessionId, status: 'cancel-requested' }) }
    },

    async dsh_list_tools() {
      const tools = requireService(ctx, 'tools')
      const schemas = typeof tools.schemas === 'function' ? tools.schemas() : []
      const payload = {
        count: Array.isArray(schemas) ? schemas.length : 0,
        tools: (Array.isArray(schemas) ? schemas : []).map((schema) => ({
          name: schema?.name ?? schema?.function?.name,
          description: schema?.description ?? schema?.function?.description,
        })).filter((entry) => entry.name),
      }
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },

    async dsh_status() {
      const payload = await status()
      return { text: JSON.stringify(payload, null, 2), structuredContent: payload }
    },
  }

  return {
    tools: TOOL_DEFINITIONS,
    /** Dispatch one MCP tool call. */
    async callTool(name, args, context) {
      const handler = handlers[name]
      if (!handler) throw new McpError(ERROR_CODES.methodNotFound, `Unknown tool: ${name}`)
      return handler(args ?? {}, context)
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
        description: 'Visible sessions with title, cwd, running state, and activity time.',
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
    async readResource(uri) {
      if (uri === 'dsh://status') {
        return { text: JSON.stringify(await status(), null, 2), mimeType: 'application/json' }
      }
      if (uri === 'dsh://sessions') {
        const sessions = await listSessionRows(undefined, 50)
        return { text: JSON.stringify({ count: sessions.length, sessions }, null, 2), mimeType: 'application/json' }
      }
      const match = /^dsh:\/\/session\/(.+)$/.exec(uri)
      if (match) {
        const sessionId = decodeURIComponent(match[1])
        return { text: JSON.stringify(await readTranscript(sessionId, 200), null, 2), mimeType: 'application/json' }
      }
      throw new McpError(ERROR_CODES.resourceNotFound, `Unknown resource: ${uri}`)
    },
    status,
  }
}