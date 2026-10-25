/**
 * The task-start work-sync engine, against a fake Harness.
 *
 * The fake models the two things the real loop does that the engine depends
 * on: it emits `user/message` when the peer actually claims a notice, and it
 * numbers turns. A report is only accepted after that claim — the peer's
 * in-flight step is not an answer.
 */
import assert from 'node:assert/strict'
import { createWorkSync } from '../lib/work-sync.js'

const checks = []

/** One engine, one fake Harness, one injectable clock. */
function harness({ rows = [], enabled = true, cooldownMs = 300_000, waitMs = 120_000, maxPeers = 3, steered = false, defer = null, deliverResult = undefined, guard = null } = {}) {
  const handlers = new Map()
  const delivered = []
  const logs = []
  let clock = 1_000_000
  const ctx = {
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
  }
  const sync = createWorkSync({
    ctx,
    settings: { enabled, cooldownMs, waitMs, maxPeers },
    logger: (level, message, detail) => logs.push({ level, message, detail }),
    listSessions: async () => rows,
    deliver: async (target, message) => {
      // Model the Harness's session-append reentry guard: a delivery made from
      // inside a session/event listener must wait for the commit to close.
      if (typeof guard === 'function' && guard()) {
        throw new Error('session append cannot reenter while another append is being published')
      }
      if (defer) await defer.promise
      delivered.push({ target, text: message.text, meta: message.meta })
      if (deliverResult) return deliverResult(target, message)
      return steered ? { accepted: true, startsTurn: false } : { accepted: true, startsTurn: true }
    },
    readAssistant: (event) => event?.data?.message?.content?.find?.((block) => block.type === 'text')?.text,
    now: () => clock,
  })
  sync.start()
  const fire = (event) => handlers.get('session/event')?.({ id: event.sessionId, header: { id: event.sessionId } }, event)
  return {
    sync,
    delivered,
    logs,
    turn: (sessionId, turn = 1) => fire({ sessionId, type: 'turn/start', data: { turn } }),
    end: (sessionId, turn = 1) => fire({ sessionId, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }),
    message: (sessionId, text, turn = 1, step = 1) => fire({ sessionId, type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text }] } } }),
    claim: (sessionId, asker) => fire({
      sessionId,
      type: 'user/message',
      data: { source: { kind: 'dsh-work-sync', sessionId: asker }, content: [{ type: 'text', text: 'progress sync' }] },
    }),
    advance: (ms) => { clock += ms },
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
  }
}

const ids = (list) => list.map((entry) => entry.target).sort()

// --- who gets asked ---------------------------------------------------------
const world = [
  { sessionId: 'asker', running: true, cwd: '/work', updatedAt: 10 },
  { sessionId: 'peer', running: true, cwd: '/work', updatedAt: 20 },
  { sessionId: 'idle', running: false, cwd: '/work', updatedAt: 30 },
  { sessionId: 'elsewhere', running: true, cwd: '/other', updatedAt: 40 },
  { sessionId: 'child', running: true, cwd: '/work', updatedAt: 50, parentSessionId: 'asker' },
]
const first = harness({ rows: world })
await first.turn('asker')
await first.settle()
assert.deepEqual(ids(first.delivered), ['peer'], 'only the other running root in this workspace is asked')
assert.match(first.delivered[0].text, /进度同步/)
assert.equal(first.delivered[0].meta.from, 'asker', 'the notice carries the asking session')
checks.push('a root asks the other running root in its workspace, and nobody else')

const sub = harness({
  rows: [
    { sessionId: 'root', running: true, cwd: '/work', updatedAt: 10 },
    { sessionId: 'sibling', running: true, cwd: '/work', updatedAt: 20 },
    { sessionId: 'child', running: true, cwd: '/work', updatedAt: 30, parentSessionId: 'root' },
  ],
})
await sub.turn('child')
await sub.settle()
assert.deepEqual(ids(sub.delivered), ['root'], 'a sub-agent asks only its top-level agent')
checks.push('a sub-agent asks its root and nothing else')

// A root that is not working must not be woken by a notice.
const idleRoot = harness({
  rows: [
    { sessionId: 'root', running: false, cwd: '/work', updatedAt: 10 },
    { sessionId: 'child', running: true, cwd: '/work', updatedAt: 30, parentSessionId: 'root' },
  ],
})
await idleRoot.turn('child')
await idleRoot.settle()
assert.deepEqual(ids(idleRoot.delivered), [], 'an idle root is not woken')
checks.push('a sub-agent does not wake an idle root')

