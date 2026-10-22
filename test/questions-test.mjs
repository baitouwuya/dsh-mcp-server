/**
 * The must-reply question broker, against a fake delivery path.
 *
 * What matters here is the protocol: an id per question, the question carried
 * once, reminders that name only the id, an answer that only the addressed
 * session may give, and a wait that outlives a target's turn — without leaving
 * timers or promises behind when the caller gives up.
 */
import assert from 'node:assert/strict'

import { createQuestionBroker } from '../lib/questions.js'

const checks = []

/** Poll until a predicate holds; the broker's timers are real. */
async function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const idOf = (text) => /#(q-[\w-]+)/u.exec(String(text))?.[1]

/** One broker whose delivery and running state the test can drive. */
function harness(options = {}) {
  const delivered = []
  const running = new Set()
  const broker = createQuestionBroker({
    deliver: async (target, text, meta) => {
      delivered.push({ target, text, meta })
      if (typeof options.deliver === 'function') return options.deliver(target, text, meta)
      return { accepted: true, startsTurn: true }
    },
    isRunning: (sessionId) => running.has(sessionId),
    canAnswer: () => options.canAnswer !== false,
    logger: () => {},
    minRemindMs: 15,
    maxRemindMs: 1000,
  })
  return { broker, delivered, running }
}

/** Start one ask and wait until its first message landed. */
async function asking(h, { question = 'WHICH FILE?', remindMs = 1000, timeoutMs = 0, signal, from = { sessionId: 'asker' }, target = 'target' } = {}) {
  const promise = h.broker.ask({ targetSessionId: target, question, from, remindMs, timeoutMs, signal })
  const delivered = await waitFor(() => h.delivered.length >= 1)
  assert.equal(delivered, true, 'the question is delivered')
  return { promise, id: idOf(h.delivered[0].text) }
}

// --- the question carries the id and is delivered exactly once ----------------
{
  const h = harness()
  const { promise, id } = await asking(h, { question: 'WHICH FILE DOES THE FIX TOUCH?' })
  assert.ok(id, 'the question gets an id')
  assert.equal(h.delivered.length, 1, 'the question is delivered once')
  assert.equal(h.delivered[0].target, 'target')
  assert.match(h.delivered[0].text, /WHICH FILE DOES THE FIX TOUCH\?/, 'the first message carries the question')
  assert.match(h.delivered[0].text, new RegExp('#' + id), 'and the id')
  assert.match(h.delivered[0].text, /dsh_answer_question/, 'and how to answer')
  assert.match(h.delivered[0].text, /dsh_get_question/, 'and how to read it again')
  const snapshot = h.broker.get({ id })
  assert.equal(snapshot.state, 'pending')
  assert.equal(snapshot.question, 'WHICH FILE DOES THE FIX TOUCH?')
  assert.equal(snapshot.asker, 'asker')
  h.broker.answer({ id, answer: 'src/a.js', from: { sessionId: 'target' } })
  const result = await promise
  assert.equal(result.status, 'answered')
  assert.equal(result.answer, 'src/a.js')
  assert.equal(result.id, id)
  checks.push('a question is delivered once with an id, and the answer settles it')
}

// --- reminders name the id, never the question -------------------------------
{
  const h = harness()
  const { promise, id } = await asking(h, { remindMs: 15, question: 'A SECRET QUESTION' })
  assert.equal(await waitFor(() => h.delivered.length >= 2), true, 'a reminder is sent')
  const reminder = h.delivered[1]
  assert.match(reminder.text, new RegExp('#' + id), 'the reminder carries the id')
  assert.equal(reminder.text.includes('A SECRET QUESTION'), false, 'the reminder does not repeat the question')
  assert.match(reminder.text, /dsh_get_question/, 'the reminder says how to read it')
  h.broker.answer({ id, answer: 'answered', from: { sessionId: 'target' } })
  await promise
  checks.push('reminders carry the id and do not repeat the question')
}

// --- a running target is not reminded, so reminders cannot pile up -----------
{
  const h = harness()
  h.running.add('target')
  const { promise, id } = await asking(h, { remindMs: 15 })
  await sleep(80)
  assert.equal(h.delivered.length, 1, 'no reminder while the target already runs a turn')
  h.running.delete('target')
  assert.equal(await waitFor(() => h.delivered.length >= 2), true, 'the reminder resumes once it is idle')
  h.broker.answer({ id, answer: 'done', from: { sessionId: 'target' } })
  await promise
  checks.push('a running target is not reminded, and reminders resume when it is idle')
}

// --- only the addressed session may answer ----------------------------------
{
  const h = harness()
  const { promise, id } = await asking(h)
  assert.throws(
    () => h.broker.answer({ id, answer: 'x', from: { sessionId: 'someone-else' } }),
    /Only the addressed session/,
  )
  assert.equal(h.broker.get({ id }).state, 'pending', 'a refused answer leaves the question open')
  h.broker.answer({ id, answer: 'real answer', from: { sessionId: 'target' } })
  await promise
  const again = h.broker.answer({ id, answer: 'second answer', from: { sessionId: 'target' } })
  assert.equal(again.alreadyAnswered, true, 'a repeated answer reports that the first one stands')
  assert.equal(h.broker.get({ id }).answer, 'real answer')
  checks.push('only the addressed session can answer, and the first answer stands')
}

