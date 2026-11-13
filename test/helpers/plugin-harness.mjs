#!/usr/bin/env node
/**
 * Shared fake-Harness harness for the plugin integration tests.
 *
 * Each integration file builds its own Cordis context, applies the plugin,
 * mounts the route it registered on a throwaway HTTP server, and drives it.
 * This module owns the fake DSH services and the small amount of HTTP plumbing
 * so a domain file only contains the checks for its domain.
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../../index.js'

export const PROMPT = 'delegate this task'
export const REPLY = 'hello from dsh'

/** The DSH agent a local tool call is attributed to. */
export const INTERNAL_AGENT = { id: 'agent-live', session: { header: { id: 'live-session', cwd: '/' } } }

/** Minimal fake Cordis context exposing only what the plugin touches. */
export function makeContext(services, disposers, hooks = new Map()) {
  const context = {
    // Cordis exposes an injected service both as `ctx.<name>` and `ctx.get(name)`.
    ...services,
    get: (name) => services[name],
    // Waterfall listeners registered by the plugin, so a test can play the Harness.
    on: (name, handler) => {
      hooks.set(name, handler)
      return () => hooks.delete(name)
    },
    hooks,
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    effect: (create) => {
      const dispose = create()
      disposers.push(dispose)
      return dispose
    },
    // Cordis runs an injection callback once every named service resolves; a
    // fake composes the same child scope so lifetime behaviour is exercised.
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return
      const scope = { ...context, effect: context.effect }
      callback(scope)
    },
  }
  return context
}

