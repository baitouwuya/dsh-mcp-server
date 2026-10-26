#!/usr/bin/env node
/**
 * Configuration, workspace-grouping and delivery integration checks: the
 * /mcp-config route the settings page drives, the sidebar repair, delivery
 * modes and sender attribution, the GUI jump, surface-mode switches, the
 * published endpoint file, hot reload, and the advertised URL.
 *
 * Run: node test/integration/config-and-grouping.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { groupOwnedSessions } from '../../lib/workspace-grouping.js'
import { apply } from '../../index.js'
import { createPluginHarness, makeContext, INTERNAL_AGENT, PROMPT } from '../helpers/plugin-harness.mjs'

const h = await createPluginHarness({ label: 'config-and-grouping' })
const {
  services,
  ctx,
  configRoute,
  configUrl,
  registeredTools,
  injectedMessages,
  workspaces,
  workspaceCalls,
  configEdits,
  currentId,
} = h
const { call, rpc, check } = h

const metaCall = (name, args, agent = INTERNAL_AGENT) => {
  const definition = registeredTools().find((tool) => tool.name === name)
  assert.ok(definition, `the front door exposes ${name}`)
  return definition.execute(args, { agent })
}
const dispatch = (tool, args, agent = INTERNAL_AGENT) => metaCall('dsh_mcp_call', { tool, arguments: args }, agent)

try {
  // --- workspace grouping -------------------------------------------------------
  // The Web sidebar groups by the Workspace registry's recorded membership, and
  // this endpoint never invents a project: a session whose directory has none is
  // left in "Ungrouped", exactly where the Harness would have put it.
  const unownedDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-ungrouped-'))
  const before = workspaceCalls().filter((call) => call.path === unownedDir).length
  const ungrouped = await dispatch('dsh_run_prompt', { prompt: 'no project for this', cwd: unownedDir })
  const lookups = workspaceCalls().slice(before)
  const unownedProjects = workspaces().some((workspace) => workspace.path === unownedDir)
  await check('a session whose directory has no project stays in Ungrouped', () => {
    assert.equal(ungrouped.workspace, undefined, 'no project is invented for the directory')
    assert.equal(unownedProjects, false)
    assert.equal(lookups.every((call) => call.op === 'resolve'), true, 'the directory is only looked up')
  })

  // A directory that already is a project is joined, because that is what the
  // sidebar shows for every session run there.
  const project = await services.workspaceRegistry.create(unownedDir, 'Existing Project')
  const grouped = await dispatch('dsh_run_prompt', { prompt: 'join the project', cwd: unownedDir })
  const groupedWorkspace = grouped.workspace
  const groupedSessions = workspaces().find((workspace) => workspace.path === unownedDir).sessionIds
  await check('a session whose directory already has a project joins it', () => {
    assert.equal(groupedWorkspace.id, project.id)
    assert.equal(groupedWorkspace.created, false, 'the existing project is reused, never recreated')
    assert.equal(groupedWorkspace.attached, true)
    assert.deepEqual(groupedSessions, [grouped.sessionId])
  })

  const joined = await dispatch('dsh_continue_session', { sessionId: grouped.sessionId, prompt: 'continue' })
  await check('a continuation joins the project its directory already has', () => {
    assert.equal(joined.workspace.attached, true)
    assert.equal(joined.workspace.created, false, 'a continuation never invents a project')
  })

  // The one-shot repair: sessions an earlier build created are still ungrouped,
  // and only this endpoint's own registry knows which ones those are.
  const legacyDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-legacy-'))
  const legacyProject = await services.workspaceRegistry.create(legacyDir, 'Legacy Project')
  const repair = await groupOwnedSessions({ get: () => services.workspaceRegistry }, {
    ownedSessions: () => [{ sessionId: 'session-legacy', cwd: legacyDir }],
  })
  const repairedProject = workspaces().find((workspace) => workspace.path === legacyDir)
  await check('the startup repair attaches sessions to projects that already exist', () => {
    assert.equal(repair.considered, 1)
    assert.equal(repair.created, 0, 'the repair creates nothing unless asked to')
    assert.equal(repair.attached, 1)
    assert.deepEqual(repairedProject.sessionIds, ['session-legacy'])
    assert.equal(legacyProject.id, repairedProject.id)
  })

  const inventedDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-invented-'))
  const optedIn = await groupOwnedSessions({ get: () => services.workspaceRegistry }, {
    ownedSessions: () => [{ sessionId: 'session-invented', cwd: inventedDir }],
  }, { create: true })
  const inventedSessions = workspaces().find((workspace) => workspace.path === inventedDir).sessionIds
  await check('creating a project is possible only by opting in', () => {
    assert.equal(optedIn.created, 1, 'a deployment that opts in gets a project')
    assert.deepEqual(inventedSessions, ['session-invented'])
  })

  // --- message delivery and sender attribution ----------------------------------
  const steered = await dispatch('dsh_continue_session', { sessionId: currentId(), prompt: 'steer me', mode: 'steer' })
  const steerRow = injectedMessages().at(-1)
  await check('an internal prompt is delivered as a steer labelled with the sending session', () => {
    assert.equal(steered.mode, 'steer')
    assert.equal(steered.from, 'live-session')
    assert.equal(steerRow.mode, 'steer', 'mode: "steer" reaches the agent as a steer')
    assert.equal(steerRow.message.source.kind, 'dsh-mcp-server')
    assert.equal(steerRow.message.source.sessionId, 'live-session', 'the message names the session that sent it')
  })

  await dispatch('dsh_continue_session', { sessionId: currentId(), prompt: 'queue me', mode: 'queue' })
  await check('mode: "queue" overrides the deployment setting', () => {
    assert.equal(injectedMessages().at(-1).mode, 'queue', 'mode: "queue" waits for the next turn')
  })

  const followed = await dispatch('dsh_continue_session', { sessionId: currentId(), prompt: 'follow the setting' })
  await check("without mode the delivery follows this deployment's own busy-Enter setting", () => {
    assert.equal(followed.mode, 'steer', 'without mode the deployment busy-enter setting decides')
  })

  const externalContinue = await call('dsh_continue_session', { sessionId: currentId(), prompt: 'from an MCP client' })
  const lastInjectedText = injectedMessages().at(-1).message.content[0].text
  await check('an external MCP caller keeps the unlabelled controller path', () => {
    assert.equal(externalContinue.mode, 'steer', 'the same policy governs an external caller')
    assert.equal(lastInjectedText !== 'from an MCP client', true, 'an external caller keeps the controller path')
  })

  // --- the configuration route the settings page drives -------------------------
  const configRead = await (await fetch(configUrl)).json()
  await check('the configuration route reports the surface, the page, and the delivery policy', () => {
    assert.equal(configRead.exposeToDsh, true)
    assert.equal(configRead.exposeToDshMode, 'lazy')
    assert.deepEqual([...configRead.registered].sort(), ['dsh_mcp_call', 'dsh_mcp_open', 'dsh_mcp_tools'])
    assert.equal(configRead.published.length, 21)
    assert.equal(configRead.configPath, '/mcp-config')
    assert.equal(configRead.clientPage.inGraph, true)
    assert.equal(configRead.busyMode, 'setting')
    assert.equal(configRead.groupSessions, true)
    assert.equal(configRead.createGroups, false, 'inventing a project is off by default')
  })

  const configWrite = await (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDsh: false }),
  })).json()
  const firstEdit = configEdits()[0]
  await check('the configuration route saves the switch through the profile configuration editor', () => {
    assert.equal(configWrite.ok, true)
    assert.equal(configWrite.exposeToDsh, false)
    assert.equal(configEdits().length, 1)
    assert.equal(firstEdit.entry.options.id, 'dsh-mcp-server')
    assert.equal(firstEdit.next.exposeToDsh, false)
  })

  const modeWrite = await (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDshMode: 'full' }),
  })).json()
  const secondEdit = configEdits()[1]
  await check('the configuration route saves the surface mode', () => {
    assert.equal(modeWrite.ok, true)
    assert.equal(modeWrite.exposeToDshMode, 'full')
    assert.equal(configEdits().length, 2)
    assert.equal(secondEdit.next.exposeToDshMode, 'full')
  })

  const policyWrite = await (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupSessions: false, createGroups: true, busyMode: 'queue' }),
  })).json()
  const thirdEdit = configEdits().at(-1)
  await check('the configuration route saves the grouping and delivery policies the page offers', () => {
    assert.equal(policyWrite.ok, true)
    assert.equal(policyWrite.groupSessions, false)
    assert.equal(policyWrite.createGroups, true)
    assert.equal(policyWrite.busyMode, 'queue')
    assert.deepEqual(thirdEdit.next, { groupSessions: false, createGroups: true, busyMode: 'queue' })
    assert.equal(configRead.busyEffective, 'steer', 'the page can show what the setting resolves to')
  })

  const policyRefusals = await Promise.all([
    fetch(configUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupSessions: 'yes' }) }),
    fetch(configUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ busyMode: 'always' }) }),
  ])
  await check('the configuration route rejects a non-boolean grouping flag and an unknown delivery policy', () => {
    assert.deepEqual(policyRefusals.map((response) => response.status), [400, 400])
  })

  // --- the GUI jump -------------------------------------------------------------
  // The Host cannot push to the page: DSH forwards only a build-time allowlist of
  // events. A command waits on this route for whichever page is open.
  const jump = await dispatch('dsh_open_session', { sessionId: currentId() })
  const pending = await (await fetch(configUrl)).json()
  const acknowledged = await (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ackCommand: true }),
  })).json()
  const unknownJump = await dispatch('dsh_open_session', { sessionId: 'session-nope' }).then(() => undefined, (error) => error)
  await check('dsh_open_session queues a GUI command for the open page and refuses an unknown session', () => {
    assert.equal(jump.queued, true)
    assert.equal(jump.sessionId, currentId())
    assert.equal(pending.command.kind, 'open-session')
    assert.equal(pending.command.sessionId, currentId())
    assert.equal(acknowledged.command, null, 'an acknowledged command is consumed')
    assert.match(String(unknownJump && unknownJump.message), /Unknown session/)
  })

  const configRefusal = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDsh: 'yes' }),
  })
  const modeRefusal = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDshMode: 'sometimes' }),
  })
  const emptyRefusal = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const relativeRemoval = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ removeGroups: ['not/absolute'] }),
  })
  const unknownField = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exposeToDsh: true, typo: 1 }),
  })
  const notJson = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ ackCommand: true }),
  })
  const foreignOrigin = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ ackCommand: true }),
  })
  const oversized = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ openSession: 'x'.repeat(5000) }),
  })
  const oversizedBody = await oversized.json()
  await check('the configuration route rejects a non-boolean, an unknown mode, an empty patch, a relative path, unknown fields, non-JSON bodies, foreign origins, and oversized bodies', () => {
    assert.equal(configRefusal.status, 400)
    assert.equal(modeRefusal.status, 400)
    assert.equal(emptyRefusal.status, 400)
    assert.equal(relativeRemoval.status, 400)
    assert.equal(unknownField.status, 400, 'an unknown field is refused instead of being ignored')
    assert.equal(notJson.status, 415, 'a CORS-simple body type is refused')
    assert.equal(foreignOrigin.status, 403, 'a foreign browser origin is refused')
    assert.equal(oversized.status, 413, 'an oversized body gets a 413, not a reset socket')
    assert.match(String(oversizedBody.error), /2048/, 'the ceiling is the configured one, not the built-in default')
  })

  // Undoing automation: a project registration can be dropped deliberately.
  const removeNow = async () => (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ removeGroups: [inventedDir] }),
  })).json()
  const removal = await removeNow()
  const removalAgain = await removeNow()
  const inventedStillThere = workspaces().some((workspace) => workspace.path === inventedDir)
  await check('the configuration route removes a project registration without touching sessions', () => {
    assert.equal(removal.ok, true)
    assert.equal(removal.removal.removed.length, 1)
    assert.equal(removal.removal.removed[0].path, inventedDir)
    assert.equal(removal.applied, 'unchanged', 'a removal does not reload the plugin')
    assert.equal(inventedStillThere, false)
    assert.deepEqual(removalAgain.removal.missing, [inventedDir], 'a second removal reports the path as missing')
  })

  const foreignResponse = {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status },
    end(body) { this.body = body ?? '' },
  }
  await configRoute.handler({ method: 'GET', socket: { remoteAddress: '10.0.0.7' } }, foreignResponse)
  await check('the configuration route answers the local machine only', () => {
    assert.equal(foreignResponse.statusCode, 403)
  })

  /** A throwaway context that only records what a registration would install. */
  const collectorContext = (sink) => makeContext({
    webServer: { register: () => () => {} },
    tools: {
      register: (definition) => { sink.push(definition); return () => {} },
      get: () => undefined,
    },
  }, [])

  const offTools = []
  apply(collectorContext(offTools), { token: 'off-token', endpointFile: join(h.dir, 'off-endpoint.json'), url: 'http://127.0.0.1:9', dshHome: h.dir, exposeToDsh: false })
  await check('exposeToDsh: false leaves the Harness tool registry untouched', () => {
    assert.equal(offTools.length, 0, 'the switch off keeps the surface MCP-only')
  })

  const onTools = []
  apply(collectorContext(onTools), { token: 'on-token', endpointFile: join(h.dir, 'on-endpoint.json'), url: 'http://127.0.0.1:9', dshHome: h.dir })
  const onNames = onTools.map((tool) => tool.name).sort()
  await check('the local surface is on by default, as the three-tool front door', () => {
    assert.equal(onTools.length, 3, 'the lazy surface is on by default')
    assert.deepEqual(onNames, ['dsh_mcp_call', 'dsh_mcp_open', 'dsh_mcp_tools'])
  })

  // The full surface is the opt-in: the whole table, projected for the registry.
  const catalog = await rpc({ jsonrpc: '2.0', id: h.nextId(), method: 'tools/list', params: {} })
  const mcpNames = catalog.result.tools.map((tool) => tool.name).sort()
  const fullTools = []
  apply(collectorContext(fullTools), { token: 'full-token', endpointFile: join(h.dir, 'full-endpoint.json'), url: 'http://127.0.0.1:9', dshHome: h.dir, exposeToDshMode: 'full' })
  const fullNames = fullTools.map((tool) => tool.name).sort()
  const runPromptTool = fullTools.find((tool) => tool.name === 'dsh_run_prompt')
  const renderedObject = runPromptTool.output.render(undefined, { answer: 42 })[0].text
  const renderedString = runPromptTool.output.render(undefined, 'plain')[0].text
  await check('exposeToDshMode: full registers every published tool, projected for the registry', () => {
    assert.equal(fullTools.length, 21, 'full mode registers the whole table')
    assert.deepEqual(fullNames, mcpNames)
    assert.equal(runPromptTool.parameters.properties.prompt.minLength, undefined, 'unsupported keywords must be dropped')
    assert.deepEqual(runPromptTool.parameters.properties.wait, { type: 'boolean', description: 'Wait for the turn to finish (default true).' })
    assert.deepEqual(runPromptTool.parameters.required, ['prompt'])
    assert.equal(runPromptTool.parameters.additionalProperties, false)
    assert.equal(renderedObject, '{\n  "answer": 42\n}')
    assert.equal(renderedString, 'plain')
  })

  let modeTypo
  try {
    apply(collectorContext([]), { token: 'typo-token', endpointFile: join(h.dir, 'typo-endpoint.json'), dshHome: h.dir, exposeToDshMode: 'sometimes' })
  } catch (error) {
    modeTypo = error
  }
  await check('an unknown surface mode fails at load instead of changing the surface', () => {
    assert.match(String(modeTypo && modeTypo.message), /exposeToDshMode/)
  })

  const endpoint = JSON.parse(await readFile(h.endpointFile, 'utf8'))
  await check('the published endpoint file carries the exact stdio bridge path', () => {
    assert.equal(endpoint.token, 'integration-token')
    assert.equal(endpoint.url, 'http://127.0.0.1:9/mcp')
    assert.ok(endpoint.stdioBridge.endsWith('/bin/dsh-mcp-stdio.mjs'), `unexpected stdioBridge path: ${endpoint.stdioBridge}`)
    assert.ok(!endpoint.stdioBridge.includes('/bin/bin/'))
  })

  // --- task-start work sync is its own bundle row -------------------------------
  // This bundle no longer subscribes to session events: the dsh-work-sync row
  // mounts the engine and publishes a service, and this endpoint only reads it.
  // The endpoint's one session/event listener exists only for must-reply
  // liveness: passive reminders and honoring a human stop. The sync engine is
  // still the separate row's business.
  const sessionEventListener = ctx.hooks.get('session/event')
  const statusWithoutSync = await call('dsh_status', {})
  const syncWrite = await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ syncOnStart: false }),
  })
  const syncWriteBody = await syncWrite.json()
  await check('task-start sync is a separate row: the MCP row mounts no sync engine and saves no sync switch', () => {
    assert.equal(typeof sessionEventListener, 'function', 'the MCP row listens for question liveness')
    assert.equal(statusWithoutSync.sync.present, false, 'without the sync row the status says so')
    assert.equal(statusWithoutSync.sync.enabled, false)
    assert.equal(syncWrite.status, 400, 'the sync switch is refused when the row that owns it is absent')
    assert.match(String(syncWriteBody.error), /dsh-work-sync/)
  })

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
  for (const dispose of newA) await dispose?.()
  await rm(reloadDirA, { recursive: true, force: true })
  await check('a reload that disposes first keeps the endpoint file of the new activation', () => {
    assert.notEqual(afterDisposeThenApply.instanceId, idBefore, 'the newer activation republishes the endpoint file')
  })

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
  for (const dispose of newB) await dispose?.()
  await rm(reloadDirB, { recursive: true, force: true })
  await check('a reload that applies first keeps the endpoint file when the old activation disposes', () => {
    assert.equal(afterApplyThenDispose.instanceId, idNew, 'the outgoing activation must not delete the new endpoint file')
  })

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
  const readyIsFunction = typeof readyCallback === 'function'
  if (readyIsFunction) {
    carrier.port = 41234
    readyCallback()
  }
  await new Promise((resolve) => setTimeout(resolve, 80))
  const bound = JSON.parse(await readFile(urlFile, 'utf8'))
  if (ambientUrl !== undefined) process.env.DSH_WEB_URL = ambientUrl
  for (const dispose of urlDisposers) await dispose?.()
  await rm(urlDir, { recursive: true, force: true })
  await check('the advertised URL follows the listener port once the app is ready', () => {
    assert.equal(boundLater.url, 'http://127.0.0.1:19387/mcp', 'an unbound listener can only advertise the documented default')
    assert.equal(readyIsFunction, true, 'the plugin must wait for the launch signal, not guess')
    assert.equal(bound.url, 'http://127.0.0.1:41234/mcp', 'a wildcard bind is advertised as loopback with the real port')
    assert.equal(bound.instanceId, boundLater.instanceId)
  })


  // --- configuration presets ---------------------------------------------------
  // A preset fills only the fields the row leaves unset; an explicit value wins.
  const presetHarness = async (label, applyOptions) => {
    const harness = await createPluginHarness({ label, applyOptions })
    try {
      const config = await (await fetch(harness.configUrl)).json()
      const status = await harness.call('dsh_status')
      return { config, status }
    } finally {
      await harness.close()
    }
  }
  const strictPreset = await presetHarness('preset-strict', { preset: 'strict' })
  const observerPreset = await presetHarness('preset-observer', { preset: 'observer' })
  const overridePreset = await presetHarness('preset-override', { preset: 'observer', exposeToDsh: true })
  const badPreset = await createPluginHarness({ label: 'preset-bad', applyOptions: { preset: 'sometimes' } })
    .then(() => undefined, (error) => error)
  await check('the strict preset isolates callers and queues busy deliveries', () => {
    assert.equal(strictPreset.config.preset, 'strict')
    assert.equal(strictPreset.config.restrictToOwner, true)
    assert.equal(strictPreset.config.answerUserRequests, false)
    assert.equal(strictPreset.config.busyMode, 'queue')
    assert.equal(strictPreset.status.configPreset, 'strict')
    assert.equal(strictPreset.status.grouping.attach, true, 'grouping is not narrowed by strict')
  })
  await check('the observer preset keeps the endpoint MCP-only and out of the sidebar', () => {
    assert.equal(observerPreset.config.preset, 'observer')
    assert.equal(observerPreset.config.exposeToDsh, false)
    assert.equal(observerPreset.config.groupSessions, false)
    assert.equal(observerPreset.config.restrictToOwner, true)
    assert.equal(observerPreset.status.dshTools.enabled, false)
  })
  await check('an explicit row field overrides its preset value', () => {
    assert.equal(overridePreset.config.preset, 'observer')
    assert.equal(overridePreset.config.exposeToDsh, true)
    assert.equal(overridePreset.status.dshTools.enabled, true)
  })
  await check('an unknown preset fails at load and names the accepted ones', () => {
    assert.match(String(badPreset?.message), /"preset" must be one of delegate, strict, observer/)
  })
  const presetWrite = await (await fetch(configUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: 'strict' }),
  })).json()
  await check('the configuration route accepts a preset patch', () => {
    assert.equal(presetWrite.ok, true)
    assert.equal(configEdits().at(-1).next.preset, 'strict')
  })
  h.finish()
} finally {
  await h.close()
}
