/**
 * The turn boundary a queued prompt waits for.
 *
 * A prompt sent to a busy session with `mode: "queue"` is consumed by the
 * *next* turn; the turn that was already running when it arrived is not its
 * answer, and must not be reported as one.
 */
import assert from 'node:assert/strict'

import { createDshCapabilities } from '../lib/dsh-capabilities.js'

const checks = []

const twoTurns = [
  { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'old turn text' }] } } },
  { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4, data: { turn: 2 } },
  { type: 'assistant/message', seq: 5, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'queued answer' }] } } },
  { type: 'turn/end', seq: 6, data: { turn: 2, reason: { kind: 'completed' } } },
]

/** A Harness whose one session is busy and follows the supplied frames. */
function harness(frames = twoTurns.map((event) => ({ type: 'event', event }))) {
  const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }]
  const services = {
    agents: { get: () => ({ status: 'running', steer() {}, followup() {} }) },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 's1', running: true, cwd: '/tmp' }] }),
      prompt: async () => {},
      follow: () => (async function* stream() {
        for (const frame of frames) yield frame
      })(),
    },
    sessionQuery: { readSession: async () => ({ events, session: { cwd: '/tmp' } }) },
    workspaceRegistry: { archivedSessionIds: () => [] },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  }
  const ctx = { get: (name) => services[name], on: () => () => {}, logger: () => ({ info() {}, warn() {}, debug() {} }) }
  return createDshCapabilities(ctx, {})
}

const queued = await harness().callTool('dsh_continue_session', {
  sessionId: 's1',
  prompt: 'queued prompt',
  mode: 'queue',
  wait: true,
  timeoutMs: 5000,
}, {})
assert.equal(queued.structuredContent.status, 'completed')
assert.match(queued.structuredContent.text, /queued answer/, 'the queued prompt reports the turn that consumed it')
assert.doesNotMatch(queued.structuredContent.text, /old turn text/, 'the turn that was already running is not reported as its answer')
checks.push('a queued prompt waits for the turn that consumes it')

const steered = await harness().callTool('dsh_continue_session', {
  sessionId: 's1',
  prompt: 'steered prompt',
  mode: 'steer',
  wait: true,
  timeoutMs: 5000,
}, {})
assert.equal(steered.structuredContent.status, 'completed')
assert.match(steered.structuredContent.text, /old turn text/, 'a steered prompt reports the turn it joined')
checks.push('a steered prompt still reports the turn it joined')

const snapshot = [{ type: 'snapshot', records: twoTurns.map((event) => ({ type: 'event', event })) }]
const snapshotQueued = await harness(snapshot).callTool('dsh_continue_session', {
  sessionId: 's1', prompt: 'queued prompt', mode: 'queue', wait: true, timeoutMs: 5000,
}, {})
assert.equal(snapshotQueued.structuredContent.status, 'completed')
assert.match(snapshotQueued.structuredContent.text, /queued answer/)
assert.doesNotMatch(snapshotQueued.structuredContent.text, /old turn text/)
checks.push('a snapshot respects the queued turn boundary')

const errorSnapshot = [{ type: 'snapshot', records: [
  { type: 'event', event: { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'error' } } } },
] }]
const snapshotWait = await harness(errorSnapshot).callTool('dsh_wait_session', { sessionId: 's1', timeoutMs: 5000 }, {})
assert.equal(snapshotWait.structuredContent.status, 'error')
checks.push('a turn end already in the snapshot retains its error status')

await assert.rejects(
  harness([]).callTool('dsh_wait_session', { sessionId: 's1', timeoutMs: 5000 }, {}),
  /ended before a turn\/end event/,
)
checks.push('a stream that closes before turn end reports an error')

process.stdout.write('\n' + checks.length + ' turn-wait checks passed\n')
for (const check of checks) process.stdout.write('ok - ' + check + '\n')
