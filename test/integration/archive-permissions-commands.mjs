#!/usr/bin/env node
/**
 * Archive, permission-preset, model-selection and command integration checks:
 * the one write path that archives, the two prompt tools' preset pinning, the
 * live default model, and the slash-command surface.
 *
 * Run: node test/integration/archive-permissions-commands.mjs
 */

import assert from 'node:assert/strict'

import { createPluginHarness, PROMPT } from '../helpers/plugin-harness.mjs'

const h = await createPluginHarness({ label: 'archive-permissions-commands' })
const {
  services,
  archivedIds,
  setBusy,
  appliedPermissions,
  modelSelections,
  resolvedAgents,
  executedCommands,
  listedCommandAgents,
  currentId,
} = h
const { call, rpc, check } = h

try {
  const run = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' })
  const sessionIdFromRun = run.sessionId

  const listedBefore = await call('dsh_list_sessions', { limit: 5 })
  await check('dsh_list_sessions reports archival state', () => {
    assert.equal(listedBefore.sessions[0].archived, false)
  })

  setBusy(true)
  const refused = await rpc({ jsonrpc: '2.0', id: h.nextId(), method: 'tools/call', params: { name: 'dsh_archive_session', arguments: { sessionId: sessionIdFromRun } } })
  await check('dsh_archive_session refuses running work and names stopActivity', () => {
    assert.ok(refused.result?.isError, 'a session with running work must refuse a plain archive')
    assert.match(refused.result.content[0].text, /stopActivity/)
  })

  const stopped = await call('dsh_archive_session', { sessionId: sessionIdFromRun, stopActivity: true })
  setBusy(false)
  await check('dsh_archive_session archives with stopActivity', () => {
    assert.equal(stopped.archived, true)
    assert.equal(archivedIds().includes(sessionIdFromRun), true)
  })

  const hidden = await call('dsh_list_sessions', { limit: 5 })
  await check('dsh_list_sessions hides archived sessions by default', () => {
    assert.equal(hidden.count, 0)
    assert.equal(hidden.archivedHidden, 1)
  })

  const withArchived = await call('dsh_list_sessions', { limit: 5, includeArchived: true })
  await check('dsh_list_sessions includeArchived marks sessions archived', () => {
    assert.equal(withArchived.sessions[0].archived, true)
  })

  const archivedRead = await call('dsh_read_session', { sessionId: sessionIdFromRun, limit: 0 })
  await check('a transcript stays readable while its session is archived', () => {
    assert.ok(archivedRead.messages.length > 0)
  })

  const restored = await call('dsh_unarchive_session', { sessionId: sessionIdFromRun })
  const listedAgain = await call('dsh_list_sessions', { limit: 5 })
  await check('dsh_unarchive_session restores the session to the listing', () => {
    assert.equal(restored.archived, false)
    assert.equal(listedAgain.count, 1)
    assert.equal(listedAgain.sessions[0].archived, false)
  })

  // --- permission presets -----------------------------------------------------
  const roster = await rpc({ jsonrpc: '2.0', id: h.nextId(), method: 'tools/list', params: {} })
  const runPromptSchema = roster.result.tools.find((entry) => entry.name === 'dsh_run_prompt')
  const continueSchema = roster.result.tools.find((entry) => entry.name === 'dsh_continue_session')
  await check('tools/list advertises permissionPreset on both prompt tools', () => {
    assert.ok(runPromptSchema?.inputSchema.properties.permissionPreset, 'dsh_run_prompt must accept permissionPreset')
    assert.ok(continueSchema?.inputSchema.properties.permissionPreset, 'dsh_continue_session must accept permissionPreset')
  })

  const presets = await call('dsh_list_permission_presets', {})
  await check('dsh_list_permission_presets returns the deployment catalog', () => {
    assert.equal(presets.defaultPreset, 'workspace-write')
    assert.deepEqual(presets.presets.map((option) => option.value), ['read-only', 'workspace-write', 'danger-full-access'])
  })

  const pinned = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp', permissionPreset: 'read-only' })
  const pinnedRead = await call('dsh_read_session', { sessionId: pinned.sessionId, limit: 0 })
  await check('dsh_run_prompt applies permissionPreset and the transcript folds it back', () => {
    assert.equal(pinned.permissionPreset, 'read-only')
    assert.deepEqual(appliedPermissions(), ['read-only'])
    assert.equal(pinnedRead.permissionPreset, 'read-only')
  })

  const createdModels = modelSelections().map((entry) => `${entry.provider}/${entry.model}`)
  await check('dsh_run_prompt pins the default model on each new session', () => {
    assert.deepEqual(createdModels, [
      'deepseek-official/deepseek-v4.1-flash-anthropic',
      'deepseek-official/deepseek-v4.1-flash-anthropic',
    ])
  })

  const repinned = await call('dsh_continue_session', { sessionId: pinned.sessionId, prompt: PROMPT, permissionPreset: 'danger-full-access' })
  const repinnedRead = await call('dsh_read_session', { sessionId: pinned.sessionId, limit: 0 })
  await check('dsh_continue_session re-pins permissionPreset on an existing session', () => {
    assert.equal(repinned.permissionPreset, 'danger-full-access')
    assert.deepEqual(appliedPermissions(), ['read-only', 'danger-full-access'])
    assert.equal(repinnedRead.permissionPreset, 'danger-full-access')
  })

  const selectionsAfterRepin = modelSelections().length
  await check('dsh_continue_session without "model" leaves the session model alone', () => {
    assert.equal(selectionsAfterRepin, 2, 'continuing without "model" must not re-pin the session model')
  })

  const switched = await call('dsh_continue_session', { sessionId: pinned.sessionId, prompt: PROMPT, model: 'anthropic/claude-opus-5-5' })
  const switchedSelection = { provider: modelSelections().at(-1).provider, model: modelSelections().at(-1).model }
  await check('dsh_continue_session applies an explicit "model" override', () => {
    assert.equal(switched.status, 'completed')
    assert.deepEqual(switchedSelection, { provider: 'anthropic', model: 'claude-opus-5-5' })
  })

  const unknownPreset = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_run_prompt', arguments: { prompt: PROMPT, cwd: '/tmp', permissionPreset: 'no-such-preset' } },
  })
  await check('an unknown permission preset fails and lists the available ones', () => {
    assert.ok(unknownPreset.result?.isError, 'an unknown permission preset must fail the call')
    assert.match(unknownPreset.result.content[0].text, /no-such-preset/)
    assert.match(unknownPreset.result.content[0].text, /read-only/)
  })

  const cold = await call('dsh_continue_session', { sessionId: 'session-cold', prompt: PROMPT, permissionPreset: 'workspace-write' }, { headers: { 'x-dsh-mcp-client': 'claude-code' } })
  const permissionsAfterCold = appliedPermissions()
  const resolvedAfterCold = resolvedAgents()
  await check('a session the store does not hold is resumed through resolveAgent before pinning', () => {
    assert.equal(cold.permissionPreset, 'workspace-write')
    assert.equal(cold.owner.id, 'claude-code')
    assert.equal(cold.owner.adopted, true)
    assert.deepEqual(resolvedAfterCold, ['session-cold'])
    assert.deepEqual(permissionsAfterCold, ['read-only', 'danger-full-access', 'workspace-write'])
  })

  const selectionsAfterCold = modelSelections().length
  await check('resuming a session without "model" leaves its model alone', () => {
    assert.equal(selectionsAfterCold, 3, 'a resumed session without "model" must not re-pin the session model')
  })

  // The Harness default is volatile: a model the user picks after this plugin
  // started must be used by the next session rather than a value captured at
  // activation.
  services.setDefaultSelection({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash-1017-anthropic' })
  const liveStatus = await call('dsh_status', {})
  const liveModel = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' })
  const liveSelection = modelSelections().at(-1).model
  await check('the default model is resolved at call time', () => {
    assert.equal(liveStatus.defaultModel.model, 'deepseek-v4.1-flash-1017-anthropic', 'dsh_status reads the model at call time')
    assert.equal(liveModel.status, 'completed')
    assert.equal(liveSelection, 'deepseek-v4.1-flash-1017-anthropic', 'a new session follows the live default')
  })

  // A default that went stale (a retired pair) must not cost the session: the
  // Host keeps its own default and the call still completes.
  services.setSelectModelFailure(true)
  const staleDefault = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' })
  services.setSelectModelFailure(false)
  services.setDefaultSelection({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash-anthropic' })
  await check('a stale default model is logged instead of failing the prompt', () => {
    assert.equal(staleDefault.status, 'completed', 'a stale default model does not fail the session')
  })

  // --- commands ---------------------------------------------------------------
  const commandList = await call('dsh_list_commands', { sessionId: currentId() })
  const listedAgentSession = listedCommandAgents()[0].session.id
  await check('dsh_list_commands lists the commands of the session agent', () => {
    assert.deepEqual(commandList.commands.map((entry) => entry.name), ['compact', 'permission'])
    assert.equal(commandList.count, 2)
    assert.equal(listedAgentSession, 'live-session')
  })

  const compactRun = await call('dsh_run_command', { sessionId: currentId(), command: 'compact' })
  const compactAttachments = executedCommands()[0].attachments.length
  await check('dsh_run_command runs a bare command name as /name', () => {
    assert.equal(compactRun.command, '/compact')
    assert.equal(compactRun.kind, 'success')
    assert.match(compactRun.text, /Compacted 3 history items/)
    assert.equal(compactRun.sourceEventSeq, 99)
    assert.ok(compactRun.commandId)
    assert.equal(compactAttachments, 0)
  })

  const permissionRun = await call('dsh_run_command', { sessionId: currentId(), line: '/permission danger-full-access' })
  const permissionsAfterCommand = appliedPermissions()
  await check('dsh_run_command executes /permission through the same write path', () => {
    assert.equal(permissionRun.command, '/permission danger-full-access')
    assert.equal(permissionRun.kind, 'success')
    assert.deepEqual(permissionsAfterCommand, ['read-only', 'danger-full-access', 'workspace-write', 'danger-full-access'])
  })

  const unknownCommand = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_run_command', arguments: { sessionId: currentId(), command: 'no_such_command' } },
  })
  await check('an unknown command fails and lists the available ones', () => {
    assert.ok(unknownCommand.result?.isError, 'an unknown command must fail the call')
    assert.match(unknownCommand.result.content[0].text, /no_such_command/)
    assert.match(unknownCommand.result.content[0].text, /compact/)
  })

  const malformedCommand = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_run_command', arguments: { sessionId: currentId(), line: 'compact' } },
  })
  await check('a line without a leading slash is rejected before execution', () => {
    assert.ok(malformedCommand.result?.isError, 'a line without a leading slash must fail the call')
    assert.match(malformedCommand.result.content[0].text, /slash-command line/)
  })

  h.finish()
} finally {
  await h.close()
}