// --- the snapshot keeps the question readable after it settles --------------
{
  const h = harness()
  const { promise, id } = await asking(h, { question: 'WHAT IS THE PLAN?' })
  assert.equal(h.broker.get({ id }).nextReminderMs, 1000, 'a pending snapshot says when the next reminder is due')
  h.broker.answer({ id, answer: 'ship it', from: { sessionId: 'target' } })
  await promise
  const settled = h.broker.get({ id })
  assert.equal(settled.state, 'answered')
  assert.equal(settled.question, 'WHAT IS THE PLAN?')
  assert.equal(settled.answer, 'ship it')
  assert.match(settled.answeredAt, /^\d{4}-\d{2}-\d{2}T/)
  checks.push('a settled question still reports its text and answer by id')
}

// --- a deadline withdraws the request and tells the target ------------------
{
  const h = harness()
  // The deadline timer is unref'd on purpose, so keep the test loop alive long
  // enough for it to fire — a real Harness process always is.
  const deadline = h.broker.ask({
    targetSessionId: 'target',
    question: 'NOBODY WILL ANSWER',
    from: { sessionId: 'asker' },
    remindMs: 1000,
    timeoutMs: 25,
  })
  await sleep(40)
  const result = await deadline
  assert.equal(result.status, 'timedOut')
  assert.equal(result.id.startsWith('q-'), true)
  assert.equal(await waitFor(() => h.delivered.some((entry) => /撤回/.test(entry.text))), true, 'the target is told the question was withdrawn')
  assert.equal(h.broker.status().pending, 0)
  checks.push('a deadline returns timedOut and withdraws the question')
}

// --- an aborted caller withdraws it too -------------------------------------
{
  const h = harness()
  const controller = new AbortController()
  const { promise, id } = await asking(h, { signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, /cancelled/)
  assert.equal(await waitFor(() => h.delivered.some((entry) => /撤回/.test(entry.text))), true, 'the target is told about the abort')
  assert.equal(h.broker.status().pending, 0)
  assert.equal(h.broker.get({ id }).state, 'cancelled')
  checks.push('an aborted caller rejects and withdraws the question')
}

// --- asking yourself, a deadlock, and a missing answer path are refused -----
{
  const h = harness()
  await assert.rejects(h.broker.ask({ targetSessionId: 'same', question: 'q', from: { sessionId: 'same' } }), /cannot ask itself/)
  const first = h.broker.ask({ targetSessionId: 'b', question: 'first', from: { sessionId: 'a' }, remindMs: 1000 })
  await waitFor(() => h.delivered.length === 1)
  await assert.rejects(h.broker.ask({ targetSessionId: 'a', question: 'second', from: { sessionId: 'b' } }), /deadlock/)
  h.broker.answer({ id: idOf(h.delivered[0].text), answer: 'ok', from: { sessionId: 'b' } })
  await first
  const noAnswerPath = harness({ canAnswer: false })
  await assert.rejects(noAnswerPath.broker.ask({ targetSessionId: 'target', question: 'q' }), /local DSH tool surface is off/)
  checks.push('self-asks, deadlocks and a missing answer path are refused before delivery')
}

// --- blank input is refused -------------------------------------------------
{
  const h = harness()
  await assert.rejects(h.broker.ask({ question: 'q' }), /"sessionId" is required/)
  await assert.rejects(h.broker.ask({ targetSessionId: 'target', question: '   ' }), /"question" must not be empty/)
  await assert.rejects(h.broker.ask({ targetSessionId: 'target', question: 'x'.repeat(33 * 1024) }), /longer than/)
  assert.throws(() => h.broker.answer({ id: 'q-unknown', answer: 'x', from: { sessionId: 'target' } }), /No must-reply question/)
  assert.throws(() => h.broker.get({ id: '' }), /"id" is required/)
  checks.push('blank and oversized input is refused')
}

// --- a refused delivery rejects instead of hanging -------------------------
{
  const h = harness({ deliver: () => false })
  await assert.rejects(
    h.broker.ask({ targetSessionId: 'target', question: 'anyone?', from: { sessionId: 'asker' } }),
    /could not be delivered/,
  )
  assert.equal(h.broker.status().pending, 0, 'a question that never landed is not kept')
  checks.push('a refused delivery rejects and leaves nothing pending')
}

// --- a vanished target stops the wait instead of hanging forever -----------
{
  let calls = 0
  const h = harness({
    deliver: () => {
      calls += 1
      return calls === 1 ? { accepted: true, startsTurn: true } : false
    },
  })
  // The reminder interval is unref'd, so keep the loop alive while it fires.
  const asking = h.broker.ask({
    targetSessionId: 'target',
    question: 'ANYONE THERE?',
    from: { sessionId: 'asker' },
    remindMs: 15,
  }).then((value) => ({ value }), (error) => ({ error }))
  await sleep(200)
  const outcome = await asking
  assert.match(String(outcome.error && outcome.error.message), /after 5 reminders/)
  assert.equal(h.broker.status().pending, 0, 'an unreachable target leaves nothing pending')
  checks.push('a target that disappears fails the wait instead of holding it forever')
}

// --- disposal releases every waiting caller ---------------------------------
{
  const h = harness()
  const { promise, id } = await asking(h, { remindMs: 15 })
  h.broker.dispose()
  await assert.rejects(promise, /stopped before the target answered/)
  assert.equal(h.broker.status().pending, 0)
  assert.equal(h.broker.status().settled, 0, 'disposal forgets the table as well')
  assert.equal(h.delivered.length, 1, 'disposal sends no withdrawal the caller cannot use')
  // Answering a question from a disposed broker is an error, not a crash.
  assert.throws(() => h.broker.answer({ id, answer: 'late', from: { sessionId: 'target' } }), /stopping/)
  checks.push('disposal releases every waiting caller and clears the table')
}

process.stdout.write('\n' + checks.length + ' question checks passed\n')
for (const check of checks) process.stdout.write('ok - ' + check + '\n')
