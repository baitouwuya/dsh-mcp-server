#!/usr/bin/env node
/**
 * Protocol and tool-surface integration checks: the MCP route the plugin
 * registers, the session it starts from a prompt, the DSH-facing tool surface
 * (lazy front door, catalogue, opening, internal ceilings), lossless values,
 * malformed requests, and disposal.
 *
 * Run: node test/integration/protocol-and-tools.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'

import { lossless } from '../../lib/dsh-tools-bridge.js'
import { createPluginHarness, INTERNAL_AGENT, PROMPT, REPLY } from '../helpers/plugin-harness.mjs'

const h = await createPluginHarness({ label: 'protocol-and-tools' })
const {
  services,
  webServer,
  getPrompt,
  registeredTools,
  makeAgent,
  agentTools,
  currentId,
  setCallerMode,
  setCallerPreset,
} = h
const { call, rpc, check } = h

try {
  const init = await rpc({ jsonrpc: '2.0', id: h.nextId(), method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
  await check('initialize over the route the plugin registered', () => {
    assert.equal(init.result.serverInfo.name, 'dsh-mcp-server')
  })

  const run = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' })
  const sessionIdFromRun = run.sessionId
  await check('dsh_run_prompt creates a session and returns the final assistant text', () => {
    assert.equal(run.status, 'completed')
    assert.equal(run.text, REPLY)
    assert.equal(getPrompt(), PROMPT)
  })

  const read = await call('dsh_read_session', { sessionId: sessionIdFromRun, limit: 0 })
  await check('dsh_read_session returns only user-authored and assistant messages', () => {
    assert.deepEqual(read.messages, [
      { role: 'user', text: PROMPT, seq: 2 },
      { role: 'assistant', text: REPLY, seq: 3 },
    ])
  })

  const sessions = await call('dsh_list_sessions', { limit: 5 })
  await check('dsh_list_sessions joins the session title', () => {
    assert.equal(sessions.sessions[0].title, 'Delegated task')
    assert.equal(sessions.sessions[0].running, false)
  })

  const status = await call('dsh_status', {})
  await check('dsh_status reports the default model, tool names, and permission presets', () => {
    assert.equal(status.defaultModel.model, 'deepseek-v4.1-flash-anthropic')
    assert.equal(status.toolNames.length, 21)
    assert.equal(status.defaultPermissionPreset, 'workspace-write')
    assert.deepEqual(status.permissionPresets.map((option) => option.value), ['read-only', 'workspace-write', 'danger-full-access'])
  })

  const tools = await call('dsh_list_tools', {})
  await check('dsh_list_tools lists native Harness tools', () => {
    assert.equal(tools.tools[0].name, 'read_file')
  })

  // --- the DSH-facing tool surface ---------------------------------------------
  const listed = await rpc({ jsonrpc: '2.0', id: h.nextId(), method: 'tools/list', params: {} })
  const mcpNames = listed.result.tools.map((tool) => tool.name).sort()
  assert.equal(mcpNames.length, 21, 'the MCP endpoint publishes twenty-one tools')
  assert.ok(mcpNames.includes('dsh_open_session'), 'the GUI jump is part of the published table')

  // The default surface is the front door: three small schemas instead of
  // twenty, so a session pays for the catalogue only when it needs it.
  const frontDoorRegistered = registeredTools().map((tool) => tool.name).sort()
  const frontDoorCost = registeredTools()
    .reduce((total, tool) => total + tool.description.length + JSON.stringify(tool.parameters).length, 0)
  await check(`the default surface is a three-tool front door (${frontDoorCost} chars instead of the full table)`, () => {
    assert.deepEqual(
      frontDoorRegistered,
      ['dsh_mcp_call', 'dsh_mcp_open', 'dsh_mcp_tools'],
      'the lazy surface registers only the front door',
    )
  })

  const localStatus = await call('dsh_status', {})
  await check('dsh_status reports the surface mode, its size, and the served client page', () => {
    assert.equal(localStatus.dshTools.enabled, true)
    assert.equal(localStatus.dshTools.mode, 'lazy')
    assert.equal(localStatus.dshTools.published, 21, 'every published tool stays openable')
    assert.deepEqual(localStatus.dshTools.registered.slice().sort(), ['dsh_mcp_call', 'dsh_mcp_open', 'dsh_mcp_tools'])
    assert.equal(localStatus.clientPage.available, true)
    assert.equal(localStatus.clientPage.inGraph, true)
    assert.equal(localStatus.clientPage.bundle, '/tmp/pkg/lib/client.js')
  })

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
  const searched = await metaCall('dsh_mcp_tools', { query: 'transcript' })
  const one = await metaCall('dsh_mcp_tools', { name: 'dsh_read_session' })
  const unknownLookup = await metaCall('dsh_mcp_tools', { name: 'nope' }).then(() => undefined, (error) => error)
  await check('the catalogue lists narrowly and returns one full schema on demand', () => {
    assert.equal(catalogue.total, 21)
    assert.equal(catalogue.count, 21)
    assert.equal(catalogue.tools.every((row) => row.native === false), true, 'nothing is native until it is opened')
    assert.ok(catalogue.tools.every((row) => row.purpose.length > 0 && row.purpose.length < 200), 'a catalogue row stays one line')
    assert.ok(searched.count > 0 && searched.count < 21, 'a query narrows the catalogue')
    assert.equal(one.name, 'dsh_read_session')
    assert.ok(one.parameters.properties.mode, 'a single lookup returns the parameter schema')
    assert.equal(one.parameters.properties.mode.minLength, undefined, 'the schema is projected for the registry')
    assert.match(String(unknownLookup && unknownLookup.message), /not a tool this DSH deployment publishes/)
  })

  // The front door carries every published name and its call signature, which
  // is what removes the discovery step: a session reads the tool it needs in
  // the description instead of spending a step asking what exists.
  const frontDoor = registeredTools().find((tool) => tool.name === 'dsh_mcp_tools')
  const frontDoorIndexCost = registeredTools()
    .reduce((total, tool) => total + tool.description.length + JSON.stringify(tool.parameters).length, 0)
  const fullTableCost = listed.result.tools
    .reduce((total, tool) => total + tool.description.length + JSON.stringify(tool.inputSchema).length, 0)
  await check(`the front door names all twenty-one tools with their signatures (${frontDoorIndexCost} chars vs ${fullTableCost} for the table)`, () => {
    for (const name of mcpNames) assert.ok(frontDoor.description.includes(name), `${name} is named in the front-door index`)
    assert.match(frontDoor.description, /dsh_continue_session\(sessionId, prompt\)/, 'the index states the required arguments')
    assert.match(frontDoor.description, /dsh_run_command\(sessionId, line\|command\)/, 'a tool whose required list is not its whole signature says so')
    assert.match(frontDoor.description, /dsh_answer_request\(requestId, decision\|answers\)/, 'a decision-shaped tool says which of the two it takes')
    assert.ok(frontDoorIndexCost < 3500, 'the index keeps the front door under 3.5 KB')
    assert.ok(frontDoorIndexCost * 4 < fullTableCost, 'the front door stays a fraction of the full table')
  })

  const bareName = await dispatch('whoami', {})
  const jsonArgs = await metaCall('dsh_mcp_call', { tool: 'whoami', arguments: '{}' })
  const nearMiss = await dispatch('read-session', { sessionId: currentId() }).then(() => undefined, (error) => error)
  const nonsense = await dispatch('zzz', {}).then(() => undefined, (error) => error)
  await check('a bare or near-miss name resolves, or is refused with the close matches named', () => {
    assert.ok(bareName && typeof bareName === 'object', 'a bare name resolves to the published tool')
    assert.ok(jsonArgs && typeof jsonArgs === 'object', 'a JSON object string is accepted as arguments')
    assert.match(String(nearMiss && nearMiss.message), /did you mean "dsh_read_session"/)
    assert.match(String(nonsense && nonsense.message), /not a tool this DSH deployment publishes/)
  })

  // The two ways a model can lose control of the lazy surface: calling the
  // front door through itself, and opening the whole table without asking.
  const frontDoorCall = await dispatch('dsh_mcp_tools', {}).then(() => undefined, (error) => error)
  const wrongType = await metaCall('dsh_mcp_call', { tool: 42 }).then(() => undefined, (error) => error)
  const omitOpen = await metaCall('dsh_mcp_open', {}, makeAgent()).then(() => undefined, (error) => error)
  const stringOpen = await metaCall('dsh_mcp_open', { tools: 'dsh_status' }, makeAgent()).then(() => undefined, (error) => error)
  const emptyOpen = await metaCall('dsh_mcp_open', { tools: [] }, makeAgent()).then(() => undefined, (error) => error)
  const openParam = registeredTools().find((tool) => tool.name === 'dsh_mcp_open').parameters.properties.tools.description
  const wholeSet = await metaCall('dsh_mcp_open', { all: true }, makeAgent())
  await check('the front-door refusal is reachable, and opening always needs an explicit target', () => {
    assert.match(String(frontDoorCall && frontDoorCall.message), /cannot call the front door itself/)
    assert.match(String(wrongType && wrongType.message), /must be a published tool name as a string/)
    assert.match(String(omitOpen && omitOpen.message), /needs an explicit target/)
    assert.match(String(stringOpen && stringOpen.message), /must be an array of published names/)
    assert.match(String(emptyOpen && emptyOpen.message), /at least one published name/)
    assert.match(openParam, /bare name/, 'the parameter text matches the refusal, not the old "omit opens everything" promise')
    assert.equal(wholeSet.native.length, 21, 'all: true is still the way to the whole table')
  })

  // Opening is per agent: the registrations land in the calling agent's own
  // scope, which is what makes DSH announce them as tool additions.
  const agent = makeAgent()
  const opened = await metaCall('dsh_mcp_open', { tools: ['dsh_run_prompt', 'dsh_run_command'] }, agent)
  const reopened = await metaCall('dsh_mcp_open', { tools: ['dsh_run_prompt'] }, agent)
  const unknownOpen = await metaCall('dsh_mcp_open', { tools: ['nope'] }, agent).then(() => undefined, (error) => error)
  await check('dsh_mcp_open registers the asked-for tools in the calling agent scope, once', () => {
    assert.deepEqual([...opened.opened].sort(), ['dsh_run_command', 'dsh_run_prompt'])
    assert.deepEqual([...opened.native].sort(), ['dsh_run_command', 'dsh_run_prompt'])
    assert.equal(registeredTools().length, 3, 'opening does not grow the global registry')
    assert.deepEqual(agentTools(agent).map((tool) => tool.name).sort(), ['dsh_run_command', 'dsh_run_prompt'])
    assert.deepEqual(reopened.opened, [], 'opening twice registers nothing twice')
    assert.deepEqual(reopened.alreadyOpen, ['dsh_run_prompt'])
    assert.match(String(unknownOpen && unknownOpen.message), /not a tool this DSH deployment publishes/)
  })

  const openRunner = agentTools(agent).find((tool) => tool.name === 'dsh_run_prompt')
  const openedRun = await openRunner.execute({ prompt: 'opened run', cwd: '/tmp' }, { agent })
  await check('an opened tool runs natively for that agent', () => {
    assert.equal(openedRun.status, 'completed')
  })

  setCallerMode('workspace-write')
  setCallerPreset('workspace-write')
  const localRun = await dispatch('dsh_run_prompt', { prompt: 'internal delegation', cwd: '/tmp' })
  await check('a dispatched call is attributed to its session and starts pinned to its own preset', () => {
    assert.equal(localRun.status, 'completed')
    assert.equal(localRun.permissionPreset, 'workspace-write', 'a started session is pinned to the caller preset')
    assert.equal(localRun.owner.id, 'dsh-agent:live-session', 'an internal call is attributed to the calling session')
  })

  const widerRefusal = await refusedBy('dsh_run_prompt', { prompt: 'too wide', cwd: '/tmp', permissionPreset: 'danger-full-access' })
  await check('an internal caller cannot grant a preset wider than its own file policy', () => {
    assert.ok(widerRefusal, 'a preset wider than the caller must be refused')
    assert.match(String(widerRefusal.message), /wider than the calling DSH agent/)
  })
  await check('a refused dispatched call names the schema that would have been accepted', () => {
    assert.match(String(widerRefusal.message), /dsh_mcp_tools\(\{ name: "dsh_run_prompt" \}\)/, 'a refused call points at the schema that fixes it')
  })

  setCallerMode('danger-full-access')
  setCallerPreset('danger-full-access')
  const narrowedPreset = await dispatch('dsh_run_prompt', { prompt: 'narrower', cwd: '/tmp', permissionPreset: 'read-only' })
  await check('an internal caller may still set a preset at or below its own rung', () => {
    assert.equal(narrowedPreset.permissionPreset, 'read-only', 'a narrower preset is not a privilege grant')
  })

  setCallerMode('workspace-write')
  setCallerPreset('workspace-write')
  const commandRefusal = await refusedBy('dsh_run_command', { sessionId: currentId(), line: '/permission danger-full-access' })
  await check('a /permission slash command cannot bypass the internal ceiling', () => {
    assert.ok(commandRefusal, 'a slash command must respect the same ceiling')
    assert.match(String(commandRefusal.message), /wider than the calling DSH agent/)
  })

  const nativeRefusal = await openRunner
    .execute({ prompt: 'natively too wide', cwd: '/tmp', permissionPreset: 'danger-full-access' }, { agent })
    .then(() => undefined, (error) => error)
  await check('the ceiling applies to a natively opened tool exactly as to a dispatched one', () => {
    assert.match(String(nativeRefusal && nativeRefusal.message), /wider than the calling DSH agent/)
  })

  // --- lossless canonical values ------------------------------------------------
  // The registry validates a tool's canonical value, and an internal (PTC) call
  // has no JSON round trip to hide a nested `undefined`: this is the failure
  // the bridge's projection defends against.
  const projected = lossless({ a: 1, b: undefined, c: [1, undefined, NaN] })
  const projectedUndefined = lossless(undefined)
  await check('the bridge projects canonical values into lossless JSON', () => {
    assert.deepEqual(projected, { a: 1, c: [1, null, null] })
    assert.equal(projectedUndefined, '')
  })

  const isLossless = (value) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every((entry) => isLossless(entry))
    if (typeof value !== 'object') return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(value).every((entry) => isLossless(entry))
  }
  const losslessResults = []
  for (const [name, args] of [
    ['dsh_status', {}],
    ['dsh_list_sessions', { limit: 5 }],
    ['dsh_read_session', { sessionId: currentId(), limit: 2 }],
    ['dsh_whoami', {}],
  ]) {
    losslessResults.push({ name, value: await dispatch(name, args) })
  }
  const statusValue = await dispatch('dsh_status', {})
  await check('every dispatched result is lossless JSON, so an internal call cannot fail on it', () => {
    for (const { name, value } of losslessResults) {
      assert.ok(isLossless(value), `${name} returned a value an internal call would reject`)
    }
  })
  await check('dsh_status carries no undefined field for an internal caller', () => {
    assert.equal(Object.values(statusValue).includes(undefined), false)
  })

  // An internal caller may start a session only inside its own workspace root:
  // the session's cwd is what DSH uses as its sandbox boundary.
  const guardRoot = await mkdtemp('/tmp/dsh-mcp-guard-')
  const guardedAgent = { id: 'agent-guarded', session: { header: { id: 'guarded-session', cwd: guardRoot } } }
  const outside = await dispatch('dsh_run_prompt', { prompt: 'escape', cwd: '/etc' }, guardedAgent).then(() => undefined, (error) => error)
  const insideDir = await mkdtemp(guardRoot + '/inside-')
  const inside = await dispatch('dsh_run_prompt', { prompt: 'stay inside', cwd: insideDir }, guardedAgent)
  await check('an internal caller cannot start a session outside its own workspace root', () => {
    assert.match(String(outside && outside.message), /inside this caller's workspace/)
    assert.ok(inside && inside.sessionId, 'a directory inside the caller workspace is allowed')
  })
  await rm(guardRoot, { recursive: true, force: true })

  // Unknown tools are a malformed request (-32602), not method-not-found.
  const unknownTool = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  })
  const badUri = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'resources/read',
    params: { uri: 'dsh://session/%E0%A4%A' },
  })
  await check('unknown tools and malformed resource ids are invalid params, not internal errors', () => {
    assert.equal(unknownTool.error.code, -32602, 'an unknown tool name is invalid params')
    assert.equal(badUri.error.code, -32602, 'a malformed resource id is invalid params')
  })

  await h.disposeAll()
  const routesAfterDisposal = webServer.registered.length
  const toolsAfterDisposal = registeredTools().length
  await check('disposal removes the routes and the locally registered tools', () => {
    assert.equal(routesAfterDisposal, 0, 'disposal removes the routes')
    assert.equal(toolsAfterDisposal, 0, 'disposal removes the local tools')
  })

  h.finish()
} finally {
  await h.close()
}
