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

import { apply } from '../index.js'

const PROMPT = 'delegate this task'
const REPLY = 'hello from dsh'

/** Minimal fake Cordis context exposing only what the plugin touches. */
function makeContext(services, disposers) {
  return {
    // Cordis exposes an injected service both as `ctx.<name>` and `ctx.get(name)`.
    ...services,
    get: (name) => services[name],
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    effect: (create) => {
      const dispose = create()
      disposers.push(dispose)
      return dispose
    },
  }
}

/** Fake DSH services with one scripted turn. */
function makeServices() {
  const events = []
  let pendingPrompt
  let currentSessionId
  let seq = 0
  const appliedPermissions = []
  const resolvedAgents = []

  /** The one live session the fake store hands back to the permission writer. */
  const liveSession = { id: 'live-session', append() {} }

  /** Permission presets mirroring the deployment's read-only/write/full table. */
  const permissionOptions = [
    { value: 'read-only', name: 'Read only', description: 'Read files; no writes.' },
    { value: 'workspace-write', name: 'Workspace write', description: 'Write inside the workspace; wider retries need approval.' },
    { value: 'danger-full-access', name: 'Full access', description: 'Full file access without approval prompts.' },
  ]
  const permissionPresets = {
    catalog: () => ({ defaultPreset: 'workspace-write', defaultOptions: permissionOptions, options: permissionOptions }),
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

  const sessionController = {
    async create(request) {
      currentSessionId = request.sessionId
      return { sessionId: currentSessionId }
    },
    async selectModel() {},
    /** Cold-session resume path used when the store holds no live entry. */
    async resolveAgent(id) {
      resolvedAgents.push(id)
      return { agent: { session: liveSession } }
    },
    async prompt(request) {
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
    },
    follow() {
      const assistant = {
        type: 'assistant/message',
        seq: ++seq,
        time: Date.now(),
        data: { message: { content: [{ type: 'text', text: REPLY }] } },
      }
      const end = { type: 'turn/end', seq: ++seq, time: Date.now(), data: { reason: { kind: 'completed' } } }
      const before = events.slice()
      events.push(assistant, end)
      const frames = [
        { type: 'snapshot', header: { id: currentSessionId }, cursor: before.length, records: before.map((event) => ({ type: 'event', event })), hasMore: false },
        { type: 'event', event: assistant },
        { type: 'event', event: end },
      ]
      return (async function* stream() {
        for (const frame of frames) yield frame
      })()
    },
    cancel() {
      return { accepted: true }
    },
    async list() {
      return { items: [{ sessionId: currentSessionId, updatedAt: Date.now(), running: false, blank: false, agentAvailable: true, cwd: '/tmp' }] }
    },
  }

  const sessionQuery = {
    async readSession(id) {
      assert.equal(id, currentSessionId)
      return { session: { cwd: '/tmp', createdAt: Date.now() }, events, inheritedEventCount: 0 }
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { session: { id }, title: { title: 'Delegated task' } } }))
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
  const workspaceRegistry = {
    get archivedSessionIds() { return [...archived] },
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

  return {
    services: {
      sessionController,
      sessionQuery,
      sessions,
      permissionPresets,
      webServer,
      workspaceRegistry,
      tools: { schemas: () => [{ name: 'read_file', description: 'Read a file' }] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash-anthropic' }) },
    },
    webServer,
    getPrompt: () => pendingPrompt,
    setBusy: (value) => { busy = value },
    archivedIds: () => [...archived],
    appliedPermissions: () => appliedPermissions.map((entry) => entry.name),
    resolvedAgents: () => [...resolvedAgents],
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-test-'))
const endpointFile = join(dir, 'dsh-mcp-endpoint.json')
const { services, webServer, getPrompt, setBusy, archivedIds, appliedPermissions, resolvedAgents } = makeServices()
let sessionIdFromRun
const disposers = []
const ctx = makeContext(services, disposers)

apply(ctx, { token: 'integration-token', endpointFile, url: 'http://127.0.0.1:9', dshHome: dir })

assert.equal(webServer.registered.length, 1, 'the plugin registers exactly one route')
assert.equal(webServer.registered[0].kind, 'exact')
assert.equal(webServer.registered[0].path, '/mcp')

const port = await new Promise((resolve) => {
  const server = createServer((req, res) => { void webServer.registered[0].handler(req, res) })
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const address = `http://127.0.0.1:${port.address().port}/mcp`

async function rpc(message) {
  const response = await fetch(address, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer integration-token' },
    body: JSON.stringify(message),
  })
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

let id = 0
async function call(name, args) {
  const body = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
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

  const status = await call('dsh_status', {})
  assert.equal(status.defaultModel.model, 'deepseek-v4.1-flash-anthropic')
  assert.equal(status.toolNames.length, 10)
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

  const repinned = await call('dsh_continue_session', { sessionId: pinned.sessionId, prompt: PROMPT, permissionPreset: 'danger-full-access' })
  assert.equal(repinned.permissionPreset, 'danger-full-access')
  assert.deepEqual(appliedPermissions(), ['read-only', 'danger-full-access'])
  const repinnedRead = await call('dsh_read_session', { sessionId: pinned.sessionId, limit: 0 })
  assert.equal(repinnedRead.permissionPreset, 'danger-full-access')
  checks.push('dsh_continue_session re-pins permissionPreset on an existing session')

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

  const cold = await call('dsh_continue_session', { sessionId: 'session-cold', prompt: PROMPT, permissionPreset: 'workspace-write' })
  assert.equal(cold.permissionPreset, 'workspace-write')
  assert.deepEqual(resolvedAgents(), ['session-cold'])
  assert.deepEqual(appliedPermissions(), ['read-only', 'danger-full-access', 'workspace-write'])
  checks.push('a session the store does not hold is resumed through resolveAgent before pinning')

  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'))
  assert.equal(endpoint.token, 'integration-token')
  assert.equal(endpoint.url, 'http://127.0.0.1:9/mcp')
  assert.ok(endpoint.stdioBridge.endsWith('/bin/dsh-mcp-stdio.mjs'), `unexpected stdioBridge path: ${endpoint.stdioBridge}`)
  assert.ok(!endpoint.stdioBridge.includes('/bin/bin/'))
  checks.push('the published endpoint file carries the exact stdio bridge path')

  for (const dispose of disposers) await dispose?.()
  assert.equal(webServer.registered.length, 0, 'disposal removes the route')
  checks.push('disposal removes the route')

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

  for (const check of checks) process.stdout.write(`ok - ${check}\n`)
  process.stdout.write(`\n${checks.length} integration checks passed\n`)
} finally {
  await new Promise((resolve) => port.close(resolve))
  await rm(dir, { recursive: true, force: true })
}