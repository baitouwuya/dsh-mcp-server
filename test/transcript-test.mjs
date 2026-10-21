/**
 * The transcript reader, against a fake durable log.
 *
 * A read is a window over a log the Harness owns, so the arithmetic matters
 * more than the wiring: which rows a mode returns, what the cursor promises,
 * and what a response admits it left out. These checks pin exactly that.
 */
import assert from 'node:assert/strict'

import { DEFAULT_MESSAGE_CHARS } from '../lib/transcript.js'
import { createTranscriptReader } from '../lib/transcript.js'

const checks = []

/** The durable events one session's log carries. */
const events = [
  { type: 'permission/preset', seq: 1, data: { preset: 'danger-full-access' } },
  { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello there' }] } },
  { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'first answer' }] } } },
  // Injected context is not a transcript row, even though it is a user message.
  { type: 'user/message', seq: 4, data: { source: { kind: 'dsh-work-sync' }, content: [{ type: 'text', text: 'notice' }] } },
  { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: 'a much longer second answer' }] } } },
]

/** One reader over that log. */
function reader({ fail = false, pending, owner } = {}) {
  const ctx = {
    get(name) {
      if (name !== 'sessionQuery') return undefined
      return {
        async readSession() {
          if (fail) throw new Error('boom')
          return { session: { cwd: '/work', agentPreset: 'ptc', createdAt: 1700000000000 }, events }
        },
      }
    },
  }
  return createTranscriptReader({
    ctx,
    ownerOf: () => owner,
    pendingOf: () => pending,
  })
}

const standard = reader({ owner: { id: 'client-a' } })

// --- the raw read ------------------------------------------------------------
const raw = await standard.sessionMessages('session-1')
assert.deepEqual(raw.messages.map((row) => row.seq), [2, 3, 5], 'only real user and assistant prose is a row')
assert.equal(raw.permissionPreset, 'danger-full-access', 'the last durable preset is reported')
assert.equal(raw.snapshot.session.cwd, '/work')
checks.push('a raw read keeps real prose rows and the last permission preset')

// --- windows -----------------------------------------------------------------
const tail = await standard.readTranscript('session-1', { mode: 'tail', limit: 2 })
assert.deepEqual(tail.messages.map((row) => row.seq), [3, 5], 'tail keeps the newest rows in order')
assert.equal(tail.window.reachedEnd, true)
const head = await standard.readTranscript('session-1', { mode: 'head', limit: 2 })
assert.deepEqual(head.messages.map((row) => row.seq), [2, 3], 'head keeps the oldest rows')
checks.push('tail and head windows keep the requested end of the log')

// --- roles and cursors -------------------------------------------------------
const users = await standard.readTranscript('session-1', { roles: ['user'] })
assert.deepEqual(users.messages.map((row) => row.seq), [2])
assert.deepEqual(users.roles, ['user'])
const after = await standard.readTranscript('session-1', { afterSeq: 2 })
assert.deepEqual(after.messages.map((row) => row.seq), [3, 5], 'afterSeq pages forward from a cursor')
assert.equal(after.window.afterSeq, 2)
assert.equal(after.window.nextAfterSeq, 5)
assert.equal(after.window.firstSeq, 3)
checks.push('roles narrow by role and afterSeq pages forward with a real cursor')

// --- caps and the budget -----------------------------------------------------
const capped = await standard.readTranscript('session-1', { maxChars: 5 })
const cappedRow = capped.messages.find((row) => row.seq === 5)
assert.equal(cappedRow.text, 'a muc')
assert.equal(cappedRow.truncated, true)
assert.equal(cappedRow.chars, 'a much longer second answer'.length)
assert.equal(capped.truncatedMessages, 3, 'every over-long message is counted')
assert.match(capped.note, /5 characters/)
const budgeted = await standard.readTranscript('session-1', { maxChars: 0, maxTotalChars: 10 })
assert.equal(budgeted.truncatedByBudget, true, 'a response budget stops the read and says so')
assert.match(budgeted.note, /Stopped at 10 characters/)
assert.equal(DEFAULT_MESSAGE_CHARS, 2000)
checks.push('a per-message cap and a response budget both truncate and both admit it')

// --- outline -----------------------------------------------------------------
const outline = await standard.readTranscript('session-1', { mode: 'outline' })
assert.equal(outline.mode, 'outline')
const outlineRow = outline.messages.find((row) => row.seq === 2)
assert.equal(outlineRow.preview, 'hello there')
assert.equal(outlineRow.chars, 'hello there'.length)
assert.equal('text' in outlineRow, false, 'an outline row carries a preview, not the message')
checks.push('outline mode returns a table-of-contents row instead of the text')

// --- metadata ----------------------------------------------------------------
assert.deepEqual(tail.owner, { id: 'client-a' })
assert.equal(tail.cwd, '/work')
assert.equal(tail.agentPreset, 'ptc')
assert.equal(tail.createdAt, new Date(1700000000000).toISOString())
const withPending = await reader({ pending: { count: 2, approvals: 1, questions: 1 } }).readTranscript('session-1', { limit: 1 })
assert.equal(withPending.pending.count, 2, 'unanswered decisions travel with the read')
checks.push('owner, workspace, preset and pending decisions travel with the read')

// --- failure -----------------------------------------------------------------
const broken = reader({ fail: true })
await assert.rejects(() => broken.readTranscript('session-missing'), (error) => {
  assert.equal(error.code, -32602)
  assert.match(String(error.message), /could not be read/)
  return true
})
checks.push('an unreadable session is invalid params, not an internal error')

console.log(`${checks.length} transcript checks passed`)
for (const check of checks) console.log(`ok - ${check}`)