/** Fake DSH services with one scripted turn. */
export function makeServices() {
  const events = []
  let pendingPrompt
  let currentSessionId
  let seq = 0
  const appliedPermissions = []
  const resolvedAgents = []
  const modelSelections = []
  const followRequests = []
  const cancelledSessions = []
  const runningSessions = new Set()
  const extraSessions = []
  const titleOverrides = new Map()
  const controllerListCalls = []
  const titleLookups = []
  let hang = false

  /** Append synthetic transcript events, so read windows have something to page through. */
  function seedMessages(specs) {
    for (const spec of specs) {
      const assistant = spec.role === 'assistant'
      events.push({
        type: assistant ? 'assistant/message' : 'user/message',
        seq: ++seq,
        time: Date.now(),
        data: assistant
          ? { message: { content: [{ type: 'text', text: spec.text }] } }
          : { source: { kind: 'user' }, content: [{ type: 'text', text: spec.text }] },
      })
    }
  }

  /** Append raw session events, for folding approvals and questions. */
  function seedEvents(specs) {
    for (const spec of specs) events.push({ seq: ++seq, time: Date.now(), ...spec })
  }

  /** Register extra list entries with their own titles, for paging and query coverage. */
  function addSyntheticSessions(entries) {
    for (const entry of entries) {
      extraSessions.push(entry)
      if (entry.title) titleOverrides.set(entry.sessionId, entry.title)
    }
  }

  /** The one live session the fake store hands back to the permission writer. */
  const liveSession = { id: 'live-session', header: { id: 'session-current', cwd: '/tmp' }, append() {} }

  /** Messages an internal caller queued through the target agent's handle. */
  const injectedMessages = []

  /** Permission presets mirroring the deployment's read-only/write/full table. */
  const permissionOptions = [
    { value: 'read-only', name: 'Read only', description: 'Read files; no writes.' },
    { value: 'workspace-write', name: 'Workspace write', description: 'Write inside the workspace; wider retries need approval.' },
    { value: 'danger-full-access', name: 'Full access', description: 'Full file access without approval prompts.' },
  ]
  /**
   * The reserved experimental preset DSH 0.2.2 can compose: per-call review in a
   * full-access sandbox. It is not a configured preset — it exists only while
   * its integration is live, and `resolve` throws when it is not, exactly as
   * the Host's own service does.
   */
  const autoOption = { value: 'auto', name: 'auto', description: 'Review each call (experimental)' }
  const autoSpec = { sandbox: 'danger-full-access', approval: 'ask' }
  let liveAuto = false
  /** The catalog one deployment exposes right now. */
  const catalogOptions = () => (liveAuto ? [...permissionOptions, autoOption] : permissionOptions)
  /** The knob bundle behind each preset name, as the real service's `resolve` returns it. */
  const presetTable = {
    'read-only': { sandbox: 'read-only', approval: 'never' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }
  /** The calling agent's own authority, which the clamp is measured against. */
  let callerMode = 'workspace-write'
  let callerPreset = 'workspace-write'
  let defaultSelection = { provider: 'deepseek-official', model: 'deepseek-v4.1-flash-anthropic' }
  let selectModelFailure = false
  const registeredTools = []
  const configEdits = []
  const permissionPresets = {
    catalog: () => ({ defaultPreset: 'workspace-write', defaultOptions: catalogOptions(), options: catalogOptions() }),
    resolve(name) {
      if (name === 'auto') {
        if (!liveAuto) throw new Error('permission: unknown preset "auto" (the review integration is not composed)')
        return { name, ...autoSpec }
      }
      const spec = presetTable[name]
      if (!spec) throw new Error(`permission: unknown preset "${name}"`)
      return { name, ...spec }
    },
    current: () => callerPreset,
    set(session, name) {
      if (!catalogOptions().some((option) => option.value === name)) {
        throw new Error(`permission: unknown preset "${name}" (known: ${catalogOptions().map((option) => option.value).join(', ')})`)
      }
      appliedPermissions.push({ session, name })
      // Mirror the durable event the real service appends, so the transcript
      // fold can be exercised over the same log the plugin reads.
      events.push({ type: 'permission/preset', seq: ++seq, time: Date.now(), data: { preset: name } })
    },
  }

  /** The live-session store the plugin consults before falling back to resolveAgent(). */
  const sessions = { get: (id) => (id === currentSessionId ? liveSession : undefined) }

  /** Command registry the fake agent sees; `/permission` writes through the presets fake. */
  const commandRegistry = [
    { name: 'compact', description: 'Compact older conversation history' },
    { name: 'permission', description: 'Switch the permission preset (sandbox mode + approval policy)', input: { hint: '<preset>' } },
  ]
  const listedCommandAgents = []
  const executedCommands = []
  const commands = {
    list(agent) {
      listedCommandAgents.push(agent)
      return commandRegistry
    },
    async execute(agent, line, attachments, signal) {
      executedCommands.push({ agent, line, attachments, aborted: signal?.aborted === true })
      const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
      if (!match) return undefined
      const name = match[1]
      if (!commandRegistry.some((entry) => entry.name === name)) return undefined
      const rawInput = line.slice(match[0].length).trim()
      if (name === 'permission') {
        if (!rawInput) {
          return { commandId: 'cmd-current', result: { kind: 'success', text: 'current preset workspace-write (available: read-only, workspace-write, danger-full-access)' } }
        }
        try {
          permissionPresets.set(liveSession, rawInput)
        } catch (error) {
          return { commandId: 'cmd-permission-error', result: { kind: 'error', text: error instanceof Error ? error.message : String(error) } }
        }
        return { commandId: 'cmd-permission', result: { kind: 'success', text: `preset ${rawInput}` } }
      }
      return { commandId: `cmd-${name}`, result: { kind: 'success', text: 'Compacted 3 history items (~120 tokens).', sourceEventSeq: 99 } }
    },
  }

  /** Admit one prompt the way the controller does, for both call paths. */
  function admit(request) {
    currentSessionId = request.sessionId
    pendingPrompt = request.content.map((part) => part.text).join('')
    events.push({
      type: 'user/message',
      seq: ++seq,
      time: Date.now(),
      data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'INJECTED CONTEXT' }] },
    })
    events.push({
      type: 'user/message',
      seq: ++seq,
      time: Date.now(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: pendingPrompt }] },
    })
    return { accepted: true }
  }

  /** The live agent handle a labelled prompt is queued on. */
  function agentHandle(sessionId) {
    return {
      session: liveSession,
      followup(message) {
        injectedMessages.push({ sessionId, mode: 'queue', message })
        admit({ sessionId, requestId: 'agent-followup', content: message.content })
      },
      steer(message) {
        injectedMessages.push({ sessionId, mode: 'steer', message })
        admit({ sessionId, requestId: 'agent-steer', content: message.content, mode: 'steer' })
      },
      inject(message) {
        // No wake-up and no turn: the message waits for the next admitted step.
        injectedMessages.push({ sessionId, mode: 'inject', message })
      },
    }
  }

  const sessionController = {
    async create(request) {
      currentSessionId = request.sessionId
      liveSession.header = { id: request.sessionId, ...(request.cwd ? { cwd: request.cwd } : {}) }
      return { sessionId: currentSessionId }
    },
    async selectModel(request) {
      if (selectModelFailure) {
        const error = new Error('session/model-unavailable')
        error.code = 'session/model-unavailable'
        throw error
      }
      modelSelections.push(request)
    },
    /** Cold-session resume path used when the store holds no live entry. */
    async resolveAgent(id) {
      resolvedAgents.push(id)
      return { agent: agentHandle(id) }
    },
    async prompt(request) {
      return admit(request)
    },
    follow(_request, signal) {
      followRequests.push(_request)
      if (hang) {
        // A turn that never ends on its own: only the caller's ceiling stops the wait.
        const snapshot = { type: 'snapshot', header: { id: currentSessionId }, cursor: 0, records: [], hasMore: false }
        const closeOnAbort = hang === 'close'
        return (async function* stream() {
          yield snapshot
          await new Promise((resolve, reject) => {
            const abort = () => closeOnAbort ? resolve() : reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            if (signal?.aborted) return abort()
            signal?.addEventListener('abort', abort, { once: true })
          })
        })()
      }
      const assistant = {
        type: 'assistant/message',
        seq: ++seq,
        time: Date.now(),
        data: { message: { content: [{ type: 'text', text: REPLY }] } },
      }
      const end = { type: 'turn/end', seq: ++seq, time: Date.now(), data: { reason: { kind: 'completed' } } }
      const before = events.slice()
      events.push(assistant, end)
      runningSessions.delete(currentSessionId)
      const frames = [
        { type: 'snapshot', header: { id: currentSessionId }, cursor: before.length, records: before.map((event) => ({ type: 'event', event })), hasMore: false },
        { type: 'event', event: assistant },
        { type: 'event', event: end },
      ]
      return (async function* stream() {
        for (const frame of frames) yield frame
      })()
    },
    cancel(request) {
      cancelledSessions.push(request?.sessionId)
      return { accepted: true }
    },
    async list(signal) {
      controllerListCalls.push({ signal: signal !== undefined })
      return {
        items: [
          {
            sessionId: currentSessionId,
            updatedAt: Date.now(),
            running: runningSessions.has(currentSessionId),
            blank: false,
            agentAvailable: true,
            cwd: '/tmp',
          },
          ...extraSessions.map((entry) => ({
            sessionId: entry.sessionId,
            updatedAt: entry.updatedAt ?? Date.now(),
            running: entry.running === true,
            blank: false,
            agentAvailable: true,
            cwd: entry.cwd ?? '/tmp',
            ...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
          })),
        ],
      }
    },
  }

  const sessionQuery = {
    async readSession(id) {
      assert.equal(id, currentSessionId)
      return { session: { cwd: '/tmp', createdAt: Date.now() }, events, inheritedEventCount: 0 }
    },
    async readTitleSnapshots(ids) {
      titleLookups.push([...ids])
      return ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: { id }, title: { title: titleOverrides.get(id) ?? 'Delegated task' } },
      }))
    },
    async listSessions() {
      // Header-only rows, newest created first, exactly as the Host's query
      // service returns them: no projections, no activity time.
      const rows = [
        { header: { id: currentSessionId, cwd: '/tmp', createdAt: 1_700_000_000_000 }, live: true, persisted: true },
        ...extraSessions.map((entry, index) => ({
          header: {
            id: entry.sessionId,
            cwd: entry.cwd ?? '/tmp',
            createdAt: 1_700_000_000_000 - (index + 1) * 1000,
          },
          live: false,
          persisted: true,
        })),
      ]
      return rows
    },
  }

  const webServer = {
    registered: [],
    register(route) {
      this.registered.push(route)
      return () => { this.registered = this.registered.filter((entry) => entry !== route) }
    },
  }

  /** Fake workspace registry: the archive set plus a busy flag for the refusal path. */
  const archived = new Set()
  let busy = false
  const workspaces = []
  const workspaceCalls = []
  const workspaceRegistry = {
    get archivedSessionIds() { return [...archived] },
    async sessionKnown(id) {
      return id === currentSessionId || id === 'session-cold'
    },
    async resolveByPath(path) {
      workspaceCalls.push({ op: 'resolve', path })
      return workspaces.find((workspace) => workspace.path === path)
    },
    async delete(id) {
      workspaceCalls.push({ op: 'delete', id })
      const index = workspaces.findIndex((workspace) => workspace.id === id)
      if (index >= 0) workspaces.splice(index, 1)
    },
    async create(path) {
      workspaceCalls.push({ op: 'create', path })
      const existing = workspaces.find((workspace) => workspace.path === path)
      if (existing) return existing
      const workspace = {
        id: `ws-${workspaces.length + 1}`,
        path,
        title: path.split('/').filter(Boolean).pop() ?? path,
        sessionIds: [],
        async attachSession(sessionId) {
          if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId)
        },
      }
      workspaces.push(workspace)
      return workspace
    },
    async archiveSession(id, options) {
      if (!options?.stopActivity && busy) {
        const error = new Error(`Session "${id}" still has running work`)
        error.name = 'WorkspaceActiveSessionError'
        throw error
      }
      archived.add(id)
    },
    async unarchiveSession(id) { archived.delete(id) },
  }

  /** The per-call policy service the clamp reads the caller's own mode from. */
  const sandboxPolicy = {
    resolve: (request) => ({ mode: callerMode, workspaceRoot: '/tmp', sessionId: request?.session?.header?.id }),
  }

  /** The profile configuration editor the settings page writes through. */
  const configEditor = {
    entries: () => [
      { options: { id: 'ui-conversation', name: '@deepseek-ai/dsh-client-ui-conversation', config: { busyEnter: 'steer' } } },
      { options: { id: 'dsh-mcp-server', name: 'dsh-mcp-btwy' } },
    ],
    async edit(entry, change) {
      const next = change({}, {})
      configEdits.push({ entry, next })
      return next
    },
  }

  /** The browser module registry: what serves this bundle's client half. */
  const clientModules = {
    clientPath: (id) => (id === 'dsh-mcp-btwy' ? '/tmp/pkg/lib/client.js' : undefined),
    graph: () => ({ entries: [{ id: 'dsh-mcp-btwy' }, { id: '@deepseek-ai/dsh-client-ui-theme' }] }),
  }

  /** Per-agent tool registrations, the way an agent's own scope holds them. */
  const agentScopes = new WeakMap()

  /** A calling agent with the scoped context `dsh_mcp_open` registers into. */
  function makeAgent(id = 'agent-live', sessionId = 'live-session') {
    const agent = { id, session: { header: { id: sessionId, cwd: '/' } } }
    const registered = []
    agentScopes.set(agent, registered)
    const scope = {
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {
            const index = registered.indexOf(definition)
            if (index >= 0) registered.splice(index, 1)
          }
        },
      },
      effect: (create) => create(),
      inject: (_deps, callback) => { callback(scope); return { dispose() {} } },
    }
    agent.ctx = scope
    return agent
  }

  /** The tools one agent can see natively. */
  function agentTools(agent) {
    return [...(agentScopes.get(agent) ?? [])]
  }

  /**
   * Scheduled-task service: records each request and answers like the Host one.
   *
   * The timing validator mirrors the Host's management boundary — exactly
   * `kind` plus its snake_case selector, nested for daily/weekly/cron — so a
   * documented shape that the Host would refuse fails here too.
   */
  const scheduleTasks = new Map()
  const scheduleCalls = []
  let scheduleSeq = 0
  const TIMING_SELECTORS = {
    after: 'after_seconds',
    at: 'at',
    every: 'every_seconds',
    daily: 'daily',
    weekly: 'weekly',
    cron: 'cron',
    rrule: 'rrule',
  }
  const timingInvalid = (message) => {
    const error = new Error(message)
    error.code = 'invalid_rule'
    return error
  }
  const exactKeys = (value, keys) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  function validateTiming(timing) {
    const selector = timing !== null && typeof timing === 'object' ? TIMING_SELECTORS[timing.kind] : undefined
    if (!selector || !exactKeys(timing, ['kind', selector])) {
      throw timingInvalid('timing must contain exactly kind and its matching selector.')
    }
    if (selector === 'after' || selector === 'every') {
      if (!Number.isSafeInteger(timing[selector]) || timing[selector] <= 0) {
        throw timingInvalid(selector + ' must be a positive safe integer.')
      }
      return
    }
    if (selector === 'at') {
      if (typeof timing.at !== 'string') throw timingInvalid('at must be an explicit-offset string.')
      return
    }
    if (selector === 'rrule') {
      if (typeof timing.rrule !== 'string') throw timingInvalid('rrule must be one DTSTART line and one RRULE line.')
      return
    }
    const keys = selector === 'cron' ? ['expression', 'time_zone'] : selector === 'weekly' ? ['time', 'time_zone', 'weekdays'] : ['time', 'time_zone']
    if (!exactKeys(timing[selector], keys)) {
      throw timingInvalid(selector + ' must contain exactly ' + keys.join(', ') + '.')
    }
  }
  const scheduleService = {
    deliveryLimits: () => ({ newSessionIntervalSeconds: 60 }),
    async create(request, actorSessionId) {
      validateTiming(request.timing)
      scheduleCalls.push({ op: 'create', request, actorSessionId })
      if (request.timing?.kind === 'bogus') {
        const error = new Error('timing.kind must be one of after, at, every, daily, weekly, cron, rrule')
        error.code = 'invalid_rule'
        throw error
      }
      const id = 'schedule-' + ++scheduleSeq
      const target = request.target ?? { kind: 'new_once', sessionId: 'session-reserved-' + scheduleSeq }
      const task = {
        id,
        kind: request.timing.kind,
        title: request.title,
        prompt: request.prompt,
        scheduledAt: '2026-11-10T01:00:00.000Z',
        target,
        status: 'active',
        createdAt: '2026-11-09T00:00:00.000Z',
        updatedAt: '2026-11-09T00:00:00.000Z',
        ...(request.timing.kind === 'rrule' ? { rrule: request.timing.rrule } : {}),
        ...(request.timing.kind === 'daily' ? { time: request.timing.daily.time, timeZone: request.timing.daily.time_zone } : {}),
        ...(request.timing.kind === 'cron' ? { expression: request.timing.cron.expression, timeZone: request.timing.cron.time_zone } : {}),
        ...(request.timing.kind === 'weekly' ? { time: request.timing.weekly.time, timeZone: request.timing.weekly.time_zone, weekdays: request.timing.weekly.weekdays } : {}),
      }
      scheduleTasks.set(id, task)
      return { ...task }
    },
    async list(request = {}) {
      scheduleCalls.push({ op: 'list', request })
      const all = [...scheduleTasks.values()].filter(
        (task) => request.active === undefined || (task.status === 'active') === request.active,
      )
      const limit = Number.isInteger(request.limit) ? request.limit : 100
      const offset = Number.isInteger(request.offset) ? request.offset : 0
      const page = all.slice(offset, offset + limit)
      return { items: page, shown: page.length, total: all.length, limit, offset }
    },
    async view(request) {
      scheduleCalls.push({ op: 'view', request })
      const task = scheduleTasks.get(request.id)
      return task ? { ...task } : { id: request.id, code: 'schedule_not_found' }
    },
    async edit(request, actorSessionId) {
      scheduleCalls.push({ op: 'edit', request, actorSessionId })
      const current = scheduleTasks.get(request.id)
      if (current === undefined) return { id: request.id, code: 'schedule_not_found' }
      if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (current.updatedAt ?? null)) {
        return { id: request.id, code: 'schedule_conflict' }
      }
      if (request.action === 'delete') {
        scheduleTasks.delete(request.id)
        return { id: request.id, deleted: true }
      }
      const patch = request.patch ?? {}
      const next = {
        ...current,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
        ...(patch.target === undefined ? {} : { target: patch.target }),
        ...(patch.active === undefined ? {} : { status: patch.active ? 'active' : 'paused' }),
        updatedAt: '2026-11-09T01:00:00.000Z',
      }
      if (patch.timing !== undefined) {
        validateTiming(patch.timing)
        next.kind = patch.timing.kind
        if (patch.timing.kind === 'rrule') next.rrule = patch.timing.rrule
        if (patch.timing.kind === 'daily') {
          next.time = patch.timing.daily.time
          next.timeZone = patch.timing.daily.time_zone
        }
        if (patch.timing.kind === 'cron') {
          next.expression = patch.timing.cron.expression
          next.timeZone = patch.timing.cron.time_zone
        }
      }
      scheduleTasks.set(next.id, next)
      return { ...next }
    },
    async run(request) {
      scheduleCalls.push({ op: 'run', request })
      const task = scheduleTasks.get(request.id)
      return task ? { ...task } : { id: request.id, code: 'schedule_not_found' }
    },
  }

  /** The Harness tool registry: what the bridge registers into. */
  const tools = {
    schemas: () => [{ name: 'read_file', description: 'Read a file' }],
    // `ctx.tools.get(name, scope)`: no scope is the global registry, an agent
    // is what that agent sees — which is how the bridge tells native from not.
    get(name, scope) {
      const rows = scope === undefined ? registeredTools : (agentScopes.get(scope) ?? [])
      return rows.find((definition) => definition.name === name)
    },
    register(definition) {
      registeredTools.push(definition)
      return () => {
        const index = registeredTools.indexOf(definition)
        if (index >= 0) registeredTools.splice(index, 1)
      }
    },
  }

  const services = {
      sessionController,
      sessionQuery,
      sessions,
      permissionPresets,
      commands,
      webServer,
      workspaceRegistry,
      sandboxPolicy,
      configEditor,
      clientModules,
      tools,
      // The live-Agent registry: injection needs a live handle and must never
      // resume a cold one, so the fake hands one back for any id.
      agents: { get: (sessionId) => agentHandle(sessionId) },
      agentDefaultModel: { currentSelection: () => ({ ...defaultSelection }) },
      setDefaultSelection: (selection) => { defaultSelection = selection },
      setSelectModelFailure: (value) => { selectModelFailure = value === true },
      schedule: scheduleService,
  }

  return {
    services,
    webServer,
    getPrompt: () => pendingPrompt,
    setBusy: (value) => { busy = value },
    archivedIds: () => [...archived],
    appliedPermissions: () => appliedPermissions.map((entry) => entry.name),
    modelSelections: () => [...modelSelections],
    followRequests: () => [...followRequests],
    cancelledSessions: () => [...cancelledSessions],
    setRunning: (value) => {
      if (value) runningSessions.add(currentSessionId)
      else runningSessions.delete(currentSessionId)
    },
    setHang: (value) => { hang = value },
    seedMessages,
    seedEvents,
    addSyntheticSessions,
    resolvedAgents: () => [...resolvedAgents],
    listedCommandAgents: () => [...listedCommandAgents],
    executedCommands: () => [...executedCommands],
    currentId: () => currentSessionId,
    registeredTools: () => [...registeredTools],
    injectedMessages: () => [...injectedMessages],
    workspaces: () => workspaces.map((workspace) => ({ id: workspace.id, path: workspace.path, title: workspace.title, sessionIds: [...workspace.sessionIds] })),
    workspaceCalls: () => [...workspaceCalls],
    makeAgent,
    agentTools,
    configEdits: () => [...configEdits],
    setCallerMode: (mode) => { callerMode = mode },
    setCallerPreset: (preset) => { callerPreset = preset },
    setLiveAuto: (value) => { liveAuto = value === true },
    controllerListCalls: () => [...controllerListCalls],
    titleLookups: () => titleLookups.map((ids) => [...ids]),
    scheduleCalls: () => [...scheduleCalls],
    scheduleTasks: () => [...scheduleTasks.values()].map((task) => ({ ...task })),
    dropService: (name) => { delete services[name] },
  }
}
/** Listen on a throwaway port and route through whatever the plugin registered at call time. */
async function listenRoutes(webServer) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const route = webServer.registered.find((entry) => entry.path === (req.url ?? '/').split('?')[0])
      if (!route) {
        res.writeHead(404)
        res.end()
        return
      }
      void route.handler(req, res)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/**
 * Build one self-contained integration harness.
 *
 * options:
 *   token        bearer token the fake server accepts (default integration-token)
 *   label        printed next to the file's passed count
 *   applyOptions extra/override options handed to the plugin's apply()
 *   tempPrefix   prefix of the throwaway dshHome directory
 *
 * Returns the fake services and their accessors, the context, the mounted
 * routes, an rpc()/call() pair, check()/finish() for the file's CI output, and
 * close() to dispose the plugin and remove the temporary home.
 */
