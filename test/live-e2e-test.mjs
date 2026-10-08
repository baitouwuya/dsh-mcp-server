#!/usr/bin/env node
/**
 * Full live MCP exchange against a RUNNING Harness, from the point of view of
 * another harness: protocol handshake, resources, every tool, and the error
 * paths an external client will hit.
 *
 * It performs three real delegated turns (one waited, one continuation, one
 * detached + cancelled), so it needs a live Harness with the plugin active.
 * Run: node test/live-e2e-test.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

const endpointFile = process.env.DSH_MCP_ENDPOINT_FILE
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'mcp', 'dsh-mcp-endpoint.json')
const { url, token } = JSON.parse(readFileSync(endpointFile, 'utf8'))
assert.ok(url && token, `endpoint file ${endpointFile} must carry url and token`)

const EXPECTED_TOOLS = [
  'dsh_run_prompt',
  'dsh_continue_session',
  'dsh_list_sessions',
  'dsh_read_session',
  'dsh_cancel_session',
  'dsh_archive_session',
  'dsh_unarchive_session',
  'dsh_list_tools',
  'dsh_status',
]

async function post(message, { auth = true, token: override, timeoutMs = 300_000 } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: `Bearer ${override ?? token}` } : {}),
    },
    body: typeof message === 'string' ? message : JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : undefined } catch { body = text }
  return { status: response.status, body, text }
}

let nextId = 0
const rpc = (method, params, options) => post({ jsonrpc: '2.0', id: ++nextId, method, params }, options)
async function call(name, args = {}, timeoutMs) {
  const { body } = await rpc('tools/call', { name, arguments: args }, { timeoutMs })
  if (body?.error) throw new Error(`${name} protocol error: ${JSON.stringify(body.error)}`)
  const result = body.result
  if (result?.isError) throw new Error(`${name} tool error: ${result.content?.[0]?.text}`)
  return result.structuredContent ?? JSON.parse(result.content[0].text)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const checks = []
const oh = (name) => checks.push(name)

// --- protocol ---------------------------------------------------------------
const init = (await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'live-e2e', version: '1' },
})).body.result
assert.equal(init.serverInfo.name, 'dsh-mcp-server')
assert.equal(init.protocolVersion, '2025-06-18')
assert.ok(init.capabilities.tools && init.capabilities.resources)
oh('initialize negotiates 2025-06-18 with tools + resources capabilities')

const listed = (await rpc('tools/list', {})).body.result.tools.map((tool) => tool.name)
assert.deepEqual([...listed].sort(), [...EXPECTED_TOOLS].sort())
oh('tools/list exposes exactly the seven documented tools')

const resources = (await rpc('resources/list', {})).body.result.resources.map((resource) => resource.uri)
assert.deepEqual([...resources].sort(), ['dsh://sessions', 'dsh://status'])
oh('resources/list exposes dsh://status and dsh://sessions')

const templates = (await rpc('resources/templates/list', {})).body.result.resourceTemplates.map((entry) => entry.uriTemplate)
assert.deepEqual(templates, ['dsh://session/{sessionId}'])
oh('resources/templates/list exposes the session transcript template')

const unknownMethod = (await rpc('not/a/method', {})).body.error
assert.equal(unknownMethod.code, -32601)
oh('an unknown method returns JSON-RPC -32601')

const malformed = (await post('{"jsonrpc":"2.0",')).body.error
assert.equal(malformed.code, -32700)
oh('malformed JSON returns -32700')

const noAuth = await post({ jsonrpc: '2.0', id: ++nextId, method: 'tools/list', params: {} }, { auth: false })
assert.equal(noAuth.status, 401)
const wrongAuth = await post({ jsonrpc: '2.0', id: ++nextId, method: 'tools/list', params: {} }, { token: 'definitely-not-the-token' })
assert.equal(wrongAuth.status, 401)
oh('a missing or wrong bearer token is rejected with 401')

const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
assert.equal(notification.status, 202)
assert.equal(notification.text, '')
oh('a notification is acknowledged with 202 and no body')

const getAttempt = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
assert.equal(getAttempt.status, 405)
oh('GET is refused with 405 because the server owns no event stream')

// --- resources --------------------------------------------------------------
const statusResource = JSON.parse((await rpc('resources/read', { uri: 'dsh://status' })).body.result.contents[0].text)
assert.equal(statusResource.server, 'dsh-mcp-server')
oh('resources/read dsh://status returns the server status document')

const sessionsResource = JSON.parse((await rpc('resources/read', { uri: 'dsh://sessions' })).body.result.contents[0].text)
assert.ok(Array.isArray(sessionsResource.sessions))
oh('resources/read dsh://sessions returns the session index')

// --- tools ------------------------------------------------------------------
const status = await call('dsh_status')
assert.equal(status.server, 'dsh-mcp-server')
assert.deepEqual([...status.toolNames].sort(), [...EXPECTED_TOOLS].sort())
oh('dsh_status reports the endpoint, counts, default model, and tool names')

const tools = await call('dsh_list_tools')
assert.ok(tools.count > 0 && tools.tools[0].name)
oh('dsh_list_tools lists native Harness tools')

const marker = `E2E-${Date.now().toString().slice(-4)}`
const run = await call('dsh_run_prompt', {
  prompt: `Reply with exactly this text and nothing else: ${marker}. Do not use any tools.`,
  cwd: '/tmp',
  timeoutMs: 240_000,
})
assert.equal(run.status, 'completed')
assert.match(run.text, new RegExp(marker))
assert.match(run.sessionId, /^session-/)
oh('dsh_run_prompt starts a session and returns the assistant final text')

const digits = marker.split('-')[1]
const continued = await call('dsh_continue_session', {
  sessionId: run.sessionId,
  prompt: 'Answer with only the number that appeared after the dash in that token. Do not use any tools.',
  timeoutMs: 240_000,
})
assert.equal(continued.status, 'completed')
assert.match(continued.text, new RegExp(digits))
oh('dsh_continue_session reuses the session context')

const transcript = await call('dsh_read_session', { sessionId: run.sessionId, limit: 0 })
assert.equal(transcript.sessionId, run.sessionId)
assert.ok(transcript.messages.some((message) => message.role === 'user'))
assert.ok(transcript.messages.some((message) => message.role === 'assistant'))
assert.ok(transcript.messages.some((message) => message.text.includes(marker)))
oh('dsh_read_session returns ordered user/assistant rows')

const sessionResource = JSON.parse((await rpc('resources/read', { uri: `dsh://session/${run.sessionId}` })).body.result.contents[0].text)
assert.equal(sessionResource.sessionId, run.sessionId)
assert.ok(sessionResource.totalMessages >= transcript.messages.length)
oh('resources/read dsh://session/{id} returns the same transcript')

const sessionList = await call('dsh_list_sessions', { limit: 50 })
assert.ok(sessionList.sessions.some((session) => session.sessionId === run.sessionId))
oh('dsh_list_sessions includes the session the MCP endpoint started')

// --- archive ----------------------------------------------------------------
const beforeArchive = await call('dsh_list_sessions', { limit: 200 })
assert.ok(beforeArchive.sessions.some((session) => session.sessionId === run.sessionId && session.archived === false))
oh('dsh_list_sessions marks a live session as not archived')

const archived = await call('dsh_archive_session', { sessionId: run.sessionId })
assert.equal(archived.archived, true)
const hiddenList = await call('dsh_list_sessions', { limit: 200 })
assert.ok(!hiddenList.sessions.some((session) => session.sessionId === run.sessionId))
oh('dsh_archive_session hides the session from the default listing')

const withArchived = await call('dsh_list_sessions', { limit: 200, includeArchived: true })
assert.ok(withArchived.sessions.some((session) => session.sessionId === run.sessionId && session.archived === true))
oh('dsh_list_sessions includeArchived reveals the archived session')

const archivedTranscript = await call('dsh_read_session', { sessionId: run.sessionId, limit: 0 })
assert.ok(archivedTranscript.messages.length > 0)
oh('an archived session keeps a readable transcript')

const unarchived = await call('dsh_unarchive_session', { sessionId: run.sessionId })
assert.equal(unarchived.archived, false)
const restoredList = await call('dsh_list_sessions', { limit: 200 })
assert.ok(restoredList.sessions.some((session) => session.sessionId === run.sessionId && session.archived === false))
oh('dsh_unarchive_session restores the session to the listing')

const detached = await call('dsh_run_prompt', {
  prompt: 'Count slowly from 1 to 500, one number per line. Do not use any tools.',
  cwd: '/tmp',
  wait: false,
})
assert.equal(detached.status, 'started')
await sleep(4000)
const cancelled = await call('dsh_cancel_session', { sessionId: detached.sessionId })
assert.equal(cancelled.status, 'cancel-requested')
const detachedTranscript = await call('dsh_read_session', { sessionId: detached.sessionId, limit: 0 })
assert.ok(detachedTranscript.totalMessages >= 1)
oh('wait:false starts detached, dsh_cancel_session cancels it, transcript stays readable')

// --- error paths ------------------------------------------------------------
const unknownTool = (await rpc('tools/call', { name: 'dsh_does_not_exist', arguments: {} })).body
assert.ok(unknownTool.result?.isError || unknownTool.error, 'an unknown tool must fail the call')
oh('an unknown tool fails as a tool error, not a silent success')

const missingArg = (await rpc('tools/call', { name: 'dsh_read_session', arguments: {} })).body
assert.ok(missingArg.result?.isError || missingArg.error, 'a missing required argument must fail the call')
oh('a missing required argument fails the call')

const bogusSession = (await rpc('tools/call', { name: 'dsh_read_session', arguments: { sessionId: 'session-does-not-exist' } })).body
assert.ok(bogusSession.result?.isError || bogusSession.error, 'an unknown session must fail the call')
oh('reading an unknown session fails cleanly')

for (const check of checks) process.stdout.write(`ok - ${check}\n`)
process.stdout.write(`\n${checks.length} live MCP checks passed\n`)
process.stdout.write(`endpoint=${url}\nsession used=${run.sessionId}\ndetached session=${detached.sessionId}\n`)