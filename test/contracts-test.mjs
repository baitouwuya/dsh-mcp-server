/**
 * The DeepSeek Harness wire shapes, pinned in one place.
 *
 * The plugin imports no DSH package, so every shape it reads is hand-spelled.
 * These checks pin the reading rules the rest of the plugin relies on: when a
 * Harness release moves a shape, this file is the first place that says so.
 */
import assert from 'node:assert/strict'

import {
  assistantTextOf,
  errorText,
  messageOfEvent,
  sessionIdOf,
  textOfContent,
  turnOfEvent,
} from '../lib/dsh-contracts.js'

const checks = []

// --- session ids -------------------------------------------------------------
assert.equal(sessionIdOf({ id: 'session-a' }), 'session-a', 'a top-level id is the session id')
assert.equal(sessionIdOf({ header: { id: 'session-b' } }), 'session-b', 'the header id is read too')
assert.equal(sessionIdOf({ sessionId: 'session-c' }), 'session-c', 'the older sessionId spelling still works')
assert.equal(sessionIdOf({}), undefined)
assert.equal(sessionIdOf({ header: { id: '' } }), undefined, 'an empty id is not an id')
checks.push('a session id is read from every spelling the Harness has used')

// --- text blocks -------------------------------------------------------------
assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }, { type: 'text', text: 'c' }]), 'ac')
assert.equal(textOfContent(undefined), '')
assert.equal(textOfContent([{ type: 'text', text: '  pad  ' }]), 'pad')
assert.equal(textOfContent([{ type: 'tool_call' }]), '')
checks.push('only text blocks become prose, and the result is trimmed')

// --- assistant prose ---------------------------------------------------------
assert.equal(assistantTextOf({ data: { message: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } } }), 'one\ntwo')
assert.equal(assistantTextOf({ data: { message: { content: [{ type: 'tool_call' }] } } }), undefined, 'a tool-only step says nothing')
assert.equal(assistantTextOf({}), undefined)
checks.push('an assistant message yields its prose, and a tool-only step yields nothing')

// --- transcript rows ---------------------------------------------------------
assert.deepEqual(messageOfEvent({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } }), { role: 'user', text: 'hi' })
assert.equal(messageOfEvent({ type: 'user/message', data: { source: { kind: 'dsh-mcp-server' }, content: [{ type: 'text', text: 'notice' }] } }), undefined, 'injected context is not a user row')
assert.deepEqual(messageOfEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } }), { role: 'assistant', text: 'ok' })
assert.equal(messageOfEvent({ type: 'turn/start', data: {} }), undefined)
checks.push('a transcript row is real user prose or assistant prose, never injected context')

// --- turns -------------------------------------------------------------------
assert.equal(turnOfEvent({ data: { turn: 3 } }), 3)
assert.equal(turnOfEvent({ data: { turn: '4' } }), 4, 'a numeric string is still a turn')
assert.equal(turnOfEvent({ data: {} }), undefined)
assert.equal(turnOfEvent({}), undefined)
checks.push('a turn number is read when the event carries one')

// --- failure text ------------------------------------------------------------
const coded = Object.assign(new Error('boom'), { code: 'ERR_X' })
assert.equal(errorText(coded), 'boom (ERR_X)', 'a string code names the failure kind')
const numericCode = Object.assign(new Error('bad params'), { code: -32602 })
assert.equal(errorText(numericCode), 'bad params (-32602)', 'a numeric code is the MCP error number and is kept')
assert.equal(errorText(new TypeError('wrong type')), 'wrong type (TypeError)', 'a class name other than Error is kept')
assert.equal(errorText(new Error('plain')), 'plain', 'the generic class name adds nothing')
const repeating = Object.assign(new Error('same'), { code: 'same' })
assert.equal(errorText(repeating), 'same', 'a code that repeats the message is not doubled')
assert.equal(errorText('text'), 'text', 'a thrown non-Error still prints')
checks.push('failure text is one line, with a code only when it adds information')

console.log(`${checks.length} contracts checks passed`)
for (const check of checks) console.log(`ok - ${check}`)
