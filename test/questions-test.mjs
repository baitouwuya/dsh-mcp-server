/**
 * The must-reply question broker, against a fake delivery path.
 *
 * What matters here is the protocol: an id per question, the question carried
 * once, reminders that name only the id and ride the target's own model calls
 * instead of waking it, an answer only the addressed session may give, and a
 * wait that a person's stop or the caller's cancellation can end cleanly.
 */
import assert from 'node:assert/strict'

import { createQuestionBroker } from '../lib/questions.js'

const checks = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const idOf = (text) => /#(q-[\w-]+)/u.exec(String(text))?.[1]

/** One broker whose delivery, stopped set and clock the test can drive. */
function harness(options = {}) {
  const delivered = []
  const stopped = new Set(options.stopped ?? [])
  let clock = 1_000_000
  const broker = createQuestionBroker({
    deliver: async (target, text, meta) => {
      delivered.push({ target, text, meta })
      if (typeof options.deliver === 'function') return options.deliver(target, text, meta)
      return { accepted: true, startsTurn: meta?.inject !== true }
    },
    isStopped: (sessionId) => stopped.has(sessionId),
    canAnswer: () => options.canAnswer !== false,
    logger: () => {},
    now: () => clock,
    activityDedupeMs: 1000,
  })
  return { broker, delivered, stopped, advance: (ms) => { clock += ms } }
}

/** Start one ask and wait until its first message landed. */
async function asking(h, { question = 'WHICH FILE?', timeoutMs = 0, signal, from = { sessionId: 'asker' }, target = 'target' } = {}) {
  const promise = h.broker.ask({ targetSessionId: target, question, from, timeoutMs, signal })
  await sleep(5)
  assert.equal(h.delivered.length, 1, 'the question is delivered')
  return { promise, id: idOf(h.delivered[0].text) }
}