// --- the round trip ---------------------------------------------------------
const loop = harness({ rows: world })
await loop.turn('asker')
await loop.settle()
assert.equal(loop.delivered.length, 1)
await loop.turn('peer', 1)
await loop.settle()
assert.equal(loop.delivered.length, 1, 'the turn a notice caused starts no round')
// Before the peer claims the notice, its assistant messages belong to old work.
await loop.message('peer', 'pre-notice work')
await loop.settle()
assert.equal(loop.delivered.length, 1, 'a pre-claim assistant message is not a report')
await loop.claim('peer', 'asker')
await loop.settle()
await loop.message('peer', 'I am editing /work/lib/x.js first', 1, 2)
await loop.settle()
assert.equal(loop.delivered.length, 2, 'the answer comes back to the asker once, after the claim')
const report = loop.delivered[1]
assert.equal(report.target, 'asker')
assert.equal(report.meta.syncRole, 'report')
assert.equal(report.meta.from, 'peer')
assert.match(report.text, /\/work\/lib\/x\.js/)
assert.match(report.text, /协商/)
checks.push('notice, claim, answer and report complete one round without starting another')

// --- a delivery from inside a session commit waits for the commit -----------
{
  let committing = false
  const guarded = harness({ rows: world, guard: () => committing })
  await guarded.turn('asker', 2)
  await guarded.settle()
  await guarded.claim('peer', 'asker')
  await guarded.settle()
  committing = true
  const reportInsideCommit = guarded.message('peer', 'I am editing /work/lib/rowdy.js first', 2, 2)
  // The live loop closes its commit before the listener's next microtask runs.
  committing = false
  await reportInsideCommit
  await guarded.settle()
  assert.equal(guarded.delivered.length, 2, 'the report delivery waited for the commit to close')
  assert.equal(guarded.delivered[1].target, 'asker')
  checks.push('a delivery from inside a session commit waits for the commit to close')
}


// --- a finished asker is not woken ------------------------------------------
// The report can only influence work that is still running: once the asker's
// turn ends, the pair is dropped instead of opening a turn in a session its
// caller believed idle.
const finished = harness({ rows: world })
await finished.turn('asker')
await finished.settle()
assert.equal(finished.delivered.length, 1)
await finished.end('asker', 1)
await finished.settle()
await finished.claim('peer', 'asker')
await finished.settle()
await finished.message('peer', 'I am editing /work/lib/x.js first', 1, 1)
await finished.settle()
assert.deepEqual(ids(finished.delivered), ['peer'], 'an answer is not delivered to an asker whose turn already ended')
assert.deepEqual(finished.sync.status().pending, [], 'the dropped question leaves no pair behind')
checks.push('a report is dropped, not delivered, when the asker\'s turn has already ended')

// The deadline note is the second way an idle session could be woken: a pair
// whose asker finished must not leave a timer behind either.
const quiet = harness({ rows: world, waitMs: 25 })
await quiet.turn('asker')
await quiet.settle()
await quiet.end('asker', 1)
await new Promise((resolve) => setTimeout(resolve, 80))
assert.deepEqual(ids(quiet.delivered), ['peer'], 'a finished asker gets no timeout note')
checks.push('a finished asker is not woken by a timeout note')

// --- the cooldown -----------------------------------------------------------
const cooled = harness({ rows: world })
await cooled.turn('asker', 1)
await cooled.settle()
await cooled.turn('peer', 1)
await cooled.claim('peer', 'asker')
await cooled.settle()
await cooled.message('peer', 'working on /work/a.js', 1, 2)
await cooled.settle()
assert.equal(cooled.delivered.length, 2, 'the first round completes')
await cooled.turn('asker', 2)
await cooled.settle()
assert.equal(cooled.delivered.length, 2, 'the same peer is not asked twice inside the cooldown')
cooled.advance(400_000)
await cooled.turn('asker', 3)
await cooled.settle()
assert.equal(cooled.delivered.length, 3, 'the peer is asked again once the cooldown lapses')
checks.push('a second ask inside the cooldown is suppressed, and asking resumes after it')

// --- the switch -------------------------------------------------------------
const off = harness({ rows: world, enabled: false })
await off.turn('asker')
await off.settle()
assert.equal(off.delivered.length, 0, 'with the switch off nothing is delivered')
assert.equal(off.sync.status().enabled, false)
checks.push('the switch stops every notice')

// --- a peer that never answers ----------------------------------------------
const silent = harness({ rows: world, waitMs: 25 })
await silent.turn('asker')
await new Promise((resolve) => setTimeout(resolve, 80))
assert.equal(silent.delivered.length, 2, 'a silent peer yields exactly one timeout note')
assert.match(silent.delivered[1].text, /仍在处理中/)
checks.push('a peer that never answers produces one timeout note, not a stream')

