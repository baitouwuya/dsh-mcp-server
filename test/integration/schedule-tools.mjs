#!/usr/bin/env node
/**
 * Scheduled-task integration checks: the five `dsh_schedule_*` tools over the
 * Host `schedule` service — argument mapping to the service request, the
 * delivery-target forms, the display-zone occurrence, edit/delete/conflict
 * results, Harness error codes, and the missing-service diagnostic.
 *
 * Run: node test/integration/schedule-tools.mjs
 */

import assert from 'node:assert/strict'

import { createPluginHarness, INTERNAL_AGENT } from '../helpers/plugin-harness.mjs'

const h = await createPluginHarness({ label: 'schedule-tools' })
const { registeredTools, scheduleCalls, scheduleTasks, dropService } = h
const { call, rpc, check } = h

const RRULE = 'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY'
const fail = (response) => {
  assert.ok(response.result?.isError, 'the call must fail')
  return response.result.content[0].text
}
const dispatch = (args) => {
  const definition = registeredTools().find((tool) => tool.name === 'dsh_mcp_call')
  assert.ok(definition, 'the front door is registered')
  return definition.execute({ tool: 'dsh_schedule_create', arguments: args }, { agent: INTERNAL_AGENT })
}

try {
  const created = await call('dsh_schedule_create', { title: '晨间部署检查', prompt: 'Check the deployment.', rrule: RRULE })
  const createCall = scheduleCalls().find((entry) => entry.op === 'create')
  await check('dsh_schedule_create maps an rrule and the default target onto the service request', () => {
    assert.equal(created.id, 'schedule-1')
    assert.equal(created.kind, 'rrule')
    assert.deepEqual(createCall.request.timing, { kind: 'rrule', rrule: RRULE })
    assert.deepEqual(createCall.request.target, { kind: 'new_once' }, 'an omitted target defaults to new_once')
    assert.equal(createCall.actorSessionId, undefined, 'an external caller has no acting session')
    assert.equal(created.scheduledAtLocal, '2026-11-10T09:00:00+08:00', 'the occurrence is shown in the rule zone')
  })

  const daily = await call('dsh_schedule_create', {
    title: 'Tokyo standup',
    prompt: 'Send the standup summary.',
    timing: { kind: 'daily', daily: { time: '10:00:00', time_zone: 'Asia/Tokyo' } },
    sessionId: 'session-current',
  })
  const dailyCall = scheduleCalls().filter((entry) => entry.op === 'create')[1]
  await check('a nested timing selector and an explicit session target pass through unchanged', () => {
    assert.deepEqual(dailyCall.request.timing, { kind: 'daily', daily: { time: '10:00:00', time_zone: 'Asia/Tokyo' } })
    assert.deepEqual(dailyCall.request.target, { kind: 'session', sessionId: 'session-current' })
    assert.equal(daily.scheduledAtLocal, '2026-11-10T10:00:00+09:00', 'the task zone wins over UTC')
  })

  const createdWithOptions = await call('dsh_schedule_create', {
    title: 'Weekly review',
    prompt: 'Review the week.',
    rrule: RRULE,
    target: 'new',
    cwd: '/tmp',
    agentPreset: 'standard',
  })
  const optionsCall = scheduleCalls().filter((entry) => entry.op === 'create')[2]
  await check('a creating target carries the session options the caller named', () => {
    assert.deepEqual(optionsCall.request.target, {
      kind: 'new',
      create: { cwd: '/tmp', agentPreset: 'standard' },
    })
    assert.equal(createdWithOptions.target.kind, 'new')
  })

  const externalThisSession = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: {
      name: 'dsh_schedule_create',
      arguments: { title: 'Mine', prompt: 'Ping me.', rrule: RRULE, target: 'this_session' },
    },
  })
  const internalThisSession = await dispatch({ title: 'Mine', prompt: 'Ping me.', rrule: RRULE, target: 'this_session' })
  const internalCall = scheduleCalls().filter((entry) => entry.op === 'create').at(-1)
  await check('this_session needs an acting session: refused outside, resolved inside', () => {
    assert.match(fail(externalThisSession), /needs a calling DSH session/)
    assert.deepEqual(internalCall.request.target, { kind: 'session', sessionId: 'live-session' })
    assert.equal(internalCall.actorSessionId, 'live-session', 'an internal call is attributed to its session')
    assert.equal(internalThisSession.id, 'schedule-4')
  })

  const noTiming = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_schedule_create', arguments: { title: 'No rule', prompt: 'Ping.' } },
  })
  const longTitle = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_schedule_create', arguments: { title: 'x'.repeat(121), prompt: 'Ping.', rrule: RRULE } },
  })
  const emptyPrompt = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_schedule_create', arguments: { title: 'Empty', prompt: '  ', rrule: RRULE } },
  })
  await check('the create arguments are checked before the Host write', () => {
    assert.match(fail(noTiming), /"rrule" or "timing" is required/)
    assert.match(fail(longTitle), /at most 120 characters/)
    assert.match(fail(emptyPrompt), /"prompt" must not be empty/)
  })

  const page = await call('dsh_schedule_list', { active: true, limit: 2, offset: 1 })
  const listed = scheduleCalls().filter((entry) => entry.op === 'list').at(-1)
  await check('dsh_schedule_list forwards the page and renders every occurrence', () => {
    assert.deepEqual(listed.request, { active: true, limit: 2, offset: 1 })
    assert.equal(page.shown, 2)
    assert.ok(page.items.every((task) => /T\d\d:\d\d:\d\d[+-]/.test(task.scheduledAtLocal)), 'each row carries a local occurrence')
  })

  const viewed = await call('dsh_schedule_view', { id: 'schedule-1' })
  const missingTask = await call('dsh_schedule_view', { id: 'schedule-404' })
  await check('dsh_schedule_view reads one task and reports an unknown id without failing the call', () => {
    assert.equal(viewed.prompt, 'Check the deployment.')
    assert.deepEqual(missingTask, { id: 'schedule-404', code: 'schedule_not_found' })
  })

  const renamed = await call('dsh_schedule_edit', { id: 'schedule-1', action: 'update', title: 'Renamed check', active: false })
  const edited = scheduleCalls().filter((entry) => entry.op === 'edit').at(-1)
  await check('an update sends exactly the fields it was given', () => {
    assert.deepEqual(edited.request.patch, { title: 'Renamed check', active: false })
    assert.equal(edited.request.action, 'update')
    assert.equal(renamed.title, 'Renamed check')
    assert.equal(renamed.status, 'paused')
  })

  const retimed = await call('dsh_schedule_edit', {
    id: 'schedule-2',
    action: 'update',
    timing: { kind: 'rrule', rrule: RRULE },
    sessionId: 'session-other',
  })
  const retimedCall = scheduleCalls().filter((entry) => entry.op === 'edit').at(-1)
  await check('an update can replace the recurrence and the destination together', () => {
    assert.deepEqual(retimedCall.request.patch, {
      timing: { kind: 'rrule', rrule: RRULE },
      target: { kind: 'session', sessionId: 'session-other' },
    })
    assert.equal(retimed.kind, 'rrule')
  })

  const conflict = await call('dsh_schedule_edit', {
    id: 'schedule-1',
    action: 'update',
    prompt: 'New instruction.',
    expectedUpdatedAt: '2026-11-01T00:00:00.000Z',
  })
  const staleUpdate = await call('dsh_schedule_view', { id: 'schedule-1' })
  await check('a conditional update that lost the race reports schedule_conflict and writes nothing', () => {
    assert.deepEqual(conflict, { id: 'schedule-1', code: 'schedule_conflict' })
    assert.equal(staleUpdate.prompt, 'Check the deployment.', 'the stored prompt is unchanged')
  })

  const noPatch = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_schedule_edit', arguments: { id: 'schedule-1', action: 'update' } },
  })
  const deleteWithPatch = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_schedule_edit', arguments: { id: 'schedule-1', action: 'delete', title: 'Nope' } },
  })
  const deleted = await call('dsh_schedule_edit', { id: 'schedule-3', action: 'delete' })
  await check('edit rejects an empty update and a delete carrying fields, then deletes cleanly', () => {
    assert.match(fail(noPatch), /needs at least one of/)
    assert.match(fail(deleteWithPatch), /A "delete" takes no patch fields/)
    assert.deepEqual(deleted, { id: 'schedule-3', deleted: true })
    assert.equal(scheduleTasks().some((task) => task.id === 'schedule-3'), false)
  })

  const ran = await call('dsh_schedule_run', { id: 'schedule-2' })
  const missingRun = await call('dsh_schedule_run', { id: 'schedule-404' })
  await check('dsh_schedule_run delivers one task now and reports an unknown id', () => {
    assert.equal(ran.id, 'schedule-2')
    assert.deepEqual(missingRun, { id: 'schedule-404', code: 'schedule_not_found' })
    assert.ok(scheduleCalls().some((entry) => entry.op === 'run' && entry.request.id === 'schedule-2'))
  })

  const invalidRule = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: {
      name: 'dsh_schedule_create',
      arguments: {
        title: 'Flat selector',
        prompt: 'Ping.',
        timing: { kind: 'daily', time: '09:00:00', timeZone: 'Asia/Shanghai' },
      },
    },
  })
  await check('the Host timing contract is not translated: a flat camelCase selector keeps its invalid_rule code', () => {
    const text = fail(invalidRule)
    assert.match(text, /invalid_rule/)
    assert.match(text, /must contain exactly kind and its matching selector/)
  })

  dropService('schedule')
  const uncomposed = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_schedule_list', arguments: {} },
  })
  await check('a deployment without the Schedule service says so instead of failing silently', () => {
    assert.match(fail(uncomposed), /"schedule" is unavailable in this deployment/)
  })

  h.finish()
} finally {
  await h.close()
}