// --- the question carries the id and is delivered exactly once ----------------
{
  const h = harness()
  const { promise, id } = await asking(h, { question: 'WHICH FILE DOES THE FIX TOUCH?' })
  assert.ok(id, 'the question gets an id')
  assert.equal(h.delivered.length, 1, 'the question is delivered once')
  assert.equal(h.delivered[0].target, 'target')
  assert.equal(h.delivered[0].meta.inject, undefined, 'the question itself is a normal delivery')
  assert.match(h.delivered[0].text, /WHICH FILE DOES THE FIX TOUCH\?/, 'the first message carries the question')
  assert.match(h.delivered[0].text, new RegExp('#' + id), 'and the id')
  assert.match(h.delivered[0].text, /dsh_answer_question/, 'and how to answer')
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

// --- a reminder rides an activity event and names only the id ----------------
{
  const h = harness()
  const { promise, id } = await asking(h, { question: 'A SECRET QUESTION' })
  await sleep(30)
  assert.equal(h.delivered.length, 1, 'no timer pushes a reminder by itself')
  await h.broker.onActivity('target', 'turn/start')
  assert.equal(h.delivered.length, 2, 'an activity event injects a reminder')
  const status = h.broker.status()
  assert.equal(status.activity.calls >= 1, true, 'activity calls are counted')
  assert.equal(status.activity.injections, 1, 'accepted injections are counted')
  assert.equal(status.activity.byKind['turn/start'], 1, 'the event kind is reported')
  const reminder = h.delivered[1]
  assert.equal(reminder.meta.inject, true, 'the reminder is injected, not turned into a turn')
  assert.match(reminder.text, new RegExp('#' + id), 'the reminder carries the id')
  assert.equal(reminder.text.includes('A SECRET QUESTION'), false, 'the reminder does not repeat the question')
  assert.match(reminder.text, /dsh_get_question/, 'the reminder says how to read it')
  assert.equal(h.broker.get({ id }).reminders, 1, 'the injection is counted')
  h.broker.answer({ id, answer: 'answered', from: { sessionId: 'target' } })
  await promise
  checks.push('reminders are injected on activity and carry only the id')
}

// --- a turn start and its first step produce one reminder -------------------
{
  const h = harness()
  const { promise, id } = await asking(h)
  await h.broker.onActivity('target')
  await h.broker.onActivity('target')
  assert.equal(h.delivered.length, 2, 'two events in one call window inject once')
  h.advance(1001)
  await h.broker.onActivity('target')
  assert.equal(h.delivered.length, 3, 'a later call gets its own reminder')
  assert.equal(h.broker.get({ id }).reminders, 2)
  h.broker.answer({ id, answer: 'done', from: { sessionId: 'target' } })
  await promise
  checks.push('turn-start and step-start share one reminder, later steps get another')
}

// --- a reminder waits until the question itself has landed ------------------
{
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const h = harness({
    deliver: async () => { calls += 1; if (calls === 1) await gate; return { accepted: true } },
  })
  const promise = h.broker.ask({ targetSessionId: 'target', question: 'SLOW TO LAND', from: { sessionId: 'asker' } })
  await sleep(10)
  assert.equal(h.delivered.length, 1, 'the initial delivery is in flight')
  await h.broker.onActivity('target', 'turn/start')
  assert.equal(h.delivered.length, 1, 'no reminder rides a call before the question landed')
  release()
  await sleep(10)
  assert.equal(h.delivered.length, 2, 'the deferred reminder is injected as soon as the question lands')
  await h.broker.onActivity('target', 'step/start')
  assert.equal(h.delivered.length, 2, 'and the dedupe window absorbs the next event')
  const id = idOf(h.delivered[0].text)
  h.broker.answer({ id, answer: 'ok', from: { sessionId: 'target' } })
  await promise
  checks.push('a reminder cannot overtake the question it belongs to')
}

// --- concurrent activity injects a reminder once ---------------------------
{
  const h = harness()
  const { promise, id } = await asking(h)
  await Promise.all([h.broker.onActivity('target'), h.broker.onActivity('target')])
  assert.equal(h.delivered.length, 2, 'two overlapping activity events inject one reminder')
  assert.equal(h.broker.get({ id }).reminders, 1)
  h.broker.answer({ id, answer: 'ok', from: { sessionId: 'target' } })
  await promise
  checks.push('overlapping activity events cannot duplicate a reminder')
}

// --- a stopped target is never injected or woken ----------------------------
{
  const h = harness({ stopped: ['target'] })
  await assert.rejects(
    h.broker.ask({ targetSessionId: 'target', question: 'anyone?', from: { sessionId: 'asker' } }),
    /stopped by a human/,
  )
  assert.equal(h.delivered.length, 0, 'a stopped target receives nothing')
  checks.push('asking a session a person stopped is refused before delivery')
}

// --- a stop settles the question and nothing is sent to the target ----------
{
  const h = harness()
  const { promise, id } = await asking(h, { question: 'WHAT IS THE PLAN?' })
  await h.broker.onActivity('target')
  h.stopped.add('target')
  h.broker.onStopped('target')
  const result = await promise
  assert.equal(result.status, 'stopped')
  assert.equal(result.id, id)
  assert.match(result.note, /stopped by a human/)
  assert.equal(h.delivered.length, 2, 'the stop adds no message to the target')
  assert.equal(h.broker.get({ id }).state, 'stopped')
  assert.equal(h.broker.status().pending, 0)
  await h.broker.onActivity('target')
  assert.equal(h.delivered.length, 2, 'a stopped target is not reminded later either')
  checks.push('a human stop settles the question without waking the target')
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

// --- a settled question still reports its text and answer by id -------------
{
  const h = harness()
  const { promise, id } = await asking(h, { question: 'WHAT IS THE PLAN?' })
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
  const deadline = h.broker.ask({
    targetSessionId: 'target',
    question: 'NOBODY WILL ANSWER',
    from: { sessionId: 'asker' },
    timeoutMs: 25,
  })
  await sleep(40)
  const result = await deadline
  assert.equal(result.status, 'timedOut')
  assert.equal(result.id.startsWith('q-'), true)
  await sleep(10)
  assert.equal(h.delivered.some((entry) => /撤回/.test(entry.text)), true, 'the target is told the question was withdrawn')
  assert.equal(h.broker.status().pending, 0)
  checks.push('a deadline returns timedOut and withdraws the question')
}

// --- an aborted caller withdraws it too -------------------------------------
{
  const h = harness()
  const controller = new AbortController()
  const { promise } = await asking(h, { signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, /cancelled/)
  await sleep(10)
  assert.equal(h.delivered.some((entry) => /撤回/.test(entry.text)), true, 'the target is told about the abort')
  assert.equal(h.broker.status().pending, 0)
  checks.push('an aborted caller rejects and withdraws the question')
}

// --- asking yourself, a deadlock, and a missing answer path are refused -----
{
  const h = harness()
  await assert.rejects(h.broker.ask({ targetSessionId: 'same', question: 'q', from: { sessionId: 'same' } }), /cannot ask itself/)
  const first = h.broker.ask({ targetSessionId: 'b', question: 'first', from: { sessionId: 'a' } })
  await sleep(5)
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

// --- a failed injection is not counted and does not fail the question ------
{
  let calls = 0
  const h = harness({
    deliver: () => {
      calls += 1
      if (calls === 1) return { accepted: true }
      if (calls === 2) return false
      return { accepted: true }
    },
  })
  const { promise, id } = await asking(h)
  await h.broker.onActivity('target', 'assistant/message')
  assert.equal(h.broker.get({ id }).reminders, 0, 'an injection that the target refused is not counted')
  assert.equal(h.broker.get({ id }).state, 'pending', 'and the question stays open')
  const failed = h.broker.status().activity
  assert.equal(failed.failures >= 1, true, 'the refused injection is counted as a failure')
  assert.equal(failed.lastFailure, 'refused', 'and the reason is reported')
  h.advance(1001)
  await h.broker.onActivity('target', 'step/start')
  assert.equal(h.broker.get({ id }).reminders, 1, 'the next activity event retries successfully')
  h.broker.answer({ id, answer: 'late', from: { sessionId: 'target' } })
  await promise
  checks.push('a refused injection is counted, explained, and retried on the next call')
}

// --- disposal releases every waiting caller --------------------------------
{
  const h = harness()
  const { promise, id } = await asking(h)
  h.broker.dispose()
  await assert.rejects(promise, /stopped before the target answered/)
  assert.equal(h.broker.status().pending, 0)
  assert.equal(h.broker.status().settled, 0, 'disposal forgets the table as well')
  assert.equal(h.delivered.length, 1, 'disposal sends no withdrawal the caller cannot use')
  assert.throws(() => h.broker.answer({ id, answer: 'late', from: { sessionId: 'target' } }), /stopping/)
  checks.push('disposal releases every waiting caller and clears the table')
}

process.stdout.write('\n' + checks.length + ' question checks passed\n')
for (const check of checks) process.stdout.write('ok - ' + check + '\n')
