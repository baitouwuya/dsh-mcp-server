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

// --- events mode -------------------------------------------------------------
// A log that carries tool traffic: the folded message view drops these rows,
// which is exactly why a caller may ask for the raw events instead.
const toolEvents = [
  { type: 'permission/preset', seq: 1, data: { preset: 'danger-full-access' } },
  { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] } },
  { type: 'tool/call', seq: 3, time: 1700000003000, data: { name: 'bash', input: { cmd: 'ls' } } },
  { type: 'tool/result', seq: 4, data: { name: 'bash', output: 'a.txt' } },
  { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: 'done' }] } } },
]

function toolReader() {
  const ctx = {
    get(name) {
      if (name !== 'sessionQuery') return undefined
      return {
        async readSession() {
          return { session: { cwd: '/work', agentPreset: 'ptc', createdAt: 1700000000000 }, events: toolEvents }
        },
      }
    },
  }
  return createTranscriptReader({ ctx })
}

const tools = toolReader()
const rawEvents = await tools.readTranscript('session-tools', { mode: 'events', limit: 10 })
assert.ok(Array.isArray(rawEvents.events), 'events mode returns an events array')
assert.deepEqual(rawEvents.events.map((row) => row.type), [
  'permission/preset', 'user/message', 'tool/call', 'tool/result', 'assistant/message',
])
assert.equal(rawEvents.events[2].data.name, 'bash', 'a tool call keeps its payload')
assert.equal(rawEvents.events[2].time, 1700000003000, 'the event timestamp travels with the row')
assert.equal(rawEvents.events[1].time, undefined, 'an event without a time carries none')
assert.equal(rawEvents.totalEvents, 5, 'the response reports the event total')
assert.equal(rawEvents.matchedEvents, 5)
assert.equal('messages' in rawEvents, false, 'events mode does not also fold messages')
checks.push('events mode returns the raw log, tool calls included')

const tailEvents = await tools.readTranscript('session-tools', { mode: 'events', limit: 2 })
assert.deepEqual(tailEvents.events.map((row) => row.seq), [4, 5], 'events mode windows from the tail')
assert.equal(tailEvents.returned, 2)
assert.equal(tailEvents.window.nextAfterSeq, 5)
checks.push('events mode keeps the tail window and reports how much it left out')

const afterEvents = await tools.readTranscript('session-tools', { mode: 'events', afterSeq: 2 })
assert.deepEqual(afterEvents.events.map((row) => row.seq), [3, 4, 5], 'afterSeq pages forward over events')
assert.equal(afterEvents.window.afterSeq, 2)
checks.push('events mode pages forward with a real cursor')

// --- events mode narrows by type before windowing ----------------------------
// A caller that only wants the user's own words must still get them from the
// whole log, not from whatever happened to fall inside the last N rows.
const userOnly = await tools.readTranscript('session-tools', { mode: 'events', types: ['user/message'], limit: 2 })
assert.deepEqual(userOnly.events.map((row) => row.seq), [2], 'types narrows the log itself')
assert.equal(userOnly.matchedEvents, 1, 'matchedEvents counts what the type filter matched')
assert.equal(userOnly.totalEvents, 5, 'totalEvents still reports the whole log')
assert.deepEqual(userOnly.types, ['user/message'])
checks.push('events mode narrows by type before the window is cut')

const toolOnly = await tools.readTranscript('session-tools', { mode: 'events', types: ['tool/call', 'tool/result'] })
assert.deepEqual(toolOnly.events.map((row) => row.type), ['tool/call', 'tool/result'])
assert.equal(toolOnly.matchedEvents, 2)
checks.push('events mode can select the tool traffic alone')

// --- events mode bounds the response, not just the prose --------------------
// A boundary probe: what the budget must actually charge is the serialized
// payload, and one oversized event must still make progress.
function readerFor(events) {
  const ctx = {
    get(name) {
      if (name !== 'sessionQuery') return undefined
      return {
        async readSession() {
          return { session: { cwd: '/work' }, events }
        },
      }
    },
  }
  return createTranscriptReader({ ctx })
}

const heavyEvents = [{
  type: 'assistant/message',
  seq: 1,
  time: 1,
  data: { message: { content: [{ type: 'text', text: 'see image' }, { type: 'image', mediaType: 'image/png', data: 'A'.repeat(2_000_000) }] } },
}]
const heavy = await readerFor(heavyEvents).readTranscript('session-heavy', { mode: 'events', limit: 10 })
assert.equal(heavy.returned, 1, 'a row with a huge payload still comes back')
assert.equal(heavy.events[0].dataOmitted, true, 'the payload is dropped rather than smuggling 2 MB through the budget')
assert.equal(heavy.events[0].dataChars > 1_000_000, true, 'the dropped payload reports its real size')
assert.ok(JSON.stringify(heavy).length < 20_000, 'the whole response stays bounded')
checks.push('events mode budgets the serialized payload, not just the prose')

const hugeOnce = [{ type: 'tool/result', seq: 7, time: 1, data: { output: 'x'.repeat(600_000) } }]
const firstPage = await readerFor(hugeOnce).readTranscript('session-huge', { mode: 'events', limit: 10 })
assert.equal(firstPage.returned, 1, 'an occurrence larger than the budget is not silently skipped')
assert.equal(firstPage.events[0].truncated, true)
assert.equal(firstPage.events[0].chars, 600_000, 'the row reports its uncut length')
assert.equal(firstPage.window.nextAfterSeq, 7, 'the cursor advances past the oversized occurrence')
assert.equal(firstPage.window.reachedEnd, true)
const afterPage = await readerFor(hugeOnce).readTranscript('session-huge', { mode: 'events', afterSeq: 7 })
assert.equal(afterPage.returned, 0)
assert.equal(afterPage.window.reachedEnd, true, 'the caller is told the page was the last one')
checks.push('events mode always advances, so paging cannot stall on one huge event')

const longOutput = [{ type: 'tool/result', seq: 2, time: 1, data: { output: 'y'.repeat(50_000) } }]
const cappedEvent = await readerFor(longOutput).readTranscript('session-long', { mode: 'events', limit: 10, maxChars: 100 })
assert.equal(cappedEvent.events[0].text.length, 100, 'maxChars caps one event row like one message')
assert.equal(cappedEvent.events[0].truncated, true)
assert.equal(cappedEvent.events[0].chars, 50_000)
assert.equal(cappedEvent.events[0].data.output.length, 50_000, 'the payload still travels while it fits the budget')
checks.push('events mode honors maxChars per row')

console.log(`${checks.length} transcript checks passed`)
for (const check of checks) console.log(`ok - ${check}`)