export async function createPluginHarness(options = {}) {
  const { token = 'integration-token', label, applyOptions = {}, tempPrefix = 'dsh-mcp-test-' } = options
  const dir = await mkdtemp(join(tmpdir(), tempPrefix))
  const endpointFile = join(dir, 'dsh-mcp-endpoint.json')
  const fake = makeServices()
  const hooks = new Map()
  const disposers = []
  const ctx = makeContext(fake.services, disposers, hooks)
  // The plugin publishes its endpoint URL here; start from a clean shelf so one
  // test's URL cannot leak into another's assertion.
  delete process.env.DSH_MCP_URL
  apply(ctx, {
    token,
    endpointFile,
    url: 'http://127.0.0.1:9',
    dshHome: dir,
    clientsFlushMs: 20,
    configMaxBodyBytes: 2048,
    ...applyOptions,
  })

  const webServer = fake.webServer
  const routes = webServer.registered
  const mcpRoute = routes.find((entry) => entry.path === '/mcp')
  const configRoute = routes.find((entry) => entry.path === '/mcp-config')
  assert.equal(routes.length, 2, 'the plugin registers the MCP route and its configuration route')
  assert.equal(mcpRoute.kind, 'exact')
  assert.equal(configRoute.kind, 'exact')

  const server = await listenRoutes(webServer)
  const origin = 'http://127.0.0.1:' + server.address().port
  const address = origin + '/mcp'
  const configUrl = origin + '/mcp-config'

  let id = 0
  const nextId = () => ++id

  async function rpc(message, { headers: extraHeaders = {} } = {}) {
    const response = await fetch(address, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...extraHeaders },
      body: JSON.stringify(message),
    })
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }

  async function call(name, args, options) {
    const body = await rpc({ jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name, arguments: args } }, options)
    assert.ok(!body.error, name + ' returned a protocol error: ' + JSON.stringify(body.error))
    assert.ok(!body.result.isError, name + ' returned a tool error: ' + body.result.content?.[0]?.text)
    return body.result.structuredContent ?? JSON.parse(body.result.content[0].text)
  }

  const checks = []
  async function check(name, fn) {
    if (fn) await fn()
    checks.push(name)
    return name
  }

  function finish() {
    for (const name of checks) process.stdout.write('ok - ' + name + '\n')
    const suffix = label ? ' (' + label + ')' : ''
    process.stdout.write('\n' + checks.length + ' integration checks passed' + suffix + '\n')
    return checks.length
  }

  let disposed = false
  async function disposeAll() {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) await dispose?.()
  }

  async function close() {
    await disposeAll()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }

  return {
    ...fake,
    dir,
    endpointFile,
    ctx,
    hooks,
    disposers,
    routes,
    mcpRoute,
    configRoute,
    server,
    address,
    configUrl,
    nextId,
    rpc,
    call,
    check,
    finish,
    disposeAll,
    close,
  }
}
