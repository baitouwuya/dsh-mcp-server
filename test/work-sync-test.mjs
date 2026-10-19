/**
 * The work-sync engine, against a fake Harness.
 *
 * The integration suite drives the same engine through the real plugin; this
 * file pins the rules that are easiest to break in isolation: who may be asked,
 * what a notice costs, and the fact that a report never starts another round.
 */
import assert from 'node:assert/strict'
import { createWorkSync } from '../lib/work-sync.js'

const checks = []

/** One engine, one fake Harness, one injectable clock. */
function harness({ rows = [], enabled = true, cooldownMs = 300_000, waitMs = 120_000, maxPeers = 3, steered = false } = {}) {
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
      delivered.push({ target, text: message.text, meta: message.meta })
      // `steered` models the real path for a busy session: the message joins the
      // running turn, so no turn of its own opens and no mark should be left.
      return steered ? { accepted: true, startsTurn: false } : { accepted: true, startsTurn: true }
    },
    readAssistant: (event) => event?.data?.message?.content?.find?.((block) => block.type === 'text')?.text,
    now: () => clock,
  })
  sync.start()
  // A disposed engine is unsubscribed: the fake Harness then has no handler left.
  const fire = (event) => handlers.get('session/event')?.({ id: event.sessionId, header: { id: event.sessionId } }, event)
  return {
    sync,
    delivered,
    logs,
    turn: (sessionId) => fire({ sessionId, type: 'turn/start', data: { turn: 1 } }),
    message: (sessionId, text) => fire({ sessionId, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }),
    end: (sessionId) => fire({ sessionId, type: 'turn/end', data: { reason: { kind: 'completed' } } }),
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
assert.equal(first.delivered[0].meta.sync, true)
checks.push('a root asks the other running root in its workspace, and nobody else')

// A sub-agent never questions peers: it asks its own top-level agent. That is the
// only place its answer can come from, because a root speaks for its subtree.
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

// --- the round trip ---------------------------------------------------------
const loop = harness({ rows: world })
await loop.turn('asker')
await loop.settle()
assert.equal(loop.delivered.length, 1)
// The peer's turn is the turn the notice started: it must not ask back.
await loop.turn('peer')
await loop.settle()
assert.equal(loop.delivered.length, 1, 'the turn a notice caused starts no round')
await loop.message('peer', '我在改 /work/lib/x.js，先做这个')
await loop.settle()
assert.equal(loop.delivered.length, 2, 'the answer comes back to the asker once')
const report = loop.delivered[1]
assert.equal(report.target, 'asker')
assert.equal(report.meta.syncRole, 'report')
assert.equal(report.meta.from, 'peer', 'a report is attributed to the session that sent it')
assert.match(report.text, /\/work\/lib\/x\.js/)
assert.match(report.text, /协商/)
// The asker's own turn, started by that report, must not ask again either.
await loop.turn('asker')
await loop.settle()
assert.equal(loop.delivered.length, 2, 'the report does not start another round')
checks.push('notice, answer and report complete one round without starting another')

// --- the cooldown -----------------------------------------------------------
const cooled = harness({ rows: world })
await cooled.turn('asker')
await cooled.settle()
await cooled.turn('third-party')
await cooled.settle()
assert.equal(cooled.delivered.length, 1, 'the same peer is not asked twice inside the cooldown')
checks.push('a second ask inside the cooldown is suppressed')

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
assert.equal(silent.delivered[1].meta.from, 'peer')
checks.push('a peer that never answers produces one timeout note, not a stream')

// --- status and disposal ----------------------------------------------------
const status = JSON.parse(JSON.stringify(loop.sync.status()))
assert.equal(status.enabled, true)
assert.equal(status.reports >= 1, true)
assert.equal(typeof status.peersAsked.length, 'number')
loop.sync.dispose()
await loop.turn('asker')
await loop.settle()
assert.equal(loop.delivered.length, 2, 'a disposed engine no longer listens')
checks.push('status is lossless JSON and disposal stops the subscription')

// --- a steered notice must not swallow the next real task start ---------------
const steeredWorld = [
  { sessionId: 'asker', running: true, cwd: '/work', updatedAt: 10 },
  { sessionId: 'peer', running: true, cwd: '/work', updatedAt: 20 },
  { sessionId: 'third', running: true, cwd: '/work', updatedAt: 30 },
]
const queued = harness({ rows: steeredWorld, maxPeers: 1 })
await queued.turn('asker')
await queued.settle()
assert.equal(queued.delivered.length, 1, 'the newest peer is the one asked')
const asked = queued.delivered[0].target
assert.equal(asked, 'third')
await queued.turn(asked)
await queued.settle()
assert.equal(queued.delivered.length, 1, 'a queued notice owns the turn it starts')

const steeredRun = harness({ rows: steeredWorld, maxPeers: 1, steered: true })
await steeredRun.turn('asker')
await steeredRun.settle()
assert.equal(steeredRun.delivered.length, 1)
await steeredRun.turn(steeredRun.delivered[0].target)
await steeredRun.settle()
assert.equal(steeredRun.delivered.length, 2, 'a steered notice leaves the next task start to run its own round')
assert.equal(steeredRun.delivered[1].target, 'peer', 'and that round asks the next-newest peer')
checks.push('a steered notice does not swallow the next real task start')

process.stdout.write('\n' + checks.length + ' work-sync checks passed\n')
for (const check of checks) process.stdout.write('ok - ' + check + '\n')