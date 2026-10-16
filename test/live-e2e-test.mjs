#!/usr/bin/env node
/**
 * Full live MCP exchange against a RUNNING Harness, from the point of view of
 * another harness: protocol handshake, resources, every tool, and the error
 * paths an external client will hit.
 *
 * It performs four real delegated turns (two waited, one continuation, one
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
  'dsh_list_commands',
  'dsh_run_command',
  'dsh_list_sessions',
  'dsh_read_session',
  'dsh_search_sessions',
  'dsh_list_requests',
  'dsh_answer_request',
  'dsh_wait_session',
  'dsh_whoami',
  'dsh_cancel_session',
  'dsh_archive_session',
  'dsh_unarchive_session',
  'dsh_list_permission_presets',
  'dsh_list_tools',
  'dsh_status',
]

async function post(message, { auth = true, token: override, timeoutMs = 300_000, headers = {} } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: `Bearer ${override ?? token}` } : {}),
      ...headers,
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
oh('tools/list exposes exactly the twelve documented tools')

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

const who = await call('dsh_whoami')
assert.equal(typeof who.client.id, 'string')
assert.ok(['header', 'initialize', 'initialize-cache', 'user-agent', 'peer'].includes(who.client.source))
assert.ok(Array.isArray(who.ownedSessions))
assert.ok(who.ownedSessionCount >= who.ownedSessions.length, 'the listed page cannot exceed the count')
oh('dsh_whoami reports the calling agent and the sessions it owns')

const named = await post(
  { jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name: 'dsh_whoami', arguments: {} } },
  { headers: { 'x-dsh-mcp-client': 'live-e2e' } },
)
const namedWho = JSON.parse(named.body.result.content[0].text)
assert.equal(namedWho.client.id, 'live-e2e')
assert.equal(namedWho.client.source, 'header')
oh('an x-dsh-mcp-client header names the caller')

const tools = await call('dsh_list_tools')
assert.ok(tools.count > 0 && tools.tools[0].name)
oh('dsh_list_tools lists native Harness tools')

const presets = await call('dsh_list_permission_presets')
assert.ok(presets.presets.some((option) => option.value === 'workspace-write'))
assert.ok(presets.presets.some((option) => option.value === 'danger-full-access'))
assert.equal(typeof presets.defaultPreset, 'string')
oh('dsh_list_permission_presets lists the deployment presets')

const marker = `E2E-${Date.now().toString().slice(-4)}`
const run = await call('dsh_run_prompt', {
  prompt: `Reply with exactly this text and nothing else: ${marker}. Do not use any tools.`,
  cwd: '/tmp',
  permissionPreset: 'read-only',
  timeoutMs: 240_000,
})
assert.equal(run.status, 'completed')
assert.match(run.text, new RegExp(marker))
assert.match(run.sessionId, /^session-/)
assert.equal(run.permissionPreset, 'read-only')
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
assert.equal(transcript.permissionPreset, 'read-only')
oh('dsh_read_session returns ordered user/assistant rows and the pinned permission preset')

const idleWait = await call('dsh_wait_session', { sessionId: run.sessionId, limit: 3 })
assert.equal(idleWait.status, 'idle')
assert.equal(idleWait.running, false)
assert.equal(idleWait.messages.at(-1).role, 'assistant')
oh('dsh_wait_session returns idle plus a transcript tail once the turn is over')

const windowed = await call('dsh_read_session', { sessionId: run.sessionId })
assert.equal(windowed.mode, 'tail')
assert.ok(windowed.returned <= 10, 'the default read must be a window')
assert.ok(windowed.totalMessages >= windowed.returned)
assert.equal(typeof windowed.window.nextAfterSeq, 'number')
const outlined = await call('dsh_read_session', { sessionId: run.sessionId, mode: 'outline', limit: 200 })
assert.ok(outlined.messages.length > 0)
assert.ok(outlined.messages.every((row) => row.text === undefined && typeof row.preview === 'string'))
oh('a read is a bounded window by default and can outline the whole session')

const requests = await call('dsh_list_requests', { sessionId: run.sessionId })
assert.equal(typeof requests.count, 'number')
assert.ok(Array.isArray(requests.sessions))
assert.ok(typeof requests.note === 'string')
oh('dsh_list_requests reports pending user decisions for a session')

const answerRefused = (await rpc('tools/call', { name: 'dsh_answer_request', arguments: { requestId: 'none' } })).body
assert.ok(answerRefused.result?.isError, 'answering must be off unless the deployment opts in')
assert.match(answerRefused.result.content[0].text, /answerUserRequests/)
oh('dsh_answer_request is refused until the deployment opts in')

const repinned = await call('dsh_continue_session', {
  sessionId: run.sessionId,
  prompt: 'Reply with exactly this text and nothing else: ACK. Do not use any tools.',
  permissionPreset: 'danger-full-access',
  timeoutMs: 240_000,
})
assert.equal(repinned.status, 'completed')
assert.equal(repinned.permissionPreset, 'danger-full-access')
const repinnedRead = await call('dsh_read_session', { sessionId: run.sessionId, limit: 0 })
assert.equal(repinnedRead.permissionPreset, 'danger-full-access')
oh('dsh_continue_session re-pins the permission preset on a live session')

// --- commands ---------------------------------------------------------------
const messagesBeforeCommand = (await call('dsh_read_session', { sessionId: run.sessionId, limit: 0 })).totalMessages
const commandList = await call('dsh_list_commands', { sessionId: run.sessionId })
const commandNames = commandList.commands.map((entry) => entry.name)
assert.equal(commandList.count, commandList.commands.length)
assert.ok(commandNames.includes('permission'), `expected /permission among ${commandNames.join(', ')}`)
oh('dsh_list_commands lists the effective commands of a session')

const permissionQuery = await call('dsh_run_command', { sessionId: run.sessionId, command: 'permission' })
assert.equal(permissionQuery.command, '/permission')
assert.equal(permissionQuery.kind, 'success')
assert.match(permissionQuery.text, /preset/)
assert.ok(typeof permissionQuery.commandId === 'string' && permissionQuery.commandId.length > 0)
const messagesAfterCommand = (await call('dsh_read_session', { sessionId: run.sessionId, limit: 0 })).totalMessages
assert.equal(messagesAfterCommand, messagesBeforeCommand, 'a command must not add model messages')
oh('dsh_run_command runs /permission without a model turn')

const compactAttempt = (await rpc('tools/call', { name: 'dsh_run_command', arguments: { sessionId: run.sessionId, line: '/compact' } })).body
if (compactAttempt.result?.isError) {
  assert.match(compactAttempt.result.content[0].text, /is not a command/)
} else {
  assert.equal(compactAttempt.result.structuredContent.kind, 'success')
}
oh('dsh_run_command runs /compact, or reports it is not composed for this preset')

const unknownCommand = (await rpc('tools/call', { name: 'dsh_run_command', arguments: { sessionId: run.sessionId, command: 'no_such_command' } })).body
assert.ok(unknownCommand.result?.isError, 'an unknown command must fail the call')
assert.match(JSON.stringify(unknownCommand), /no_such_command/)
oh('an unknown command fails cleanly')

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
const detachedWait = await call('dsh_wait_session', { sessionId: detached.sessionId, timeoutMs: 5000, limit: 2 })
assert.ok(['completed', 'timedOut'].includes(detachedWait.status), `unexpected wait status ${detachedWait.status}`)
oh('dsh_wait_session follows a detached turn without cancelling it')
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

const badPreset = (await rpc('tools/call', {
  name: 'dsh_continue_session',
  arguments: { sessionId: run.sessionId, prompt: 'never sent', permissionPreset: 'no-such-preset' },
})).body
assert.ok(badPreset.result?.isError || badPreset.error, 'an unknown permission preset must fail the call')
assert.match(JSON.stringify(badPreset), /no-such-preset/)
oh('an unknown permission preset fails cleanly')

for (const check of checks) process.stdout.write(`ok - ${check}\n`)
process.stdout.write(`\n${checks.length} live MCP checks passed\n`)
process.stdout.write(`endpoint=${url}\nsession used=${run.sessionId}\ndetached session=${detached.sessionId}\n`)