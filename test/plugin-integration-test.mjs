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

  const sessionController = {
    async create(request) {
      currentSessionId = request.sessionId
      return { sessionId: currentSessionId }
    },
    async selectModel() {},
    async prompt(request) {
      currentSessionId = request.sessionId
      pendingPrompt = request.content.map((part) => part.text).join('')
      events.push({
        type: 'user/message',
        seq: 1,
        time: Date.now(),
        data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'INJECTED CONTEXT' }] },
      })
      events.push({
        type: 'user/message',
        seq: 2,
        time: Date.now(),
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: pendingPrompt }] },
      })
      return { accepted: true }
    },
    follow() {
      events.push({
        type: 'assistant/message',
        seq: 3,
        time: Date.now(),
        data: { message: { content: [{ type: 'text', text: REPLY }] } },
      })
      events.push({ type: 'turn/end', seq: 4, time: Date.now(), data: { reason: { kind: 'completed' } } })
      const frames = [
        { type: 'snapshot', header: { id: currentSessionId }, cursor: 2, records: events.slice(0, 2).map((event) => ({ type: 'event', event })), hasMore: false },
        { type: 'event', event: events[2] },
        { type: 'event', event: events[3] },
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

  return {
    services: {
      sessionController,
      sessionQuery,
      webServer,
      tools: { schemas: () => [{ name: 'read_file', description: 'Read a file' }] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash-anthropic' }) },
    },
    webServer,
    getPrompt: () => pendingPrompt,
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-test-'))
const endpointFile = join(dir, 'dsh-mcp-endpoint.json')
const { services, webServer, getPrompt } = makeServices()
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
  assert.equal(status.toolNames.length, 7)
  checks.push('dsh_status reports the default model and tool names')

  const tools = await call('dsh_list_tools', {})
  assert.equal(tools.tools[0].name, 'read_file')
  checks.push('dsh_list_tools lists native Harness tools')

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