// --- a peer's current turn ending is not the notice's turn -------------------
const queued = harness({ rows: world })
await queued.turn('asker', 1)
await queued.settle()
await queued.end('peer', 1)
await queued.settle()
assert.equal(queued.delivered.length, 1, 'the running turn ending before the claim is not a no-report note')
await queued.turn('peer', 2)
await queued.claim('peer', 'asker')
await queued.settle()
await queued.message('peer', 'on /work/queued.js', 2, 1)
await queued.settle()
assert.equal(queued.delivered.length, 2, 'the queued notice still gets its report')
checks.push('a pre-claim turn/end does not cancel a queued question')

// --- a steered notice leaves no mark ----------------------------------------
const steeredRun = harness({ rows: world, steered: true })
await steeredRun.turn('asker', 1)
await steeredRun.settle()
assert.equal(steeredRun.delivered.length, 1)
await steeredRun.claim('peer', 'asker')
await steeredRun.settle()
await steeredRun.message('peer', 'answer for the asker', 1, 2)
await steeredRun.settle()
assert.equal(steeredRun.delivered.length, 2, 'the claim turns the next assistant message into the report')
await steeredRun.turn('peer', 2)
await steeredRun.settle()
assert.equal(steeredRun.delivered.length, 3, 'a steered notice does not swallow the next real task start')
assert.equal(steeredRun.delivered[2].target, 'asker', 'the real start runs its own round')
checks.push('a steered notice does not swallow the next task start')

// --- a refusing adapter is not a delivery -----------------------------------
const refused = harness({ rows: world, deliverResult: () => ({ accepted: false }) })
await refused.turn('asker')
await refused.settle()
assert.equal(refused.delivered.length, 1)
assert.equal(refused.sync.status().pending.length, 0, 'a refused delivery leaves no pending question')
assert.equal(refused.sync.status().peersAsked.length, 0, 'and records no question it did not make')
checks.push('an object refusal is treated as a refusal')

// --- the workspace rule is absolute -----------------------------------------
const crossRoot = harness({
  rows: [
    { sessionId: 'a', running: true, cwd: '/work', updatedAt: 10 },
    { sessionId: 'd', running: true, cwd: '/work', updatedAt: 20, parentSessionId: 'r' },
    { sessionId: 'r', running: true, cwd: '/other', updatedAt: 30 },
  ],
})
await crossRoot.turn('a')
await crossRoot.settle()
assert.deepEqual(ids(crossRoot.delivered), [], 'a root is judged by its own workspace, not by its sub-agent s')
checks.push('a root in another workspace is never asked, even through its sub-agent')

const missingParent = harness({
  rows: [{ sessionId: 'child', running: true, cwd: '/work', parentSessionId: 'gone' }],
})
await missingParent.turn('child')
await missingParent.settle()
assert.deepEqual(ids(missingParent.delivered), [], 'a broken lineage asks nobody')
checks.push('a session whose ancestor is missing asks nobody')

const fork = harness({
  rows: [
    { sessionId: 'base', running: true, cwd: '/work', updatedAt: 10 },
    { sessionId: 'fork', running: true, cwd: '/work', updatedAt: 20, parentSessionId: 'base', origin: 'fork' },
  ],
})
await fork.turn('fork')
await fork.settle()
assert.deepEqual(ids(fork.delivered), ['base'], 'a fork is top-level, not a subagent')
checks.push('a fork is treated as a top-level session')

// --- overlapping rounds -----------------------------------------------------
const overlap = harness({ rows: world })
await Promise.all([overlap.turn('asker', 1), overlap.turn('asker', 2)])
await overlap.settle()
assert.equal(overlap.delivered.length, 1, 'two overlapping rounds ask the peer once')
checks.push('overlapping rounds ask one peer once')

// --- status and disposal ----------------------------------------------------
const status = JSON.parse(JSON.stringify(loop.sync.status()))
assert.equal(status.enabled, true)
assert.equal(status.reports >= 1, true)
loop.sync.dispose()
await loop.turn('asker', 4)
await loop.settle()
assert.equal(loop.delivered.length, 2, 'a disposed engine no longer listens')
checks.push('status is lossless JSON and disposal stops the subscription')

// --- a dispose in the middle of a delivery leaves nothing behind ------------
const defer = { promise: undefined, release: undefined }
defer.promise = new Promise((resolve) => { defer.release = resolve })
const racing = harness({ rows: world, defer })
const inFlight = racing.turn('asker')
await new Promise((resolve) => setTimeout(resolve, 10))
racing.sync.dispose()
defer.release()
await inFlight
await racing.settle()
const raced = racing.sync.status()
assert.equal(raced.pending.length, 0, 'a disposed engine keeps no pending question')
assert.equal(raced.peersAsked.length, 0, 'and records no question it did not complete')
checks.push('a dispose during a delivery leaves no state and arms no timer')

process.stdout.write('\n' + checks.length + ' work-sync checks passed\n')
for (const check of checks) process.stdout.write('ok - ' + check + '\n')
