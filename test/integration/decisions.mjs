#!/usr/bin/env node
/**
 * User-decision integration checks: parked approvals and questions, the
 * opted-in answerer, the pending-decision fold in list/read/wait, must-reply
 * questions across a turn, a human stop, and the reported delivery policy.
 *
 * Run: node test/integration/decisions.mjs
 */

import assert from 'node:assert/strict'

import { createPluginHarness, INTERNAL_AGENT, PROMPT } from '../helpers/plugin-harness.mjs'

const h = await createPluginHarness({ label: 'decisions' })
const { seedEvents, registeredTools, setCallerMode, currentId, injectedMessages, makeAgent } = h
const { call, rpc, check } = h

try {
  // --- answering pending decisions ---------------------------------------------
  const answerRefused = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_answer_request', arguments: { requestId: 'anything' } },
  })
  await check('dsh_answer_request refuses to answer unless the deployment opts in', () => {
    assert.ok(answerRefused.result?.isError, 'answering must be refused while the flag is off')
    assert.match(answerRefused.result.content[0].text, /answerUserRequests/)
  })

  const responder = await createPluginHarness({
    token: 'responder-token',
    tempPrefix: 'dsh-mcp-responder-',
    applyOptions: { answerUserRequests: true, requestAnswerTimeoutMs: 60_000 },
  })
  try {
    const responderCall = (name, args, headers) => responder.rpc(
      { jsonrpc: '2.0', id: responder.nextId(), method: 'tools/call', params: { name, arguments: args } },
      { headers },
    )
    await check('an opted-in endpoint composes both Cordis waterfall answerers', () => {
      assert.equal(typeof responder.hooks.get('approval/request'), 'function')
      assert.equal(typeof responder.hooks.get('user-questions/request'), 'function')
    })

    const owned = await responderCall('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' }, { 'x-dsh-mcp-client': 'responder' })
    const ownedSession = owned.result.structuredContent.sessionId
    responder.seedEvents([
      { type: 'approval/asked', data: { id: 'audit-1', toolName: 'bash', callId: 'call-park', reason: 'escalate sandbox' } },
    ])

    let delegated = false
    const approvalNext = async () => { delegated = true; return 'unavailable' }
    const pendingOutcome = responder.hooks.get('approval/request')(
      { agent: { session: { id: ownedSession } }, toolName: 'bash', callId: 'call-park', reason: 'escalate sandbox' },
      approvalNext,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    const parkedListing = await responderCall('dsh_list_requests', { sessionId: ownedSession })
    const parkedRow = parkedListing.result.structuredContent.sessions[0]?.pending?.approvals?.[0]
    await check('a parked approval is listed as answerable while the GUI answerer keeps its chance', () => {
      assert.equal(parkedRow.id, 'audit-1')
      assert.equal(parkedRow.answerable, true)
      assert.equal(delegated, true, 'the other answerers must still be asked')
    })

    const allowed = await responderCall('dsh_answer_request', { requestId: 'audit-1', decision: 'allow' })
    const allowedOutcome = await pendingOutcome
    await check('dsh_answer_request settles a parked approval with a one-shot grant', () => {
      assert.equal(allowed.result.structuredContent.outcome, 'allowed-once')
      assert.equal(allowedOutcome, 'allowed-once')
    })

    const denied = responder.hooks.get('approval/request')(
      { agent: { session: { id: ownedSession } }, toolName: 'bash', callId: 'call-park-2' },
      async () => 'unavailable',
    )
    const denyCall = await responderCall('dsh_answer_request', { requestId: 'call-park-2', decision: 'deny' })
    const deniedOutcome = await denied
    await check('a denied approval resolves as rejected', () => {
      assert.equal(denyCall.result.structuredContent.outcome, 'rejected')
      assert.equal(deniedOutcome, 'rejected')
    })

    const foreign = await responder.hooks.get('approval/request')(
      { agent: { session: { id: 'session-someone-else' } }, toolName: 'bash', callId: 'call-foreign' },
      async () => 'unavailable',
    )
    const foreignOutcome = await foreign
    const foreignAnswer = await responderCall('dsh_answer_request', { requestId: 'call-foreign', decision: 'allow' })
    await check('a request from a session this endpoint does not drive is delegated untouched', () => {
      assert.equal(foreignOutcome, 'unavailable')
      assert.ok(foreignAnswer.result.isError, 'a session this endpoint does not drive is never parked')
    })

    // An approval grants a sandbox strictly wider than the asking session's, so an
    // internal caller below the widest rung could exceed its own authority by
    // granting it; the local surface refuses that and leaves the GUI in the race.
    const internalApproval = responder.hooks.get('approval/request')(
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
    // The refusal must leave the decision parked and unresolved: the same request
    // still settles once the caller holds the widest rung, and only then.
    responder.setCallerMode('danger-full-access')
    const grantedApproval = await internalAnswer('dsh_answer_request', { requestId: 'call-internal-approval', decision: 'allow' })
    const internalOutcome = await internalApproval
    await check('an internal caller settles an approval only when it already holds the widest mode', () => {
      assert.ok(refusedApproval, 'an internal caller below the widest rung must not settle an approval')
      assert.match(String(refusedApproval.message), /cannot settle an approval/)
      assert.equal(grantedApproval.outcome, 'allowed-once')
      assert.equal(internalOutcome, 'allowed-once')
    })

    const questionOutcome = responder.hooks.get('user-questions/request')(
      {
        agent: { session: { id: ownedSession } },
        questions: [{ id: 'q-ship', question: 'Ship it?', options: [{ label: 'yes' }, { label: 'no' }] }],
        wait: { callId: 'call-q-live' },
      },
      async () => { throw new Error('no user-questions answerer accepted the request') },
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    const badAnswers = await responderCall('dsh_answer_request', { requestId: 'call-q-live', answers: [] })
    const answered = await responderCall('dsh_answer_request', {
      requestId: 'call-q-live',
      answers: [{ id: 'q-ship', selected: ['yes'] }],
    })
    const answeredOutcome = await questionOutcome
    await check('dsh_answer_request answers a parked question in service vocabulary', () => {
      assert.ok(badAnswers.result.isError, 'a question needs an answer batch')
      assert.match(badAnswers.result.content[0].text, /answers/)
      assert.deepEqual(answered.result.structuredContent.answers, [{ id: 'q-ship', selected: ['yes'] }])
      assert.deepEqual(answeredOutcome, { answers: [{ id: 'q-ship', selected: ['yes'] }] })
    })

    // A plain blocking question carries no wait.callId: the parked id must be the durable
    // sub-call id so dsh_list_requests and dsh_answer_request agree.
    responder.seedEvents([
      { type: 'tool/ptc-dispatch-start', data: { name: 'ask_user_question', subCallId: 'call-q-block:ptc:1', arguments: { questions: [{ id: 'q-block', question: 'Blocked?' }] } } },
    ])
    const blockingQuestion = responder.hooks.get('user-questions/request')(
      { agent: { session: { id: ownedSession } }, questions: [{ id: 'q-block', question: 'Blocked?' }] },
      async () => { throw new Error('no user-questions answerer accepted the request') },
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    const blockingListing = await responderCall('dsh_list_requests', { sessionId: ownedSession })
    const blockingRow = blockingListing.result.structuredContent.sessions[0].pending.questions.find((row) => row.callId === 'call-q-block:ptc:1')
    const blockingAnswer = await responderCall('dsh_answer_request', {
      requestId: 'call-q-block:ptc:1',
      answers: [{ id: 'q-block', selected: ['ok'] }],
    })
    const blockingOutcome = await blockingQuestion
    await check('a blocking question is parked under the id the listing reports', () => {
      assert.equal(blockingRow?.answerable, true, 'a blocking question must be parked under its durable id')
      assert.deepEqual(blockingAnswer.result.structuredContent.answers, [{ id: 'q-block', selected: ['ok'] }])
      assert.deepEqual(blockingOutcome, { answers: [{ id: 'q-block', selected: ['ok'] }] })
    })

    const missing = await responderCall('dsh_answer_request', { requestId: 'audit-1', decision: 'allow' })
    await check('an id that is no longer parked fails with a diagnostic', () => {
      assert.ok(missing.result.isError, 'an already settled id cannot be answered twice')
      assert.match(missing.result.content[0].text, /dsh_list_requests/)
    })
  } finally {
    await responder.close()
  }

  // --- pending user decisions --------------------------------------------------
  const codex = { headers: { 'x-dsh-mcp-client': 'codex' } }
  const created = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' }, codex)
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
  await check('dsh_list_requests folds pending approvals and questions, and settled ones on request', () => {
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
  })

  // A PTC agent dispatches the tool itself: the start event is the only trace while
  // the question blocks the turn, and the dispatch closes it.
  seedEvents([
    { type: 'tool/ptc-dispatch-start', data: { name: 'ask_user_question', subCallId: 'call-q3:ptc:1', arguments: { questions: [{ id: 'q3', question: 'Blocked?' }] } } },
  ])
  const blocked = await call('dsh_list_requests', { sessionId: created.sessionId }, codex)
  const blockedRow = blocked.sessions[0].pending.questions.find((row) => row.callId === 'call-q3:ptc:1')
  seedEvents([
    { type: 'tool/ptc-dispatch', data: { name: 'ask_user_question', subCallId: 'call-q3:ptc:1', isError: true, content: [{ type: 'text', text: 'Error: aborted' }] } },
  ])
  const settledBlocked = await call('dsh_list_requests', { sessionId: created.sessionId }, codex)
  await check('a PTC-dispatched question is visible while it blocks the turn, and closes when it settles', () => {
    assert.equal(blockedRow?.state, 'open')
    assert.equal(blockedRow?.questions[0].question, 'Blocked?')
    assert.equal(
      settledBlocked.sessions[0].pending.questions.some((row) => row.callId === 'call-q3:ptc:1'),
      false,
      'a settled dispatch must close the question',
    )
  })

  const pendingRead = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'outline', limit: 3 }, codex)
  await check('a read reports the user decisions the session is blocked on', () => {
    assert.equal(pendingRead.pending.count, 2)
    assert.equal(pendingRead.pending.approvals[0].id, 'app-open')
  })

  const pendingWait = await call('dsh_wait_session', { sessionId: created.sessionId }, codex)
  await check('a wait reports pending decisions instead of leaving a blocked turn unexplained', () => {
    assert.equal(pendingWait.status, 'idle')
    assert.equal(pendingWait.pending.count, 2)
    assert.deepEqual(pendingWait.pending.questions.map((row) => row.callId), ['call-q'])
  })

  const mineRequests = await call('dsh_list_requests', { mine: true, scan: 5 }, codex)
  await check('a request scan is scoped to the caller and omits settled decisions by default', () => {
    assert.equal(mineRequests.count, 1)
    assert.equal(mineRequests.includeSettled, undefined)
    assert.equal(mineRequests.sessions[0].settled, undefined)
  })

  // --- a must-reply question held open across a turn ---------------------------
  const metaCall = (name, args, agent = INTERNAL_AGENT) => {
    const definition = registeredTools().find((tool) => tool.name === name)
    assert.ok(definition, `the front door exposes ${name}`)
    return definition.execute(args, { agent })
  }
  const dispatch = (tool, args, agent = INTERNAL_AGENT) => metaCall('dsh_mcp_call', { tool, arguments: args }, agent)

  const asksBefore = injectedMessages().length
  const asking = call('dsh_ask_session', { sessionId: currentId(), question: 'WHICH FILE SHOULD THE EDIT TOUCH?' })
  let questionRow
  for (let attempt = 0; attempt < 200 && !questionRow; attempt += 1) {
    questionRow = injectedMessages().slice(asksBefore).find((row) => /#q-/.test(row.message.content[0].text))
    if (!questionRow) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const questionText = questionRow.message.content[0].text
  const questionId = /#(q-[\w-]+)/.exec(questionText)[1]
  // A reminder is injected into a call the target already makes; it never opens
  // a turn of its own and it does not repeat the question.
  const injectedBefore = injectedMessages().length
  const fireSessionEvent = (event) => h.ctx.hooks.get('session/event')({ id: currentId(), header: { id: currentId() } }, event)
  fireSessionEvent({ type: 'turn/start', data: { turn: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const reminderRow = injectedMessages().slice(injectedBefore).find((row) => row.mode === 'inject')
  const lookedUpAgain = await dispatch('dsh_get_question', { id: questionId }, makeAgent('agent-target', currentId()))
  const lookedUp = await dispatch('dsh_get_question', { id: questionId }, makeAgent('agent-target', currentId()))
  const answerPayload = await dispatch('dsh_answer_question', { id: questionId, answer: 'lib/x.js' }, makeAgent('agent-target', currentId()))
  const askResult = await asking
  const externalAnswer = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_answer_question', arguments: { id: questionId, answer: 'not mine' } },
  })
  const afterAskStatus = await call('dsh_status', {})
  await check('a must-reply question blocks until the addressed session answers by id', () => {
    assert.ok(questionRow, 'the question reaches the target as an internal message')
    assert.match(questionText, /WHICH FILE SHOULD THE EDIT TOUCH\?/, 'the first message carries the question')
    assert.match(questionText, /dsh_answer_question/, 'and tells the target how to answer')
    assert.ok(reminderRow, 'a reminder rides the next model call')
    assert.match(reminderRow.message.content[0].text, new RegExp('#' + questionId), 'the reminder names the id')
    assert.equal(reminderRow.message.content[0].text.includes('WHICH FILE SHOULD THE EDIT TOUCH?'), false, 'and not the question')
    assert.equal(lookedUpAgain.reminders >= 1, true, 'the injection is counted on the question')
    assert.equal(lookedUp.state, 'pending')
    assert.equal(lookedUp.question, 'WHICH FILE SHOULD THE EDIT TOUCH?')
    assert.equal(lookedUp.sessionId, currentId())
    assert.equal(answerPayload.status, 'answered')
    assert.equal(askResult.status, 'answered')
    assert.equal(askResult.id, questionId)
    assert.equal(askResult.answer, 'lib/x.js')
    assert.equal(askResult.sessionId, currentId())
    assert.ok(externalAnswer.result?.isError, 'an external caller has no session to answer as')
    assert.match(externalAnswer.result.content[0].text, /Only the addressed DSH session/)
    assert.equal(afterAskStatus.questions.pending, 0, 'an answered question leaves nothing pending')
  })

  // --- a human stop ends the question and is never fought ----------------------
  const stopAsk = call('dsh_ask_session', { sessionId: currentId(), question: 'SHOULD THIS WAKE THE STOPPED SESSION?' })
  let stopRow
  for (let attempt = 0; attempt < 200 && !stopRow; attempt += 1) {
    stopRow = injectedMessages().slice(asksBefore).find((row) => /SHOULD THIS WAKE/.test(row.message.content[0].text))
    if (!stopRow) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const stopId = /#(q-[\w-]+)/.exec(stopRow.message.content[0].text)[1]
  const stopDelivered = injectedMessages().length
  fireSessionEvent({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  const stoppedAsk = await stopAsk
  const refusedStopped = await rpc({
    jsonrpc: '2.0',
    id: h.nextId(),
    method: 'tools/call',
    params: { name: 'dsh_ask_session', arguments: { sessionId: currentId(), question: 'WAKE UP?' } },
  })
  const deliveredAfterStop = injectedMessages().length
  fireSessionEvent({ type: 'turn/start', data: { turn: 3 } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await check('a human stop settles the question, and a stopped session is never woken', () => {
    assert.ok(stopRow, 'the second question is delivered')
    assert.equal(stoppedAsk.status, 'stopped')
    assert.equal(stoppedAsk.id, stopId)
    assert.equal(deliveredAfterStop, stopDelivered, 'a stop sends nothing to the stopped session')
    assert.ok(refusedStopped.result?.isError, 'a stopped session is not woken by a new question')
    assert.match(refusedStopped.result.content[0].text, /stopped by a human/)
  })

  const statusWithPolicy = await call('dsh_status', {})
  await check('dsh_status reports the delivery policy this deployment follows', () => {
    assert.equal(statusWithPolicy.busyMode.configured, 'setting')
    assert.equal(statusWithPolicy.busyMode.effective, 'steer', 'the deployment setting is read live')
  })


  // --- per-kind answering -------------------------------------------------------
  // A question is a normal decision; an approval grants a sandbox escalation, so
  // the two can be enabled independently.
  const questionsOnly = await createPluginHarness({ label: 'questions-only', applyOptions: { answerQuestions: true } })
  const approvalsOnly = await createPluginHarness({ label: 'approvals-only', applyOptions: { answerApprovals: true } })
  try {
    const questionStatus = await questionsOnly.call('dsh_status')
    const approvalStatus = await approvalsOnly.call('dsh_status')
    await check('answering questions and answering approvals are independent switches', () => {
      assert.equal(typeof questionsOnly.hooks.get('user-questions/request'), 'function')
      assert.equal(questionsOnly.hooks.get('approval/request'), undefined)
      assert.deepEqual(questionStatus.answering, { approvals: false, questions: true, ownedSessionsOnly: true })
      assert.equal(typeof approvalsOnly.hooks.get('approval/request'), 'function')
      assert.equal(approvalsOnly.hooks.get('user-questions/request'), undefined)
      assert.deepEqual(approvalStatus.answering, { approvals: true, questions: false, ownedSessionsOnly: true })
    })
    const answerPatch = await fetch(approvalsOnly.configUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answerApprovals: false, answerQuestions: true }),
    })
    const answerPatchBody = await answerPatch.json()
    await check('the configuration route accepts the per-kind answering switches', () => {
      assert.equal(answerPatch.status, 200)
      assert.equal(answerPatchBody.answerApprovals, false)
      assert.equal(answerPatchBody.answerQuestions, true)
    })
  } finally {
    await questionsOnly.close()
    await approvalsOnly.close()
  }
  h.finish()
} finally {
  await h.close()
}
