#!/usr/bin/env node
/**
 * Session-lifecycle and caller-identity integration checks: waiting for a turn
 * (including ceilings and subagent addresses), who the caller is, which
 * sessions it owns, the persisted client registry, and restrictToOwner.
 *
 * Run: node test/integration/sessions-and-identity.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClientRegistry, resolveCaller } from '../../lib/clients.js'
import { createPluginHarness, PROMPT, REPLY } from '../helpers/plugin-harness.mjs'

const h = await createPluginHarness({ label: 'sessions-and-identity' })
const { services, cancelledSessions, setRunning, setHang, resolvedAgents, currentId } = h
const { call, rpc, check } = h

try {
  const run = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' })
  const sessionIdFromRun = run.sessionId

  // --- waiting for a turn -----------------------------------------------------
  const idleWait = await call('dsh_wait_session', { sessionId: sessionIdFromRun })
  await check('dsh_wait_session returns immediately when no turn is running', () => {
    assert.equal(idleWait.status, 'idle')
    assert.equal(idleWait.running, false)
    assert.equal(idleWait.text, '')
  })

  setRunning(true)
  const waited = await call('dsh_wait_session', { sessionId: sessionIdFromRun, limit: 5 })
  await check('dsh_wait_session follows a running turn to its end and returns its text', () => {
    assert.equal(waited.status, 'completed')
    assert.equal(waited.running, false)
    assert.match(waited.text, /hello from dsh/)
    assert.equal(waited.messages.at(-1).text, REPLY)
    assert.deepEqual(cancelledSessions(), [])
  })

  // A subagent session is followed through its durable parent address: the API
  // controller refuses the plain session form for those.
  const liveRow = services.sessions.get(sessionIdFromRun)
  liveRow.header = { ...liveRow.header, origin: 'subagent', parentSession: 'parent-one' }
  setRunning(true)
  const subagentWait = await call('dsh_wait_session', { sessionId: sessionIdFromRun })
  const lastFollow = h.followRequests().at(-1)
  liveRow.header = { ...liveRow.header, origin: undefined, parentSession: undefined }
  await check('a subagent session is followed through its parent address', () => {
    assert.equal(subagentWait.status, 'completed')
    assert.equal(lastFollow.address.kind, 'subagent')
    assert.equal(lastFollow.address.parentSessionId, 'parent-one')
  })

  setRunning(true)
  setHang(true)
  const ceiling = await call('dsh_wait_session', { sessionId: sessionIdFromRun, timeoutMs: 1000 })
  await check('a waiter that hits its ceiling reports timedOut and cancels nothing', () => {
    assert.equal(ceiling.status, 'timedOut')
    assert.equal(ceiling.running, true)
    assert.match(ceiling.note, /Call dsh_wait_session again/)
    assert.deepEqual(cancelledSessions(), [])
  })

  const promptCeiling = await call('dsh_continue_session', { sessionId: sessionIdFromRun, prompt: PROMPT, timeoutMs: 1000 })
  await check('a waited prompt that hits its ceiling leaves the turn running too', () => {
    assert.equal(promptCeiling.status, 'timeout')
    assert.match(promptCeiling.note, /still running/)
    assert.deepEqual(cancelledSessions(), [])
  })

  setHang(false)
  setRunning(false)

  // --- caller identity and session ownership ----------------------------------
  const codex = { headers: { 'x-dsh-mcp-client': 'codex' } }
  const claude = { headers: { 'x-dsh-mcp-client': 'claude-code' } }

  // A labelled caller must never inherit the version of whatever `clientInfo` shares
  // its transport fingerprint — the first rung is authoritative, version included.
  await rpc(
    {
      jsonrpc: '2.0',
      id: h.nextId(),
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } },
    },
    { headers: { 'x-dsh-mcp-client': 'stdio-bridge' } },
  )
  const bridged = await call('dsh_whoami', {}, { headers: { 'x-dsh-mcp-client': 'stdio-bridge' } })
  await check('an explicit label never inherits another client version', () => {
    assert.equal(bridged.client.name, 'stdio-bridge')
    assert.equal(bridged.client.source, 'header')
    assert.equal(bridged.client.version, undefined, 'an explicit label must not borrow a cached clientInfo version')
  })

  // Node's fetch sends a User-Agent, so an unlabelled caller lands on that rung of
  // the ladder rather than the bare peer fallback.
  const anonymous = await call('dsh_whoami', {})
  await check('a caller that sends no label falls back to User-Agent or the auth peer', () => {
    assert.ok(
      ['user-agent', 'peer'].includes(anonymous.client.source),
      `unexpected identity source: ${anonymous.client.source}`,
    )
    assert.notEqual(anonymous.client.id, 'codex')
    assert.notEqual(anonymous.client.id, 'claude-code')
  })

  // Replay the cold-session adoption that gives claude-code exactly one session.
  const cold = await call('dsh_continue_session', { sessionId: 'session-cold', prompt: PROMPT, permissionPreset: 'workspace-write' }, claude)
  const claudeWho = await call('dsh_whoami', {}, claude)
  await check('dsh_whoami names the caller and lists the session it adopted', () => {
    assert.equal(cold.owner.id, 'claude-code')
    assert.equal(claudeWho.client.id, 'claude-code')
    assert.equal(claudeWho.client.source, 'header')
    assert.deepEqual(claudeWho.ownedSessions.map((entry) => entry.sessionId), ['session-cold'])
  })

  const codexWho = await call('dsh_whoami', {}, codex)
  await check('a caller owns nothing before it creates a session', () => {
    assert.equal(codexWho.ownedSessionCount, 0)
  })

  const versionedLabel = await call('dsh_whoami', {}, { headers: { 'x-dsh-mcp-client': 'claude-code@2.1.295' } })
  await check('a header label may state its version as name@version', () => {
    assert.equal(versionedLabel.client.id, 'claude-code')
    assert.equal(versionedLabel.client.name, 'claude-code')
    assert.equal(versionedLabel.client.version, '2.1.295')
  })

  const created = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' }, codex)
  const mine = await call('dsh_list_sessions', { limit: 20, mine: true }, codex)
  const byOwner = await call('dsh_list_sessions', { limit: 20, owner: 'codex' }, claude)
  await check('dsh_run_prompt records the creating agent, and mine/owner filter the listing', () => {
    assert.equal(created.owner.id, 'codex')
    assert.deepEqual(mine.sessions.map((session) => session.sessionId), [created.sessionId])
    assert.equal(mine.sessions[0].mine, true)
    assert.equal(mine.sessions[0].owner.id, 'codex')
    assert.deepEqual(byOwner.sessions.map((session) => session.sessionId), [created.sessionId])
  })

  const other = await call('dsh_list_sessions', { limit: 20 }, claude)
  const claudeMine = await call('dsh_list_sessions', { limit: 20, mine: true }, claude)
  await check('another caller sees the owner but never counts that session as its own', () => {
    assert.equal(other.sessions[0].owner.id, 'codex')
    assert.equal(other.sessions[0].mine, false)
    assert.deepEqual(claudeMine.sessions, [])
  })

  await new Promise((resolve) => setTimeout(resolve, 80))
  const persisted = createClientRegistry({ file: join(h.dir, 'mcp', 'dsh-mcp-clients.json') })
  persisted.load()
  await check('the caller registry is persisted and reloads after a restart', () => {
    assert.equal(persisted.ownerOf(created.sessionId)?.ownerId, 'codex')
    assert.ok(persisted.clientOf('claude-code'))
    assert.ok(persisted.clientOf(anonymous.client.id))
  })

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
  const evictedOwner = reloadedRegistry.ownerOf('session-0')?.ownerId
  await rm(evictionDir, { recursive: true, force: true })
  await check('the persisted registry keeps session ownership when the client LRU turns over', () => {
    assert.equal(evictedOwner, 'client-0', 'a client LRU eviction does not orphan its sessions')
  })

  const identityCache = new Map()
  resolveCaller({ headers: { 'user-agent': 'shared-agent' }, clientInfo: { name: 'victim' } }, identityCache)
  const unrelatedCaller = resolveCaller({ headers: { 'user-agent': 'shared-agent' } }, identityCache)
  const labelledCaller = resolveCaller({ headers: { 'x-dsh-mcp-client': 'bridge' }, clientInfo: { name: 'bridge', version: '1' } }, identityCache)
  const labelledAgain = resolveCaller({ headers: { 'x-dsh-mcp-client': 'bridge' } }, identityCache)
  await check('clientInfo is cached only for an explicit client label', () => {
    assert.notEqual(unrelatedCaller.name, 'victim', 'a shared User-Agent is not an identity cache key')
    assert.equal(labelledCaller.name, 'bridge')
    assert.equal(labelledAgain.version, '1', 'an explicit label still remembers its clientInfo')
  })

  // --- restrictToOwner --------------------------------------------------------
  const strict = await createPluginHarness({
    token: 'strict-token',
    tempPrefix: 'dsh-mcp-strict-',
    // Some deployments do not want their sidebar grown by automation.
    applyOptions: { groupSessions: false, restrictToOwner: true },
  })
  try {
    const strictCall = (name, args, headers) => strict.rpc(
      { jsonrpc: '2.0', id: strict.nextId(), method: 'tools/call', params: { name, arguments: args } },
      { headers },
    )
    const strictCreated = await strictCall('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' }, { 'x-dsh-mcp-client': 'codex' })
    const strictSession = strictCreated.result.structuredContent.sessionId
    const borrowed = await strictCall('dsh_read_session', { sessionId: strictSession }, { 'x-dsh-mcp-client': 'claude-code' })
    const claudeList = await strictCall('dsh_list_sessions', { limit: 20 }, { 'x-dsh-mcp-client': 'claude-code' })
    const codexList = await strictCall('dsh_list_sessions', { limit: 20 }, { 'x-dsh-mcp-client': 'codex' })
    const ownerProbe = await strictCall('dsh_list_sessions', { owner: 'codex' }, { 'x-dsh-mcp-client': 'claude-code' })
    const ownerSearch = await strictCall('dsh_search_sessions', { query: 'task', owner: 'codex' }, { 'x-dsh-mcp-client': 'claude-code' })
    await check('restrictToOwner confines every caller to the sessions it created, and the owner filter cannot widen it', () => {
      assert.ok(borrowed.result.isError, 'a restricted endpoint must refuse another caller')
      assert.match(borrowed.result.content[0].text, /restrictToOwner/)
      assert.deepEqual(claudeList.result.structuredContent.sessions, [])
      assert.deepEqual(codexList.result.structuredContent.sessions.map((session) => session.sessionId), [strictSession])
      assert.ok(ownerProbe.result.isError, 'a restricted caller cannot select another owner')
      assert.match(ownerProbe.result.content[0].text, /owner/)
      assert.ok(ownerSearch.result.isError, 'a restricted caller cannot search another owner s sessions')
    })
    const strictWorkspaceCalls = strict.workspaceCalls().length
    await check('groupSessions: false keeps sessions out of the project sidebar', () => {
      assert.equal(strictWorkspaceCalls, 0, 'groupSessions: false leaves the sidebar alone')
    })
  } finally {
    await strict.close()
  }

  h.finish()
} finally {
  await h.close()
}
