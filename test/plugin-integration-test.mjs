#!/usr/bin/env node
/**
 * Integration test for the plugin itself: it loads `apply()` with a fake Cordis
 * context, mounts the route it registers on a throwaway HTTP server, and drives
 * a full MCP -> DSH turn end to end.
 *
 * This exercises the exact code the plugin loader loads, including the endpoint
 * file it publishes and the transcript filter, without needing a Harness
 * process. Run: node test/plugin-integration-test.mjs
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClientRegistry, resolveCaller } from '../lib/clients.js'
import { lossless } from '../lib/dsh-tools-bridge.js'
import { groupOwnedSessions } from '../lib/workspace-grouping.js'
import { apply } from '../index.js'

const PROMPT = 'delegate this task'
const REPLY = 'hello from dsh'

/** The DSH agent a local tool call is attributed to. */
const INTERNAL_AGENT = { id: 'agent-live', session: { header: { id: 'live-session', cwd: '/' } } }

/** Minimal fake Cordis context exposing only what the plugin touches. */
function makeContext(services, disposers, hooks = new Map()) {
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
function makeServices() {
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
    catalog: () => ({ defaultPreset: 'workspace-write', defaultOptions: permissionOptions, options: permissionOptions }),
    resolve(name) {
      const spec = presetTable[name]
      if (!spec) throw new Error(`permission: unknown preset "${name}"`)
      return { name, ...spec }
    },
    current: () => callerPreset,
    set(session, name) {
      if (!permissionOptions.some((option) => option.value === name)) {
        throw new Error(`permission: unknown preset "${name}" (known: ${permissionOptions.map((option) => option.value).join(', ')})`)
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
        return (async function* stream() {
          yield snapshot
          await new Promise((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
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
    async list() {
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
      return ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: { id }, title: { title: titleOverrides.get(id) ?? 'Delegated task' } },
      }))
    },
    async listSessions() {
      return [{ header: { id: currentSessionId }, live: true, persisted: true }]
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
      { options: { id: 'dsh-mcp-server', name: '@local/dsh-mcp-server' } },
    ],
    async edit(entry, change) {
      const next = change({}, {})
      configEdits.push({ entry, next })
      return next
    },
  }

  /** The browser module registry: what serves this bundle's client half. */
  const clientModules = {
    clientPath: (id) => (id === '@local/dsh-mcp-server' ? '/tmp/pkg/lib/client.js' : undefined),
    graph: () => ({ entries: [{ id: '@local/dsh-mcp-server' }, { id: '@deepseek-ai/dsh-client-ui-theme' }] }),
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

  return {
    services: {
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
      agentDefaultModel: { currentSelection: () => ({ ...defaultSelection }) },
      setDefaultSelection: (selection) => { defaultSelection = selection },
      setSelectModelFailure: (value) => { selectModelFailure = value === true },
    },
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
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-test-'))
const endpointFile = join(dir, 'dsh-mcp-endpoint.json')
const { services, webServer, getPrompt, setBusy, archivedIds, appliedPermissions, modelSelections, cancelledSessions, setRunning, setHang, seedMessages, seedEvents, addSyntheticSessions, resolvedAgents, listedCommandAgents, executedCommands, currentId, registeredTools, makeAgent, agentTools, configEdits, setCallerMode, setCallerPreset, injectedMessages, workspaces, workspaceCalls, followRequests } = makeServices()
let sessionIdFromRun
const disposers = []
const ctx = makeContext(services, disposers)

apply(ctx, { token: 'integration-token', endpointFile, url: 'http://127.0.0.1:9', dshHome: dir, clientsFlushMs: 20, configMaxBodyBytes: 2048 })

const mcpRoute = webServer.registered.find((entry) => entry.path === '/mcp')
const configRoute = webServer.registered.find((entry) => entry.path === '/mcp-config')
assert.equal(webServer.registered.length, 2, 'the plugin registers the MCP route and its configuration route')
assert.equal(mcpRoute.kind, 'exact')
assert.equal(configRoute.kind, 'exact')

const port = await new Promise((resolve) => {
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
const address = `http://127.0.0.1:${port.address().port}/mcp`

async function rpc(message, { headers: extraHeaders = {} } = {}) {
  const response = await fetch(address, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer integration-token', ...extraHeaders },
    body: JSON.stringify(message),
  })
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

let id = 0
async function call(name, args, options) {
  const body = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, options)
  assert.ok(!body.error, `${name} returned a protocol error: ${JSON.stringify(body.error)}`)
  assert.ok(!body.result.isError, `${name} returned a tool error: ${body.result.content?.[0]?.text}`)
  return body.result.structuredContent ?? JSON.parse(body.result.content[0].text)
}

const checks = []
try {
  const init = await rpc({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
  assert.equal(init.result.serverInfo.name, 'dsh-mcp-server')
  checks.push('initialize over the route the plugin registered')

  const run = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' })
  assert.equal(run.status, 'completed')
  assert.equal(run.text, REPLY)
  assert.equal(getPrompt(), PROMPT)
  sessionIdFromRun = run.sessionId
  checks.push('dsh_run_prompt creates a session and returns the final assistant text')

  const read = await call('dsh_read_session', { sessionId: sessionIdFromRun, limit: 0 })
  assert.deepEqual(read.messages, [
    { role: 'user', text: PROMPT, seq: 2 },
    { role: 'assistant', text: REPLY, seq: 3 },
  ])
  checks.push('dsh_read_session returns only user-authored and assistant messages')

  const sessions = await call('dsh_list_sessions', { limit: 5 })
  assert.equal(sessions.sessions[0].title, 'Delegated task')
  assert.equal(sessions.sessions[0].running, false)
  checks.push('dsh_list_sessions joins the session title')

  // --- waiting for a turn -----------------------------------------------------
  const idleWait = await call('dsh_wait_session', { sessionId: sessionIdFromRun })
  assert.equal(idleWait.status, 'idle')
  assert.equal(idleWait.running, false)
  assert.equal(idleWait.text, '')
  checks.push('dsh_wait_session returns immediately when no turn is running')

  setRunning(true)
  const waited = await call('dsh_wait_session', { sessionId: sessionIdFromRun, limit: 5 })
  assert.equal(waited.status, 'completed')
  assert.equal(waited.running, false)
  assert.match(waited.text, /hello from dsh/)
  assert.equal(waited.messages.at(-1).text, REPLY)
  assert.deepEqual(cancelledSessions(), [])
  checks.push('dsh_wait_session follows a running turn to its end and returns its text')

  // A subagent session is followed through its durable parent address: the API
  // controller refuses the plain session form for those.
  const liveRow = services.sessions.get(sessionIdFromRun)
  liveRow.header = { ...liveRow.header, origin: 'subagent', parentSession: 'parent-one' }
  setRunning(true)
  const subagentWait = await call('dsh_wait_session', { sessionId: sessionIdFromRun })
  assert.equal(subagentWait.status, 'completed')
  assert.equal(followRequests().at(-1).address.kind, 'subagent')
  assert.equal(followRequests().at(-1).address.parentSessionId, 'parent-one')
  liveRow.header = { ...liveRow.header, origin: undefined, parentSession: undefined }
  checks.push('a subagent session is followed through its parent address')

  setRunning(true)
  setHang(true)
  const ceiling = await call('dsh_wait_session', { sessionId: sessionIdFromRun, timeoutMs: 1000 })
  assert.equal(ceiling.status, 'timedOut')
  assert.equal(ceiling.running, true)
  assert.match(ceiling.note, /Call dsh_wait_session again/)
  assert.deepEqual(cancelledSessions(), [])
  checks.push('a waiter that hits its ceiling reports timedOut and cancels nothing')

  const promptCeiling = await call('dsh_continue_session', { sessionId: sessionIdFromRun, prompt: PROMPT, timeoutMs: 1000 })
  assert.equal(promptCeiling.status, 'timeout')
  assert.match(promptCeiling.note, /still running/)
  assert.deepEqual(cancelledSessions(), [])
  checks.push('a waited prompt that hits its ceiling leaves the turn running too')

  setHang(false)
  setRunning(false)

  const status = await call('dsh_status', {})
  assert.equal(status.defaultModel.model, 'deepseek-v4.1-flash-anthropic')
  assert.equal(status.toolNames.length, 18)
  assert.equal(status.defaultPermissionPreset, 'workspace-write')
  assert.deepEqual(status.permissionPresets.map((option) => option.value), ['read-only', 'workspace-write', 'danger-full-access'])
  checks.push('dsh_status reports the default model, tool names, and permission presets')

  const tools = await call('dsh_list_tools', {})
  assert.equal(tools.tools[0].name, 'read_file')
  checks.push('dsh_list_tools lists native Harness tools')

  const listedBefore = await call('dsh_list_sessions', { limit: 5 })
  assert.equal(listedBefore.sessions[0].archived, false)
  checks.push('dsh_list_sessions reports archival state')

  setBusy(true)
  const refused = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'dsh_archive_session', arguments: { sessionId: sessionIdFromRun } } })
  assert.ok(refused.result?.isError, 'a session with running work must refuse a plain archive')
  assert.match(refused.result.content[0].text, /stopActivity/)
  checks.push('dsh_archive_session refuses running work and names stopActivity')

  const stopped = await call('dsh_archive_session', { sessionId: sessionIdFromRun, stopActivity: true })
  assert.equal(stopped.archived, true)
  assert.equal(archivedIds().includes(sessionIdFromRun), true)
  setBusy(false)
  checks.push('dsh_archive_session archives with stopActivity')

  const hidden = await call('dsh_list_sessions', { limit: 5 })
  assert.equal(hidden.count, 0)
  assert.equal(hidden.archivedHidden, 1)
  checks.push('dsh_list_sessions hides archived sessions by default')

  const withArchived = await call('dsh_list_sessions', { limit: 5, includeArchived: true })
  assert.equal(withArchived.sessions[0].archived, true)
  checks.push('dsh_list_sessions includeArchived marks sessions archived')

  const archivedRead = await call('dsh_read_session', { sessionId: sessionIdFromRun, limit: 0 })
  assert.ok(archivedRead.messages.length > 0)
  checks.push('a transcript stays readable while its session is archived')

  const restored = await call('dsh_unarchive_session', { sessionId: sessionIdFromRun })
  assert.equal(restored.archived, false)
  const listedAgain = await call('dsh_list_sessions', { limit: 5 })
  assert.equal(listedAgain.count, 1)
  assert.equal(listedAgain.sessions[0].archived, false)
  checks.push('dsh_unarchive_session restores the session to the listing')

  // --- permission presets -----------------------------------------------------
  const roster = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} })
  const runPromptSchema = roster.result.tools.find((entry) => entry.name === 'dsh_run_prompt')
  assert.ok(runPromptSchema?.inputSchema.properties.permissionPreset, 'dsh_run_prompt must accept permissionPreset')
  const continueSchema = roster.result.tools.find((entry) => entry.name === 'dsh_continue_session')
  assert.ok(continueSchema?.inputSchema.properties.permissionPreset, 'dsh_continue_session must accept permissionPreset')
  checks.push('tools/list advertises permissionPreset on both prompt tools')

  const presets = await call('dsh_list_permission_presets', {})
  assert.equal(presets.defaultPreset, 'workspace-write')
  assert.deepEqual(presets.presets.map((option) => option.value), ['read-only', 'workspace-write', 'danger-full-access'])
  checks.push('dsh_list_permission_presets returns the deployment catalog')

  const pinned = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp', permissionPreset: 'read-only' })
  assert.equal(pinned.permissionPreset, 'read-only')
  assert.deepEqual(appliedPermissions(), ['read-only'])
  const pinnedRead = await call('dsh_read_session', { sessionId: pinned.sessionId, limit: 0 })
  assert.equal(pinnedRead.permissionPreset, 'read-only')
  checks.push('dsh_run_prompt applies permissionPreset and the transcript folds it back')

  const createdModels = modelSelections().map((entry) => `${entry.provider}/${entry.model}`)
  assert.deepEqual(createdModels, [
    'deepseek-official/deepseek-v4.1-flash-anthropic',
    'deepseek-official/deepseek-v4.1-flash-anthropic',
  ])
  checks.push('dsh_run_prompt pins the default model on each new session')

  const repinned = await call('dsh_continue_session', { sessionId: pinned.sessionId, prompt: PROMPT, permissionPreset: 'danger-full-access' })
  assert.equal(repinned.permissionPreset, 'danger-full-access')
  assert.deepEqual(appliedPermissions(), ['read-only', 'danger-full-access'])
  const repinnedRead = await call('dsh_read_session', { sessionId: pinned.sessionId, limit: 0 })
  assert.equal(repinnedRead.permissionPreset, 'danger-full-access')
  checks.push('dsh_continue_session re-pins permissionPreset on an existing session')

  assert.equal(modelSelections().length, 2, 'continuing without "model" must not re-pin the session model')
  checks.push('dsh_continue_session without "model" leaves the session model alone')

  const switched = await call('dsh_continue_session', { sessionId: pinned.sessionId, prompt: PROMPT, model: 'anthropic/claude-opus-5-5' })
  assert.equal(switched.status, 'completed')
  assert.deepEqual(
    { provider: modelSelections().at(-1).provider, model: modelSelections().at(-1).model },
    { provider: 'anthropic', model: 'claude-opus-5-5' },
  )
  checks.push('dsh_continue_session applies an explicit "model" override')

  const unknownPreset = await rpc({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: { name: 'dsh_run_prompt', arguments: { prompt: PROMPT, cwd: '/tmp', permissionPreset: 'no-such-preset' } },
  })
  assert.ok(unknownPreset.result?.isError, 'an unknown permission preset must fail the call')
  assert.match(unknownPreset.result.content[0].text, /no-such-preset/)
  assert.match(unknownPreset.result.content[0].text, /read-only/)
  checks.push('an unknown permission preset fails and lists the available ones')

  const cold = await call('dsh_continue_session', { sessionId: 'session-cold', prompt: PROMPT, permissionPreset: 'workspace-write' }, { headers: { 'x-dsh-mcp-client': 'claude-code' } })
  assert.equal(cold.permissionPreset, 'workspace-write')
  assert.equal(cold.owner.id, 'claude-code')
  assert.equal(cold.owner.adopted, true)
  assert.deepEqual(resolvedAgents(), ['session-cold'])
  assert.deepEqual(appliedPermissions(), ['read-only', 'danger-full-access', 'workspace-write'])
  checks.push('a session the store does not hold is resumed through resolveAgent before pinning')

  assert.equal(modelSelections().length, 3, 'a resumed session without "model" must not re-pin the session model')
  checks.push('resuming a session without "model" leaves its model alone')

  // The Harness default is volatile: a model the user picks after this plugin
  // started must be used by the next session rather than a value captured at
  // activation.
  services.setDefaultSelection({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash-1017-anthropic' })
  const liveStatus = await call('dsh_status', {})
  assert.equal(liveStatus.defaultModel.model, 'deepseek-v4.1-flash-1017-anthropic', 'dsh_status reads the model at call time')
  const liveModel = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' })
  assert.equal(liveModel.status, 'completed')
  assert.equal(modelSelections().at(-1).model, 'deepseek-v4.1-flash-1017-anthropic', 'a new session follows the live default')
  checks.push('the default model is resolved at call time')

  // A default that went stale (a retired pair) must not cost the session: the
  // Host keeps its own default and the call still completes.
  services.setSelectModelFailure(true)
  const staleDefault = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' })
  assert.equal(staleDefault.status, 'completed', 'a stale default model does not fail the session')
  services.setSelectModelFailure(false)
  services.setDefaultSelection({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash-anthropic' })
  checks.push('a stale default model is logged instead of failing the prompt')

  // --- caller identity and session ownership ----------------------------------
  const codex = { headers: { 'x-dsh-mcp-client': 'codex' } }
  const claude = { headers: { 'x-dsh-mcp-client': 'claude-code' } }

  // A labelled caller must never inherit the version of whatever `clientInfo` shares
  // its transport fingerprint — the first rung is authoritative, version included.
  await rpc(
    {
      jsonrpc: '2.0',
      id: ++id,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } },
    },
    { headers: { 'x-dsh-mcp-client': 'stdio-bridge' } },
  )
  const bridged = await call('dsh_whoami', {}, { headers: { 'x-dsh-mcp-client': 'stdio-bridge' } })
  assert.equal(bridged.client.name, 'stdio-bridge')
  assert.equal(bridged.client.source, 'header')
  assert.equal(bridged.client.version, undefined, 'an explicit label must not borrow a cached clientInfo version')
  checks.push('an explicit label never inherits another client version')


  // Node's fetch sends a User-Agent, so an unlabelled caller lands on that rung of
  // the ladder rather than the bare peer fallback.
  const anonymous = await call('dsh_whoami', {})
  assert.ok(
    ['user-agent', 'peer'].includes(anonymous.client.source),
    `unexpected identity source: ${anonymous.client.source}`,
  )
  assert.notEqual(anonymous.client.id, 'codex')
  assert.notEqual(anonymous.client.id, 'claude-code')
  checks.push('a caller that sends no label falls back to User-Agent or the auth peer')

  const claudeWho = await call('dsh_whoami', {}, claude)
  assert.equal(claudeWho.client.id, 'claude-code')
  assert.equal(claudeWho.client.source, 'header')
  assert.deepEqual(claudeWho.ownedSessions.map((entry) => entry.sessionId), ['session-cold'])
  checks.push('dsh_whoami names the caller and lists the session it adopted')

  const codexWho = await call('dsh_whoami', {}, codex)
  assert.equal(codexWho.ownedSessionCount, 0)
  checks.push('a caller owns nothing before it creates a session')

  const versionedLabel = await call('dsh_whoami', {}, { headers: { 'x-dsh-mcp-client': 'claude-code@2.1.295' } })
  assert.equal(versionedLabel.client.id, 'claude-code')
  assert.equal(versionedLabel.client.name, 'claude-code')
  assert.equal(versionedLabel.client.version, '2.1.295')
  checks.push('a header label may state its version as name@version')


  const created = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' }, codex)
  assert.equal(created.owner.id, 'codex')
  const mine = await call('dsh_list_sessions', { limit: 20, mine: true }, codex)
  assert.deepEqual(mine.sessions.map((session) => session.sessionId), [created.sessionId])
  assert.equal(mine.sessions[0].mine, true)
  assert.equal(mine.sessions[0].owner.id, 'codex')
  const byOwner = await call('dsh_list_sessions', { limit: 20, owner: 'codex' }, claude)
  assert.deepEqual(byOwner.sessions.map((session) => session.sessionId), [created.sessionId])
  checks.push('dsh_run_prompt records the creating agent, and mine/owner filter the listing')

  const other = await call('dsh_list_sessions', { limit: 20 }, claude)
  assert.equal(other.sessions[0].owner.id, 'codex')
  assert.equal(other.sessions[0].mine, false)
  assert.deepEqual((await call('dsh_list_sessions', { limit: 20, mine: true }, claude)).sessions, [])
  checks.push('another caller sees the owner but never counts that session as its own')

  await new Promise((resolve) => setTimeout(resolve, 80))
  const persisted = createClientRegistry({ file: join(dir, 'mcp', 'dsh-mcp-clients.json') })
  persisted.load()
  assert.equal(persisted.ownerOf(created.sessionId)?.ownerId, 'codex')
  assert.ok(persisted.clientOf('claude-code'))
  assert.ok(persisted.clientOf(anonymous.client.id))
  checks.push('the caller registry is persisted and reloads after a restart')

  const evictionDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-evict-'))
  const evictionFile = join(evictionDir, 'clients.json')
  const eviction = createClientRegistry({ file: evictionFile, flushMs: 0 })
  for (let index = 0; index < 70; index += 1) {
    const caller = { id: `client-${index}`, name: `client-${index}`, source: 'header' }
    eviction.touch(caller)
    eviction.claim(`session-${index}`, caller, {})
  }
  eviction.flush()
  const reloadedRegistry = createClientRegistry({ file: evictionFile })
  reloadedRegistry.load()
  assert.equal(reloadedRegistry.ownerOf('session-0')?.ownerId, 'client-0', 'a client LRU eviction does not orphan its sessions')
  await rm(evictionDir, { recursive: true, force: true })
  checks.push('the persisted registry keeps session ownership when the client LRU turns over')

  const identityCache = new Map()
  resolveCaller({ headers: { 'user-agent': 'shared-agent' }, clientInfo: { name: 'victim' } }, identityCache)
  const unrelatedCaller = resolveCaller({ headers: { 'user-agent': 'shared-agent' } }, identityCache)
  assert.notEqual(unrelatedCaller.name, 'victim', 'a shared User-Agent is not an identity cache key')
  const labelledCaller = resolveCaller({ headers: { 'x-dsh-mcp-client': 'bridge' }, clientInfo: { name: 'bridge', version: '1' } }, identityCache)
  const labelledAgain = resolveCaller({ headers: { 'x-dsh-mcp-client': 'bridge' } }, identityCache)
  assert.equal(labelledCaller.name, 'bridge')
  assert.equal(labelledAgain.version, '1', 'an explicit label still remembers its clientInfo')
  checks.push('clientInfo is cached only for an explicit client label')

  // --- restrictToOwner --------------------------------------------------------
  const strictDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-strict-'))
  const strict = makeServices()
  const strictDisposers = []
  apply(makeContext(strict.services, strictDisposers), {
    token: 'strict-token',
    // Some deployments do not want their sidebar grown by automation.
    groupSessions: false,
    endpointFile: join(strictDir, 'dsh-mcp-endpoint.json'),
    url: 'http://127.0.0.1:9',
    dshHome: strictDir,
    restrictToOwner: true,
  })
  const strictServer = await new Promise((resolve) => {
    const server = createServer((req, res) => { void strict.webServer.registered[0].handler(req, res) })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const strictAddress = `http://127.0.0.1:${strictServer.address().port}/mcp`
  const strictCall = async (name, args, headers) => {
    const response = await fetch(strictAddress, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer strict-token', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    })
    return JSON.parse(await response.text())
  }
  const strictCreated = await strictCall('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' }, { 'x-dsh-mcp-client': 'codex' })
  const strictSession = strictCreated.result.structuredContent.sessionId
  const borrowed = await strictCall('dsh_read_session', { sessionId: strictSession }, { 'x-dsh-mcp-client': 'claude-code' })
  assert.ok(borrowed.result.isError, 'a restricted endpoint must refuse another caller')
  assert.match(borrowed.result.content[0].text, /restrictToOwner/)
  assert.deepEqual(
    (await strictCall('dsh_list_sessions', { limit: 20 }, { 'x-dsh-mcp-client': 'claude-code' })).result.structuredContent.sessions,
    [],
  )
  assert.deepEqual(
    (await strictCall('dsh_list_sessions', { limit: 20 }, { 'x-dsh-mcp-client': 'codex' })).result.structuredContent.sessions.map((session) => session.sessionId),
    [strictSession],
  )
  const ownerProbe = await strictCall('dsh_list_sessions', { owner: 'codex' }, { 'x-dsh-mcp-client': 'claude-code' })
  assert.ok(ownerProbe.result.isError, 'a restricted caller cannot select another owner')
  assert.match(ownerProbe.result.content[0].text, /owner/)
  const ownerSearch = await strictCall('dsh_search_sessions', { query: 'task', owner: 'codex' }, { 'x-dsh-mcp-client': 'claude-code' })
  assert.ok(ownerSearch.result.isError, 'a restricted caller cannot search another owner s sessions')
  checks.push('restrictToOwner confines every caller to the sessions it created, and the owner filter cannot widen it')
  assert.equal(strict.workspaceCalls().length, 0, 'groupSessions: false leaves the sidebar alone')
  checks.push('groupSessions: false keeps sessions out of the project sidebar')
  for (const dispose of strictDisposers) await dispose?.()
  await new Promise((resolve) => strictServer.close(resolve))
  await rm(strictDir, { recursive: true, force: true })

  // --- answering pending decisions ---------------------------------------------
  const answerRefused = await rpc({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: { name: 'dsh_answer_request', arguments: { requestId: 'anything' } },
  })
  assert.ok(answerRefused.result?.isError, 'answering must be refused while the flag is off')
  assert.match(answerRefused.result.content[0].text, /answerUserRequests/)
  checks.push('dsh_answer_request refuses to answer unless the deployment opts in')

  const responderDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-responder-'))
  const responder = makeServices()
  const responderHooks = new Map()
  const responderDisposers = []
  apply(makeContext(responder.services, responderDisposers, responderHooks), {
    token: 'responder-token',
    endpointFile: join(responderDir, 'dsh-mcp-endpoint.json'),
    url: 'http://127.0.0.1:9',
    dshHome: responderDir,
    answerUserRequests: true,
    requestAnswerTimeoutMs: 60_000,
  })
  const responderServer = await new Promise((resolve) => {
    const server = createServer((req, res) => { void responder.webServer.registered[0].handler(req, res) })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const responderAddress = `http://127.0.0.1:${responderServer.address().port}/mcp`
  const responderCall = async (name, args, headers) => {
    const response = await fetch(responderAddress, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer responder-token', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    })
    return JSON.parse(await response.text())
  }
  assert.equal(typeof responderHooks.get('approval/request'), 'function')
  assert.equal(typeof responderHooks.get('user-questions/request'), 'function')
  checks.push('an opted-in endpoint composes both Cordis waterfall answerers')

  const owned = await responderCall('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' }, { 'x-dsh-mcp-client': 'responder' })
  const ownedSession = owned.result.structuredContent.sessionId
  responder.seedEvents([
    { type: 'approval/asked', data: { id: 'audit-1', toolName: 'bash', callId: 'call-park', reason: 'escalate sandbox' } },
  ])

  let delegated = false
  const approvalNext = async () => { delegated = true; return 'unavailable' }
  const pendingOutcome = responderHooks.get('approval/request')(
    { agent: { session: { id: ownedSession } }, toolName: 'bash', callId: 'call-park', reason: 'escalate sandbox' },
    approvalNext,
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  const parkedListing = await responderCall('dsh_list_requests', { sessionId: ownedSession })
  const parkedRow = parkedListing.result.structuredContent.sessions[0]?.pending?.approvals?.[0]
  assert.equal(parkedRow.id, 'audit-1')
  assert.equal(parkedRow.answerable, true)
  assert.equal(delegated, true, 'the other answerers must still be asked')
  checks.push('a parked approval is listed as answerable while the GUI answerer keeps its chance')

  const allowed = await responderCall('dsh_answer_request', { requestId: 'audit-1', decision: 'allow' })
  assert.equal(allowed.result.structuredContent.outcome, 'allowed-once')
  assert.equal(await pendingOutcome, 'allowed-once')
  checks.push('dsh_answer_request settles a parked approval with a one-shot grant')

  const denied = responderHooks.get('approval/request')(
    { agent: { session: { id: ownedSession } }, toolName: 'bash', callId: 'call-park-2' },
    async () => 'unavailable',
  )
  const denyCall = await responderCall('dsh_answer_request', { requestId: 'call-park-2', decision: 'deny' })
  assert.equal(denyCall.result.structuredContent.outcome, 'rejected')
  assert.equal(await denied, 'rejected')
  checks.push('a denied approval resolves as rejected')

  const foreign = await responderHooks.get('approval/request')(
    { agent: { session: { id: 'session-someone-else' } }, toolName: 'bash', callId: 'call-foreign' },
    async () => 'unavailable',
  )
  assert.equal(await foreign, 'unavailable')
  const foreignAnswer = await responderCall('dsh_answer_request', { requestId: 'call-foreign', decision: 'allow' })
  assert.ok(foreignAnswer.result.isError, 'a session this endpoint does not drive is never parked')
  checks.push('a request from a session this endpoint does not drive is delegated untouched')

  // An approval grants a sandbox strictly wider than the asking session's, so an
  // internal caller below the widest rung could exceed its own authority by
  // granting it; the local surface refuses that and leaves the GUI in the race.
  const internalApproval = responderHooks.get('approval/request')(
    { agent: { session: { id: ownedSession } }, toolName: 'bash', callId: 'call-internal-approval' },
    async () => 'unavailable',
  )
  // Parking is awaited inside the answerer, so give it the microtask the other
  // answerers get before the decision is asked for.
  await new Promise((resolve) => setTimeout(resolve, 30))
  const internalAnswer = (name, args) => {
    const definition = responder.registeredTools().find((tool) => tool.name === 'dsh_mcp_call')
    assert.ok(definition, 'the responder front door exposes dsh_mcp_call')
    return definition.execute({ tool: name, arguments: args }, { agent: INTERNAL_AGENT })
  }
  responder.setCallerMode('workspace-write')
  const refusedApproval = await internalAnswer('dsh_answer_request', { requestId: 'call-internal-approval', decision: 'allow' })
    .then(() => undefined, (error) => error)
  assert.ok(refusedApproval, 'an internal caller below the widest rung must not settle an approval')
  assert.match(String(refusedApproval.message), /cannot settle an approval/)
  // The refusal must leave the decision parked and unresolved: the same request
  // still settles once the caller holds the widest rung, and only then.
  responder.setCallerMode('danger-full-access')
  const grantedApproval = await internalAnswer('dsh_answer_request', { requestId: 'call-internal-approval', decision: 'allow' })
  assert.equal(grantedApproval.outcome, 'allowed-once')
  assert.equal(await internalApproval, 'allowed-once')
  checks.push('an internal caller settles an approval only when it already holds the widest mode')

  const questionOutcome = responderHooks.get('user-questions/request')(
    {
      agent: { session: { id: ownedSession } },
      questions: [{ id: 'q-ship', question: 'Ship it?', options: [{ label: 'yes' }, { label: 'no' }] }],
      wait: { callId: 'call-q-live' },
    },
    async () => { throw new Error('no user-questions answerer accepted the request') },
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  const badAnswers = await responderCall('dsh_answer_request', { requestId: 'call-q-live', answers: [] })
  assert.ok(badAnswers.result.isError, 'a question needs an answer batch')
  assert.match(badAnswers.result.content[0].text, /answers/)
  const answered = await responderCall('dsh_answer_request', {
    requestId: 'call-q-live',
    answers: [{ id: 'q-ship', selected: ['yes'] }],
  })
  assert.deepEqual(answered.result.structuredContent.answers, [{ id: 'q-ship', selected: ['yes'] }])
  assert.deepEqual(await questionOutcome, { answers: [{ id: 'q-ship', selected: ['yes'] }] })
  checks.push('dsh_answer_request answers a parked question in service vocabulary')

  // A plain blocking question carries no wait.callId: the parked id must be the durable
  // sub-call id so dsh_list_requests and dsh_answer_request agree.
  responder.seedEvents([
    { type: 'tool/ptc-dispatch-start', data: { name: 'ask_user_question', subCallId: 'call-q-block:ptc:1', arguments: { questions: [{ id: 'q-block', question: 'Blocked?' }] } } },
  ])
  const blockingQuestion = responderHooks.get('user-questions/request')(
    { agent: { session: { id: ownedSession } }, questions: [{ id: 'q-block', question: 'Blocked?' }] },
    async () => { throw new Error('no user-questions answerer accepted the request') },
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  const blockingListing = await responderCall('dsh_list_requests', { sessionId: ownedSession })
  const blockingRow = blockingListing.result.structuredContent.sessions[0].pending.questions.find((row) => row.callId === 'call-q-block:ptc:1')
  assert.equal(blockingRow?.answerable, true, 'a blocking question must be parked under its durable id')
  const blockingAnswer = await responderCall('dsh_answer_request', {
    requestId: 'call-q-block:ptc:1',
    answers: [{ id: 'q-block', selected: ['ok'] }],
  })
  assert.deepEqual(blockingAnswer.result.structuredContent.answers, [{ id: 'q-block', selected: ['ok'] }])
  assert.deepEqual(await blockingQuestion, { answers: [{ id: 'q-block', selected: ['ok'] }] })
  checks.push('a blocking question is parked under the id the listing reports')

  const missing = await responderCall('dsh_answer_request', { requestId: 'audit-1', decision: 'allow' })
  assert.ok(missing.result.isError, 'an already settled id cannot be answered twice')
  assert.match(missing.result.content[0].text, /dsh_list_requests/)
  checks.push('an id that is no longer parked fails with a diagnostic')

  for (const dispose of responderDisposers) await dispose?.()
  await new Promise((resolve) => responderServer.close(resolve))
  await rm(responderDir, { recursive: true, force: true })

  // --- progressive disclosure -------------------------------------------------
  seedMessages([
    { role: 'user', text: 'questions-1: start the survey' },
    { role: 'assistant', text: 'questions-2: reading the asset pipeline first' },
    { role: 'user', text: 'questions-3: also check the weapon mount' },
    { role: 'assistant', text: 'questions-4: ' + 'y'.repeat(3000) },
    { role: 'user', text: 'questions-5: needle-marker lives in this message' },
    { role: 'assistant', text: 'questions-6: needle-marker follow-up' },
    { role: 'user', text: 'questions-7: continue' },
    { role: 'assistant', text: 'questions-8: continuing' },
    { role: 'user', text: 'questions-9: continue' },
    { role: 'assistant', text: 'questions-10: continuing' },
    { role: 'user', text: 'questions-11: continue' },
    { role: 'assistant', text: 'questions-12: done' },
  ])

  const outline = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'outline', limit: 50 }, codex)
  assert.equal(outline.mode, 'outline')
  assert.equal(outline.messages.length, outline.matchedMessages)
  assert.ok(outline.messages.every((row) => row.text === undefined && typeof row.preview === 'string' && Number.isInteger(row.chars)))
  assert.ok(outline.messages.some((row) => row.chars > 2000))
  checks.push('an outline read is a compact table of contents, not a transcript dump')

  const tail = await call('dsh_read_session', { sessionId: created.sessionId }, codex)
  assert.equal(tail.mode, 'tail')
  assert.equal(tail.returned, 10)
  assert.ok(tail.totalMessages > tail.returned)
  assert.equal(tail.window.reachedEnd, true)
  assert.ok(tail.window.firstSeq > outline.messages[0].seq)
  checks.push('a default read is a bounded tail window that reports what it left out')

  // `limit: 0` keeps the old "everything" meaning, so this window definitely holds the long turn.
  const cut = await call('dsh_read_session', { sessionId: created.sessionId, limit: 0, maxChars: 100 }, codex)
  const trimmed = cut.messages.find((row) => row.truncated === true)
  assert.ok(trimmed, 'a long message must be flagged when it is cut')
  assert.equal(trimmed.text.length, 100)
  assert.ok(trimmed.chars > 100)
  assert.ok(cut.truncatedMessages >= 1)
  checks.push('long messages are cut at maxChars and report their real length')

  const pageOne = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'head', limit: 4 }, codex)
  const pageTwo = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'head', limit: 4, afterSeq: pageOne.window.nextAfterSeq }, codex)
  assert.ok(pageTwo.messages.length > 0)
  assert.ok(pageTwo.messages.every((row) => row.seq > pageOne.window.nextAfterSeq))
  assert.ok(pageOne.messages.every((row) => row.seq <= pageOne.window.nextAfterSeq))
  checks.push('afterSeq pages forward through a transcript without re-reading it')

  const userOnly = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'outline', limit: 50, roles: ['user'] }, codex)
  assert.ok(userOnly.messages.every((row) => row.role === 'user'))
  checks.push('roles narrows a read to the turns the caller cares about')

  addSyntheticSessions([
    { sessionId: 'session-index-1', title: 'asset pipeline survey', cwd: '/repo/alpha', updatedAt: Date.now() - 1000 },
    { sessionId: 'session-index-2', title: 'weapon mount check', cwd: '/repo/beta', updatedAt: Date.now() - 2000 },
  ])

  const indexPage = await call('dsh_list_sessions', { limit: 1, view: 'index' }, codex)
  assert.equal(indexPage.view, 'index')
  assert.equal(indexPage.count, 1)
  assert.equal('cwd' in indexPage.sessions[0], false)
  assert.ok(indexPage.total >= 3)
  assert.equal(indexPage.nextCursor, 1)
  const secondPage = await call('dsh_list_sessions', { limit: 1, cursor: indexPage.nextCursor, view: 'full' }, codex)
  assert.notEqual(secondPage.sessions[0].sessionId, indexPage.sessions[0].sessionId)
  assert.equal(secondPage.view, 'full')
  assert.equal(typeof secondPage.sessions[0].cwd, 'string')
  checks.push('the session index is compact by default and pages with a cursor')

  const byQuery = await call('dsh_list_sessions', { query: 'weapon', view: 'index' }, codex)
  assert.deepEqual(byQuery.sessions.map((row) => row.sessionId), ['session-index-2'])
  const byCwd = await call('dsh_list_sessions', { query: 'alpha' }, codex)
  assert.deepEqual(byCwd.sessions.map((row) => row.sessionId), ['session-index-1'])
  checks.push('query narrows the index server-side by title and cwd')

  const titleHit = await call('dsh_search_sessions', { query: 'weapon', scope: 'title' }, codex)
  assert.equal(titleHit.matchCount, 1)
  assert.equal(titleHit.matches[0].where, 'title')
  assert.equal(titleHit.matches[0].sessionId, 'session-index-2')
  checks.push('a search matches sessions by title and returns a snippet')

  const messageHit = await call('dsh_search_sessions', { query: 'needle-marker', scope: 'messages' }, codex)
  assert.ok(messageHit.matches.length >= 1)
  assert.ok(messageHit.matches.every((match) => match.where === 'message'))
  assert.ok(messageHit.matches[0].snippet.includes('needle-marker'))
  assert.ok(messageHit.matches[0].snippet.length <= 260)
  assert.ok(messageHit.scanned >= 1)
  checks.push('a search finds message text and returns a bounded snippet, not the transcript')

  const toolQuery = await call('dsh_list_tools', { query: 'read' })
  assert.equal(toolQuery.count, 1)
  assert.equal(toolQuery.tools[0].name, 'read_file')
  checks.push('dsh_list_tools narrows the catalog by query')

  // --- pending user decisions --------------------------------------------------
  seedEvents([
    { type: 'approval/asked', data: { id: 'app-open', toolName: 'bash', callId: 'call-1', reason: 'escalate sandbox to danger-full-access: ' + 'r'.repeat(400) } },
    { type: 'approval/asked', data: { id: 'app-done', toolName: 'read', callId: 'call-2', reason: 'auto review denied tool "read"' } },
    { type: 'approval/decided', data: { id: 'app-done', outcome: 'cancelled' } },
    { type: 'tool/call', data: { name: 'ask_user_question', callId: 'call-q', arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Ship it?', header: 'Confirm', options: [{ label: 'yes' }, { label: 'no' }] }] }) } },
    { type: 'tool/result', data: { message: { toolCallId: 'call-q', content: [{ type: 'text', text: JSON.stringify({ pending: true }) }] } } },
    { type: 'tool/call', data: { name: 'ask_user_question', callId: 'call-q2', arguments: JSON.stringify({ questions: [{ id: 'q2', question: 'Which one?' }] }) } },
    { type: 'tool/result', data: { message: { toolCallId: 'call-q2', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q2', selected: ['a'] }] }) }] } } },
    { type: 'tool/call', data: { name: 'read_file', callId: 'call-3', arguments: '{}' } },
  ])

  const requests = await call('dsh_list_requests', { sessionId: created.sessionId, includeSettled: true }, codex)
  assert.equal(requests.count, 1)
  assert.equal(requests.sessions[0].sessionId, created.sessionId)
  assert.equal(requests.sessions[0].pending.count, 2)
  assert.deepEqual(requests.sessions[0].pending.approvals.map((row) => row.id), ['app-open'])
  assert.equal(requests.sessions[0].pending.approvals[0].toolName, 'bash')
  assert.ok(requests.sessions[0].pending.approvals[0].reason.length <= 241, 'a long reason must be elided')
  assert.ok(requests.sessions[0].pending.approvals[0].reason.endsWith('…'))
  assert.deepEqual(requests.sessions[0].pending.questions.map((row) => row.callId), ['call-q'])
  assert.equal(requests.sessions[0].pending.questions[0].state, 'continued')
  assert.equal(requests.sessions[0].pending.questions[0].questions[0].question, 'Ship it?')
  assert.deepEqual(requests.sessions[0].settled.approvals.map((row) => row.outcome), ['cancelled'])
  assert.deepEqual(requests.sessions[0].settled.questions.map((row) => row.callId), ['call-q2'])
  checks.push('dsh_list_requests folds pending approvals and questions, and settled ones on request')

  // A PTC agent dispatches the tool itself: the start event is the only trace while
  // the question blocks the turn, and the dispatch closes it.
  seedEvents([
    { type: 'tool/ptc-dispatch-start', data: { name: 'ask_user_question', subCallId: 'call-q3:ptc:1', arguments: { questions: [{ id: 'q3', question: 'Blocked?' }] } } },
  ])
  const blocked = await call('dsh_list_requests', { sessionId: created.sessionId }, codex)
  const blockedRow = blocked.sessions[0].pending.questions.find((row) => row.callId === 'call-q3:ptc:1')
  assert.equal(blockedRow?.state, 'open')
  assert.equal(blockedRow?.questions[0].question, 'Blocked?')
  seedEvents([
    { type: 'tool/ptc-dispatch', data: { name: 'ask_user_question', subCallId: 'call-q3:ptc:1', isError: true, content: [{ type: 'text', text: 'Error: aborted' }] } },
  ])
  const settledBlocked = await call('dsh_list_requests', { sessionId: created.sessionId }, codex)
  assert.equal(
    settledBlocked.sessions[0].pending.questions.some((row) => row.callId === 'call-q3:ptc:1'),
    false,
    'a settled dispatch must close the question',
  )
  checks.push('a PTC-dispatched question is visible while it blocks the turn, and closes when it settles')

  const pendingRead = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'outline', limit: 3 }, codex)
  assert.equal(pendingRead.pending.count, 2)
  assert.equal(pendingRead.pending.approvals[0].id, 'app-open')
  checks.push('a read reports the user decisions the session is blocked on')

  const pendingWait = await call('dsh_wait_session', { sessionId: created.sessionId }, codex)
  assert.equal(pendingWait.status, 'idle')
  assert.equal(pendingWait.pending.count, 2)
  assert.deepEqual(pendingWait.pending.questions.map((row) => row.callId), ['call-q'])
  checks.push('a wait reports pending decisions instead of leaving a blocked turn unexplained')

  const mineRequests = await call('dsh_list_requests', { mine: true, scan: 5 }, codex)
  assert.equal(mineRequests.count, 1)
  assert.equal(mineRequests.includeSettled, undefined)
  assert.equal(mineRequests.sessions[0].settled, undefined)
  checks.push('a request scan is scoped to the caller and omits settled decisions by default')

  // --- commands ---------------------------------------------------------------
  const commandList = await call('dsh_list_commands', { sessionId: currentId() })
  assert.deepEqual(commandList.commands.map((entry) => entry.name), ['compact', 'permission'])
  assert.equal(commandList.count, 2)
  assert.equal(listedCommandAgents()[0].session.id, 'live-session')
  checks.push('dsh_list_commands lists the commands of the session agent')

  const compactRun = await call('dsh_run_command', { sessionId: currentId(), command: 'compact' })
  assert.equal(compactRun.command, '/compact')
  assert.equal(compactRun.kind, 'success')
  assert.match(compactRun.text, /Compacted 3 history items/)
  assert.equal(compactRun.sourceEventSeq, 99)
  assert.ok(compactRun.commandId)
  assert.equal(executedCommands()[0].attachments.length, 0)
  checks.push('dsh_run_command runs a bare command name as /name')

  const permissionRun = await call('dsh_run_command', { sessionId: currentId(), line: '/permission danger-full-access' })
  assert.equal(permissionRun.command, '/permission danger-full-access')
  assert.equal(permissionRun.kind, 'success')
  assert.deepEqual(appliedPermissions(), ['read-only', 'danger-full-access', 'workspace-write', 'danger-full-access'])
  checks.push('dsh_run_command executes /permission through the same write path')

  const unknownCommand = await rpc({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: { name: 'dsh_run_command', arguments: { sessionId: currentId(), command: 'no_such_command' } },
  })
  assert.ok(unknownCommand.result?.isError, 'an unknown command must fail the call')
  assert.match(unknownCommand.result.content[0].text, /no_such_command/)
  assert.match(unknownCommand.result.content[0].text, /compact/)
  checks.push('an unknown command fails and lists the available ones')

  const malformedCommand = await rpc({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: { name: 'dsh_run_command', arguments: { sessionId: currentId(), line: 'compact' } },
  })
  assert.ok(malformedCommand.result?.isError, 'a line without a leading slash must fail the call')
  assert.match(malformedCommand.result.content[0].text, /slash-command line/)
  checks.push('a line without a leading slash is rejected before execution')

  // --- the DSH-facing tool surface ---------------------------------------------
  const listed = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} })
  const mcpNames = listed.result.tools.map((tool) => tool.name).sort()
  assert.equal(mcpNames.length, 18, 'the MCP endpoint publishes eighteen tools')
  assert.ok(mcpNames.includes('dsh_open_session'), 'the GUI jump is part of the published table')

  // The default surface is the front door: three small schemas instead of
  // seventeen, so a session pays for the catalogue only when it needs it.
  assert.deepEqual(
    registeredTools().map((tool) => tool.name).sort(),
    ['dsh_mcp_call', 'dsh_mcp_open', 'dsh_mcp_tools'],
    'the lazy surface registers only the front door',
  )
  const frontDoorCost = registeredTools()
    .reduce((total, tool) => total + tool.description.length + JSON.stringify(tool.parameters).length, 0)
  checks.push(`the default surface is a three-tool front door (${frontDoorCost} chars instead of the full table)`)

  const localStatus = await call('dsh_status', {})
  assert.equal(localStatus.dshTools.enabled, true)
  assert.equal(localStatus.dshTools.mode, 'lazy')
  assert.equal(localStatus.dshTools.published, 18, 'every published tool stays openable')
  assert.deepEqual(localStatus.dshTools.registered.slice().sort(), ['dsh_mcp_call', 'dsh_mcp_open', 'dsh_mcp_tools'])
  assert.equal(localStatus.clientPage.available, true)
  assert.equal(localStatus.clientPage.inGraph, true)
  assert.equal(localStatus.clientPage.bundle, '/tmp/pkg/lib/client.js')
  checks.push('dsh_status reports the surface mode, its size, and the served client page')

  const metaCall = (name, args, agent = INTERNAL_AGENT) => {
    const definition = registeredTools().find((tool) => tool.name === name)
    assert.ok(definition, `the front door exposes ${name}`)
    return definition.execute(args, { agent })
  }
  const dispatch = (tool, args, agent = INTERNAL_AGENT) => metaCall('dsh_mcp_call', { tool, arguments: args }, agent)
  const refusedBy = async (tool, args) => {
    try {
      await dispatch(tool, args)
      return undefined
    } catch (error) {
      return error
    }
  }

  const catalogue = await metaCall('dsh_mcp_tools', {})
  assert.equal(catalogue.total, 18)
  assert.equal(catalogue.count, 18)
  assert.equal(catalogue.tools.every((row) => row.native === false), true, 'nothing is native until it is opened')
  assert.ok(catalogue.tools.every((row) => row.purpose.length > 0 && row.purpose.length < 200), 'a catalogue row stays one line')
  const searched = await metaCall('dsh_mcp_tools', { query: 'transcript' })
  assert.ok(searched.count > 0 && searched.count < 18, 'a query narrows the catalogue')
  const one = await metaCall('dsh_mcp_tools', { name: 'dsh_read_session' })
  assert.equal(one.name, 'dsh_read_session')
  assert.ok(one.parameters.properties.mode, 'a single lookup returns the parameter schema')
  assert.equal(one.parameters.properties.mode.minLength, undefined, 'the schema is projected for the registry')
  const unknownLookup = await metaCall('dsh_mcp_tools', { name: 'nope' }).then(() => undefined, (error) => error)
  assert.match(String(unknownLookup && unknownLookup.message), /not a tool this DSH deployment publishes/)
  checks.push('the catalogue lists narrowly and returns one full schema on demand')

  // The front door carries every published name and its call signature, which
  // is what removes the discovery step: a session reads the tool it needs in
  // the description instead of spending a step asking what exists.
  const frontDoor = registeredTools().find((tool) => tool.name === 'dsh_mcp_tools')
  for (const name of mcpNames) assert.ok(frontDoor.description.includes(name), `${name} is named in the front-door index`)
  assert.match(frontDoor.description, /dsh_continue_session\(sessionId, prompt\)/, 'the index states the required arguments')
  assert.match(frontDoor.description, /dsh_run_command\(sessionId, line\|command\)/, 'a tool whose required list is not its whole signature says so')
  assert.match(frontDoor.description, /dsh_answer_request\(requestId, decision\|answers\)/, 'a decision-shaped tool says which of the two it takes')
  const frontDoorIndexCost = registeredTools()
    .reduce((total, tool) => total + tool.description.length + JSON.stringify(tool.parameters).length, 0)
  const fullTableCost = listed.result.tools
    .reduce((total, tool) => total + tool.description.length + JSON.stringify(tool.inputSchema).length, 0)
  assert.ok(frontDoorIndexCost < 3500, 'the index keeps the front door under 3.5 KB')
  assert.ok(frontDoorIndexCost * 4 < fullTableCost, 'the front door stays a fraction of the full table')
  checks.push(`the front door names all eighteen tools with their signatures (${frontDoorIndexCost} chars vs ${fullTableCost} for the table)`)

  const bareName = await dispatch('whoami', {})
  assert.ok(bareName && typeof bareName === 'object', 'a bare name resolves to the published tool')
  const jsonArgs = await metaCall('dsh_mcp_call', { tool: 'whoami', arguments: '{}' })
  assert.ok(jsonArgs && typeof jsonArgs === 'object', 'a JSON object string is accepted as arguments')
  const nearMiss = await dispatch('read-session', { sessionId: currentId() }).then(() => undefined, (error) => error)
  assert.match(String(nearMiss && nearMiss.message), /did you mean "dsh_read_session"/)
  const nonsense = await dispatch('zzz', {}).then(() => undefined, (error) => error)
  assert.match(String(nonsense && nonsense.message), /not a tool this DSH deployment publishes/)
  checks.push('a bare or near-miss name resolves, or is refused with the close matches named')

  // The two ways a model can lose control of the lazy surface: calling the
  // front door through itself, and opening the whole table without asking.
  const frontDoorCall = await dispatch('dsh_mcp_tools', {}).then(() => undefined, (error) => error)
  assert.match(String(frontDoorCall && frontDoorCall.message), /cannot call the front door itself/)
  const wrongType = await metaCall('dsh_mcp_call', { tool: 42 }).then(() => undefined, (error) => error)
  assert.match(String(wrongType && wrongType.message), /must be a published tool name as a string/)
  const omitOpen = await metaCall('dsh_mcp_open', {}, makeAgent()).then(() => undefined, (error) => error)
  assert.match(String(omitOpen && omitOpen.message), /needs an explicit target/)
  const stringOpen = await metaCall('dsh_mcp_open', { tools: 'dsh_status' }, makeAgent()).then(() => undefined, (error) => error)
  assert.match(String(stringOpen && stringOpen.message), /must be an array of published names/)
  const emptyOpen = await metaCall('dsh_mcp_open', { tools: [] }, makeAgent()).then(() => undefined, (error) => error)
  assert.match(String(emptyOpen && emptyOpen.message), /at least one published name/)
  const openParam = registeredTools().find((tool) => tool.name === 'dsh_mcp_open').parameters.properties.tools.description
  assert.match(openParam, /bare name/, 'the parameter text matches the refusal, not the old "omit opens everything" promise')
  const wholeSet = await metaCall('dsh_mcp_open', { all: true }, makeAgent())
  assert.equal(wholeSet.native.length, 18, 'all: true is still the way to the whole table')
  checks.push('the front-door refusal is reachable, and opening always needs an explicit target')

  // Opening is per agent: the registrations land in the calling agent's own
  // scope, which is what makes DSH announce them as tool additions.
  const agent = makeAgent()
  const opened = await metaCall('dsh_mcp_open', { tools: ['dsh_run_prompt', 'dsh_run_command'] }, agent)
  assert.deepEqual([...opened.opened].sort(), ['dsh_run_command', 'dsh_run_prompt'])
  assert.deepEqual([...opened.native].sort(), ['dsh_run_command', 'dsh_run_prompt'])
  assert.equal(registeredTools().length, 3, 'opening does not grow the global registry')
  assert.deepEqual(agentTools(agent).map((tool) => tool.name).sort(), ['dsh_run_command', 'dsh_run_prompt'])
  const reopened = await metaCall('dsh_mcp_open', { tools: ['dsh_run_prompt'] }, agent)
  assert.deepEqual(reopened.opened, [], 'opening twice registers nothing twice')
  assert.deepEqual(reopened.alreadyOpen, ['dsh_run_prompt'])
  const unknownOpen = await metaCall('dsh_mcp_open', { tools: ['nope'] }, agent).then(() => undefined, (error) => error)
  assert.match(String(unknownOpen && unknownOpen.message), /not a tool this DSH deployment publishes/)
  checks.push('dsh_mcp_open registers the asked-for tools in the calling agent scope, once')

  const openRunner = agentTools(agent).find((tool) => tool.name === 'dsh_run_prompt')
  const openedRun = await openRunner.execute({ prompt: 'opened run', cwd: '/tmp' }, { agent })
  assert.equal(openedRun.status, 'completed')
  checks.push('an opened tool runs natively for that agent')

  setCallerMode('workspace-write')
  setCallerPreset('workspace-write')
  const localRun = await dispatch('dsh_run_prompt', { prompt: 'internal delegation', cwd: '/tmp' })
  assert.equal(localRun.status, 'completed')
  assert.equal(localRun.permissionPreset, 'workspace-write', 'a started session is pinned to the caller preset')
  assert.equal(localRun.owner.id, 'dsh-agent:live-session', 'an internal call is attributed to the calling session')
  checks.push('a dispatched call is attributed to its session and starts pinned to its own preset')

  const widerRefusal = await refusedBy('dsh_run_prompt', { prompt: 'too wide', cwd: '/tmp', permissionPreset: 'danger-full-access' })
  assert.ok(widerRefusal, 'a preset wider than the caller must be refused')
  assert.match(String(widerRefusal.message), /wider than the calling DSH agent/)
  assert.match(String(widerRefusal.message), /dsh_mcp_tools\(\{ name: "dsh_run_prompt" \}\)/, 'a refused call points at the schema that fixes it')
  checks.push('an internal caller cannot grant a preset wider than its own file policy')
  checks.push('a refused dispatched call names the schema that would have been accepted')

  setCallerMode('danger-full-access')
  setCallerPreset('danger-full-access')
  const narrowedPreset = await dispatch('dsh_run_prompt', { prompt: 'narrower', cwd: '/tmp', permissionPreset: 'read-only' })
  assert.equal(narrowedPreset.permissionPreset, 'read-only', 'a narrower preset is not a privilege grant')
  checks.push('an internal caller may still set a preset at or below its own rung')

  setCallerMode('workspace-write')
  setCallerPreset('workspace-write')
  const commandRefusal = await refusedBy('dsh_run_command', { sessionId: currentId(), line: '/permission danger-full-access' })
  assert.ok(commandRefusal, 'a slash command must respect the same ceiling')
  assert.match(String(commandRefusal.message), /wider than the calling DSH agent/)
  checks.push('a /permission slash command cannot bypass the internal ceiling')

  const nativeRefusal = await openRunner
    .execute({ prompt: 'natively too wide', cwd: '/tmp', permissionPreset: 'danger-full-access' }, { agent })
    .then(() => undefined, (error) => error)
  assert.match(String(nativeRefusal && nativeRefusal.message), /wider than the calling DSH agent/)
  checks.push('the ceiling applies to a natively opened tool exactly as to a dispatched one')

  // --- lossless canonical values ------------------------------------------------
  // The registry validates a tool's canonical value, and an internal (PTC) call
  // has no JSON round trip to hide a nested `undefined`: this is the failure
  // the bridge's projection defends against.
  assert.deepEqual(lossless({ a: 1, b: undefined, c: [1, undefined, NaN] }), { a: 1, c: [1, null, null] })
  assert.equal(lossless(undefined), '')
  checks.push('the bridge projects canonical values into lossless JSON')

  const isLossless = (value) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every((entry) => isLossless(entry))
    if (typeof value !== 'object') return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(value).every((entry) => isLossless(entry))
  }
  for (const [name, args] of [
    ['dsh_status', {}],
    ['dsh_list_sessions', { limit: 5 }],
    ['dsh_read_session', { sessionId: currentId(), limit: 2 }],
    ['dsh_whoami', {}],
  ]) {
    const value = await dispatch(name, args)
    assert.ok(isLossless(value), `${name} returned a value an internal call would reject`)
  }
  checks.push('every dispatched result is lossless JSON, so an internal call cannot fail on it')
  assert.equal(Object.values(await dispatch('dsh_status', {})).includes(undefined), false)
  checks.push('dsh_status carries no undefined field for an internal caller')

  // --- workspace grouping -------------------------------------------------------
  // The Web sidebar groups by the Workspace registry's recorded membership, and
  // this endpoint never invents a project: a session whose directory has none is
  // left in "Ungrouped", exactly where the Harness would have put it.
  const unownedDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-ungrouped-'))
  const before = workspaceCalls().filter((call) => call.path === unownedDir).length
  const ungrouped = await dispatch('dsh_run_prompt', { prompt: 'no project for this', cwd: unownedDir })
  assert.equal(ungrouped.workspace, undefined, 'no project is invented for the directory')
  assert.equal(workspaces().some((workspace) => workspace.path === unownedDir), false)
  const lookups = workspaceCalls().slice(before)
  assert.equal(lookups.every((call) => call.op === 'resolve'), true, 'the directory is only looked up')
  checks.push('a session whose directory has no project stays in Ungrouped')

  // A directory that already is a project is joined, because that is what the
  // sidebar shows for every session run there.
  const project = await services.workspaceRegistry.create(unownedDir, 'Existing Project')
  const grouped = await dispatch('dsh_run_prompt', { prompt: 'join the project', cwd: unownedDir })
  assert.equal(grouped.workspace.id, project.id)
  assert.equal(grouped.workspace.created, false, 'the existing project is reused, never recreated')
  assert.equal(grouped.workspace.attached, true)
  assert.deepEqual(workspaces().find((workspace) => workspace.path === unownedDir).sessionIds, [grouped.sessionId])
  checks.push('a session whose directory already has a project joins it')

  const joined = await dispatch('dsh_continue_session', { sessionId: grouped.sessionId, prompt: 'continue' })
  assert.equal(joined.workspace.attached, true)
  assert.equal(joined.workspace.created, false, 'a continuation never invents a project')
  checks.push('a continuation joins the project its directory already has')

  // The one-shot repair: sessions an earlier build created are still ungrouped,
  // and only this endpoint's own registry knows which ones those are.
  const legacyDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-legacy-'))
  const legacyProject = await services.workspaceRegistry.create(legacyDir, 'Legacy Project')
  const repair = await groupOwnedSessions({ get: () => services.workspaceRegistry }, {
    ownedSessions: () => [{ sessionId: 'session-legacy', cwd: legacyDir }],
  })
  assert.equal(repair.considered, 1)
  assert.equal(repair.created, 0, 'the repair creates nothing unless asked to')
  assert.equal(repair.attached, 1)
  assert.deepEqual(workspaces().find((workspace) => workspace.path === legacyDir).sessionIds, ['session-legacy'])
  assert.equal(legacyProject.id, workspaces().find((workspace) => workspace.path === legacyDir).id)
  checks.push('the startup repair attaches sessions to projects that already exist')

  const inventedDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-invented-'))
  const optedIn = await groupOwnedSessions({ get: () => services.workspaceRegistry }, {
    ownedSessions: () => [{ sessionId: 'session-invented', cwd: inventedDir }],
  }, { create: true })
  assert.equal(optedIn.created, 1, 'a deployment that opts in gets a project')
  assert.deepEqual(workspaces().find((workspace) => workspace.path === inventedDir).sessionIds, ['session-invented'])
  checks.push('creating a project is possible only by opting in')

  // --- message delivery and sender attribution ----------------------------------
  const steered = await dispatch('dsh_continue_session', { sessionId: currentId(), prompt: 'steer me', mode: 'steer' })
  assert.equal(steered.mode, 'steer')
  assert.equal(steered.from, 'live-session')
  const steerRow = injectedMessages().at(-1)
  assert.equal(steerRow.mode, 'steer', 'mode: "steer" reaches the agent as a steer')
  assert.equal(steerRow.message.source.kind, 'dsh-mcp-server')
  assert.equal(steerRow.message.source.sessionId, 'live-session', 'the message names the session that sent it')
  checks.push('an internal prompt is delivered as a steer labelled with the sending session')

  await dispatch('dsh_continue_session', { sessionId: currentId(), prompt: 'queue me', mode: 'queue' })
  assert.equal(injectedMessages().at(-1).mode, 'queue', 'mode: "queue" waits for the next turn')
  checks.push('mode: "queue" overrides the deployment setting')

  const followed = await dispatch('dsh_continue_session', { sessionId: currentId(), prompt: 'follow the setting' })
  assert.equal(followed.mode, 'steer', 'without mode the deployment busy-enter setting decides')
  checks.push("without mode the delivery follows this deployment's own busy-Enter setting")

  const externalContinue = await call('dsh_continue_session', { sessionId: currentId(), prompt: 'from an MCP client' })
  assert.equal(externalContinue.mode, 'steer', 'the same policy governs an external caller')
  assert.equal(injectedMessages().at(-1).message.content[0].text !== 'from an MCP client', true, 'an external caller keeps the controller path')
  checks.push('an external MCP caller keeps the unlabelled controller path')

  const statusWithPolicy = await call('dsh_status', {})
  assert.equal(statusWithPolicy.busyMode.configured, 'setting')
  assert.equal(statusWithPolicy.busyMode.effective, 'steer', 'the deployment setting is read live')
  checks.push('dsh_status reports the delivery policy this deployment follows')

  // --- the configuration route the settings page drives -------------------------
  const configUrl = `http://127.0.0.1:${port.address().port}/mcp-config`
  const configRead = await (await fetch(configUrl)).json()
  assert.equal(configRead.exposeToDsh, true)
  assert.equal(configRead.exposeToDshMode, 'lazy')
  assert.deepEqual([...configRead.registered].sort(), ['dsh_mcp_call', 'dsh_mcp_open', 'dsh_mcp_tools'])
  assert.equal(configRead.published.length, 18)
  assert.equal(configRead.configPath, '/mcp-config')
  assert.equal(configRead.clientPage.inGraph, true)
  assert.equal(configRead.busyMode, 'setting')
  assert.equal(configRead.groupSessions, true)
  assert.equal(configRead.createGroups, false, 'inventing a project is off by default')
  checks.push('the configuration route reports the surface, the page, and the delivery policy')

  const configWrite = await (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDsh: false }),
  })).json()
  assert.equal(configWrite.ok, true)
  assert.equal(configWrite.exposeToDsh, false)
  assert.equal(configEdits().length, 1)
  assert.equal(configEdits()[0].entry.options.id, 'dsh-mcp-server')
  assert.equal(configEdits()[0].next.exposeToDsh, false)
  checks.push('the configuration route saves the switch through the profile configuration editor')

  const modeWrite = await (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDshMode: 'full' }),
  })).json()
  assert.equal(modeWrite.ok, true)
  assert.equal(modeWrite.exposeToDshMode, 'full')
  assert.equal(configEdits().length, 2)
  assert.equal(configEdits()[1].next.exposeToDshMode, 'full')
  checks.push('the configuration route saves the surface mode')

  const policyWrite = await (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupSessions: false, createGroups: true, busyMode: 'queue' }),
  })).json()
  assert.equal(policyWrite.ok, true)
  assert.equal(policyWrite.groupSessions, false)
  assert.equal(policyWrite.createGroups, true)
  assert.equal(policyWrite.busyMode, 'queue')
  assert.deepEqual(configEdits().at(-1).next, { groupSessions: false, createGroups: true, busyMode: 'queue' })
  assert.equal(configRead.busyEffective, 'steer', 'the page can show what the setting resolves to')
  checks.push('the configuration route saves the grouping and delivery policies the page offers')

  const policyRefusals = await Promise.all([
    fetch(configUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupSessions: 'yes' }) }),
    fetch(configUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ busyMode: 'always' }) }),
  ])
  assert.deepEqual(policyRefusals.map((response) => response.status), [400, 400])
  checks.push('the configuration route rejects a non-boolean grouping flag and an unknown delivery policy')

  // --- the GUI jump -------------------------------------------------------------
  // The Host cannot push to the page: DSH forwards only a build-time allowlist of
  // events. A command waits on this route for whichever page is open.
  const jump = await dispatch('dsh_open_session', { sessionId: currentId() })
  assert.equal(jump.queued, true)
  assert.equal(jump.sessionId, currentId())
  const pending = await (await fetch(configUrl)).json()
  assert.equal(pending.command.kind, 'open-session')
  assert.equal(pending.command.sessionId, currentId())
  const acknowledged = await (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ackCommand: true }),
  })).json()
  assert.equal(acknowledged.command, null, 'an acknowledged command is consumed')
  const unknownJump = await dispatch('dsh_open_session', { sessionId: 'session-nope' }).then(() => undefined, (error) => error)
  assert.match(String(unknownJump && unknownJump.message), /Unknown session/)
  checks.push('dsh_open_session queues a GUI command for the open page and refuses an unknown session')

  const configRefusal = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDsh: 'yes' }),
  })
  assert.equal(configRefusal.status, 400)
  const modeRefusal = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDshMode: 'sometimes' }),
  })
  assert.equal(modeRefusal.status, 400)
  const emptyRefusal = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(emptyRefusal.status, 400)
  const relativeRemoval = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ removeGroups: ['not/absolute'] }),
  })
  assert.equal(relativeRemoval.status, 400)
  const unknownField = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDsh: true, typo: 1 }),
  })
  assert.equal(unknownField.status, 400, 'an unknown field is refused instead of being ignored')
  const notJson = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ ackCommand: true }),
  })
  assert.equal(notJson.status, 415, 'a CORS-simple body type is refused')
  const foreignOrigin = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ ackCommand: true }),
  })
  assert.equal(foreignOrigin.status, 403, 'a foreign browser origin is refused')
  const oversized = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ openSession: 'x'.repeat(5000) }),
  })
  assert.equal(oversized.status, 413, 'an oversized body gets a 413, not a reset socket')
  const oversizedBody = await oversized.json()
  assert.match(String(oversizedBody.error), /2048/, 'the ceiling is the configured one, not the built-in default')
  checks.push('the configuration route rejects a non-boolean, an unknown mode, an empty patch, a relative path, unknown fields, non-JSON bodies, foreign origins, and oversized bodies')

  // Undoing automation: a project registration can be dropped deliberately.
  const removeNow = async () => (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ removeGroups: [inventedDir] }),
  })).json()
  const removal = await removeNow()
  assert.equal(removal.ok, true)
  assert.equal(removal.removal.removed.length, 1)
  assert.equal(removal.removal.removed[0].path, inventedDir)
  assert.equal(removal.applied, 'unchanged', 'a removal does not reload the plugin')
  assert.equal(workspaces().some((workspace) => workspace.path === inventedDir), false)
  const removalAgain = await removeNow()
  assert.deepEqual(removalAgain.removal.missing, [inventedDir], 'a second removal reports the path as missing')
  checks.push('the configuration route removes a project registration without touching sessions')

  const foreignResponse = {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status },
    end(body) { this.body = body ?? '' },
  }
  await configRoute.handler({ method: 'GET', socket: { remoteAddress: '10.0.0.7' } }, foreignResponse)
  assert.equal(foreignResponse.statusCode, 403)
  checks.push('the configuration route answers the local machine only')

  /** A throwaway context that only records what a registration would install. */
  const collectorContext = (sink) => makeContext({
    webServer: { register: () => () => {} },
    tools: {
      register: (definition) => { sink.push(definition); return () => {} },
      get: () => undefined,
    },
  }, [])

  const offTools = []
  apply(collectorContext(offTools), { token: 'off-token', endpointFile: join(dir, 'off-endpoint.json'), url: 'http://127.0.0.1:9', dshHome: dir, exposeToDsh: false })
  assert.equal(offTools.length, 0, 'the switch off keeps the surface MCP-only')
  checks.push('exposeToDsh: false leaves the Harness tool registry untouched')

  const onTools = []
  apply(collectorContext(onTools), { token: 'on-token', endpointFile: join(dir, 'on-endpoint.json'), url: 'http://127.0.0.1:9', dshHome: dir })
  assert.equal(onTools.length, 3, 'the lazy surface is on by default')
  assert.deepEqual(onTools.map((tool) => tool.name).sort(), ['dsh_mcp_call', 'dsh_mcp_open', 'dsh_mcp_tools'])
  checks.push('the local surface is on by default, as the three-tool front door')

  // The full surface is the opt-in: the whole table, projected for the registry.
  const fullTools = []
  apply(collectorContext(fullTools), { token: 'full-token', endpointFile: join(dir, 'full-endpoint.json'), url: 'http://127.0.0.1:9', dshHome: dir, exposeToDshMode: 'full' })
  assert.equal(fullTools.length, 18, 'full mode registers the whole table')
  assert.deepEqual(fullTools.map((tool) => tool.name).sort(), mcpNames)
  const runPromptTool = fullTools.find((tool) => tool.name === 'dsh_run_prompt')
  assert.equal(runPromptTool.parameters.properties.prompt.minLength, undefined, 'unsupported keywords must be dropped')
  assert.deepEqual(runPromptTool.parameters.properties.wait, { type: 'boolean', description: 'Wait for the turn to finish (default true).' })
  assert.deepEqual(runPromptTool.parameters.required, ['prompt'])
  assert.equal(runPromptTool.parameters.additionalProperties, false)
  assert.equal(runPromptTool.output.render(undefined, { answer: 42 })[0].text, '{\n  "answer": 42\n}')
  assert.equal(runPromptTool.output.render(undefined, 'plain')[0].text, 'plain')
  checks.push('exposeToDshMode: full registers every published tool, projected for the registry')

  let modeTypo
  try {
    apply(collectorContext([]), { token: 'typo-token', endpointFile: join(dir, 'typo-endpoint.json'), dshHome: dir, exposeToDshMode: 'sometimes' })
  } catch (error) {
    modeTypo = error
  }
  assert.match(String(modeTypo && modeTypo.message), /exposeToDshMode/)
  checks.push('an unknown surface mode fails at load instead of changing the surface')

  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'))
  assert.equal(endpoint.token, 'integration-token')
  assert.equal(endpoint.url, 'http://127.0.0.1:9/mcp')
  assert.ok(endpoint.stdioBridge.endsWith('/bin/dsh-mcp-stdio.mjs'), `unexpected stdioBridge path: ${endpoint.stdioBridge}`)
  assert.ok(!endpoint.stdioBridge.includes('/bin/bin/'))
  checks.push('the published endpoint file carries the exact stdio bridge path')

  // --- task-start work sync is its own bundle row -------------------------------
  // This bundle no longer subscribes to session events: the dsh-work-sync row
  // mounts the engine and publishes a service, and this endpoint only reads it.
  assert.equal(ctx.hooks.get('session/event'), undefined, 'the MCP row does not subscribe to session events')
  const statusWithoutSync = await call('dsh_status', {})
  assert.equal(statusWithoutSync.sync.present, false, 'without the sync row the status says so')
  assert.equal(statusWithoutSync.sync.enabled, false)
  const syncWrite = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ syncOnStart: false }),
  })
  assert.equal(syncWrite.status, 400, 'the sync switch is refused when the row that owns it is absent')
  assert.match(String((await syncWrite.json()).error), /dsh-work-sync/)
  checks.push('task-start sync is a separate row: the MCP row neither subscribes nor saves its switch')

  // An internal caller may start a session only inside its own workspace root:
  // the session's cwd is what DSH uses as its sandbox boundary.
  const guardRoot = await mkdtemp('/tmp/dsh-mcp-guard-')
  const guardedAgent = { id: 'agent-guarded', session: { header: { id: 'guarded-session', cwd: guardRoot } } }
  const outside = await dispatch('dsh_run_prompt', { prompt: 'escape', cwd: '/etc' }, guardedAgent).then(() => undefined, (error) => error)
  assert.match(String(outside && outside.message), /inside this caller's workspace/)
  const insideDir = await mkdtemp(join(guardRoot, 'inside-'))
  const inside = await dispatch('dsh_run_prompt', { prompt: 'stay inside', cwd: insideDir }, guardedAgent)
  assert.ok(inside && inside.sessionId, 'a directory inside the caller workspace is allowed')
  checks.push('an internal caller cannot start a session outside its own workspace root')

  // A transcript read is bounded by a total response budget even when the caller
  // asks for everything.
  seedMessages(Array.from({ length: 3 }, () => ({ role: 'assistant', text: 'x'.repeat(200_000) })))
  const budgeted = await call('dsh_read_session', { sessionId: currentId(), limit: 0, maxChars: 0 })
  assert.equal(budgeted.truncatedByBudget, true, 'a huge read stops at the response budget')
  assert.ok(budgeted.returned < budgeted.totalMessages, 'and returns fewer messages than the log holds')
  checks.push('a transcript read is capped by a total response budget')
  await rm(guardRoot, { recursive: true, force: true })

  // Unknown tools are a malformed request (-32602), not method-not-found.
  const unknownTool = await rpc({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  })
  assert.equal(unknownTool.error.code, -32602, 'an unknown tool name is invalid params')
  const badUri = await rpc({
    jsonrpc: '2.0',
    id: ++id,
    method: 'resources/read',
    params: { uri: 'dsh://session/%E0%A4%A' },
  })
  assert.equal(badUri.error.code, -32602, 'a malformed resource id is invalid params')
  checks.push('unknown tools and malformed resource ids are invalid params, not internal errors')

  for (const dispose of disposers) await dispose?.()
  assert.equal(webServer.registered.length, 0, 'disposal removes the routes')
  assert.equal(registeredTools().length, 0, 'disposal removes the local tools')
  checks.push('disposal removes the routes and the locally registered tools')

  // A config hot-reload must not let the outgoing activation delete the endpoint
  // file the incoming one just wrote. Both reload orders are exercised because the
  // reloader is free to dispose before, during, or after it applies the new row.
  const reloadServices = { webServer: { register: () => () => {} } }
  const reloadConfig = (endpoint) => ({ token: 'reload-token', endpointFile: endpoint, url: 'http://127.0.0.1:9' })

  const reloadDirA = await mkdtemp(join(tmpdir(), 'dsh-mcp-reload-a-'))
  const fileA = join(reloadDirA, 'dsh-mcp-endpoint.json')
  const oldA = []
  apply(makeContext(reloadServices, oldA), reloadConfig(fileA))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const idBefore = JSON.parse(await readFile(fileA, 'utf8')).instanceId
  for (const dispose of oldA) await dispose?.()
  const newA = []
  apply(makeContext(reloadServices, newA), reloadConfig(fileA))
  await new Promise((resolve) => setTimeout(resolve, 120))
  const afterDisposeThenApply = JSON.parse(await readFile(fileA, 'utf8'))
  assert.notEqual(afterDisposeThenApply.instanceId, idBefore, 'the newer activation republishes the endpoint file')
  for (const dispose of newA) await dispose?.()
  await rm(reloadDirA, { recursive: true, force: true })
  checks.push('a reload that disposes first keeps the endpoint file of the new activation')

  const reloadDirB = await mkdtemp(join(tmpdir(), 'dsh-mcp-reload-b-'))
  const fileB = join(reloadDirB, 'dsh-mcp-endpoint.json')
  const oldB = []
  apply(makeContext(reloadServices, oldB), reloadConfig(fileB))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const newB = []
  apply(makeContext(reloadServices, newB), reloadConfig(fileB))
  await new Promise((resolve) => setTimeout(resolve, 120))
  const idNew = JSON.parse(await readFile(fileB, 'utf8')).instanceId
  for (const dispose of oldB) await dispose?.()
  await new Promise((resolve) => setTimeout(resolve, 60))
  const afterApplyThenDispose = JSON.parse(await readFile(fileB, 'utf8'))
  assert.equal(afterApplyThenDispose.instanceId, idNew, 'the outgoing activation must not delete the new endpoint file')
  for (const dispose of newB) await dispose?.()
  await rm(reloadDirB, { recursive: true, force: true })
  checks.push('a reload that applies first keeps the endpoint file when the old activation disposes')

  // --- the advertised URL follows the listener --------------------------------
  const urlDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-url-'))
  const urlFile = join(urlDir, 'dsh-mcp-endpoint.json')
  let readyCallback
  const carrier = { registered: [], register(route) { this.registered.push(route); return () => {} }, port: undefined, host: '0.0.0.0', protocol: 'http:' }
  const appReady = { onReady(callback) { readyCallback = callback; return () => { readyCallback = undefined } } }
  const urlDisposers = []
  // Neutralize the ambient override so the test exercises the listener fallback itself.
  const ambientUrl = process.env.DSH_WEB_URL
  delete process.env.DSH_WEB_URL
  apply(makeContext({ webServer: carrier, appReady }, urlDisposers), { token: 'url-token', endpointFile: urlFile, url: '', dshHome: urlDir })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const boundLater = JSON.parse(await readFile(urlFile, 'utf8'))
  assert.equal(boundLater.url, 'http://127.0.0.1:19387/mcp', 'an unbound listener can only advertise the documented default')
  assert.equal(typeof readyCallback, 'function', 'the plugin must wait for the launch signal, not guess')
  carrier.port = 41234
  readyCallback()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const bound = JSON.parse(await readFile(urlFile, 'utf8'))
  assert.equal(bound.url, 'http://127.0.0.1:41234/mcp', 'a wildcard bind is advertised as loopback with the real port')
  assert.equal(bound.instanceId, boundLater.instanceId)
  checks.push('the advertised URL follows the listener port once the app is ready')
  if (ambientUrl !== undefined) process.env.DSH_WEB_URL = ambientUrl
  for (const dispose of urlDisposers) await dispose?.()
  await rm(urlDir, { recursive: true, force: true })

  for (const check of checks) process.stdout.write(`ok - ${check}\n`)
  process.stdout.write(`\n${checks.length} integration checks passed\n`)
} finally {
  await new Promise((resolve) => port.close(resolve))
  await rm(dir, { recursive: true, force: true })
}