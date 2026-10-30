#!/usr/bin/env node
/**
 * The two reply forms of the HTTP route.
 *
 * A fast call still answers with a single `application/json` body, byte for
 * byte as before. A call that outlives the grace window answers as an event
 * stream instead: status line and headers immediately, keep-alive comments
 * while the tool runs, then the JSON-RPC response as the closing `message`
 * event. That is what keeps a long `dsh_wait_session` from being killed by a
 * client's own headers timeout — the failure mode is silent, because a held
 * JSON reply sends no bytes at all until the tool returns.
 *
 * The route is exercised directly, without a Harness: a stub gateway stands in
 * for the MCP method table.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createMcpHttpHandler } from '../lib/http-route.js'

const checks = []

/** A stub gateway whose single method sleeps, then answers. */
function gateway(handler) {
  return { handle: handler }
}

/** Mount the real route on a throwaway listener. */
async function serve(handler) {
  const server = createServer(createMcpHttpHandler({
    gateway: handler,
    authorize: () => ({ ok: true }),
    streamAfterMs: 60,
    keepAliveMs: 25,
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` }
}

/** POST one JSON-RPC request and return the raw response. */
async function post(url, message, accept = 'application/json, text/event-stream', signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept },
    body: JSON.stringify(message),
    signal,
  })
  return { response, body: await response.text() }
}

/** The JSON payload carried by an SSE body's last `message` event. */
function streamedPayload(body) {
  const events = body.split('\n\n').filter((chunk) => chunk.trim())
  const messages = events.filter((chunk) => chunk.startsWith('event: message'))
  assert.equal(messages.length, 1, `expected exactly one message event in: ${body}`)
  const data = messages[0].split('\n').filter((line) => line.startsWith('data:'))
  assert.equal(data.length, 1, 'the message event must carry one data line')
  return JSON.parse(data[0].slice('data:'.length).trim())
}

const fast = await serve(gateway(async (message) => ({ jsonrpc: '2.0', id: message.id, result: { fast: true } })))
try {
  const { response, body } = await post(fast.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: {} } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', id: 1, result: { fast: true } })
  checks.push('a fast call keeps the plain application/json reply')
} finally {
  fast.server.close()
}

const slow = await serve(gateway(async (message) => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  return { jsonrpc: '2.0', id: message.id, result: { slow: true } }
}))
try {
  const { response, body } = await post(slow.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.ok(body.startsWith(': open\n\n'), 'the stream opens with a comment so the headers are already on the wire')
  assert.ok(body.includes(': keep-alive\n\n'), 'the stream keeps the connection busy while the tool runs')
  assert.deepEqual(streamedPayload(body), { jsonrpc: '2.0', id: 2, result: { slow: true } })
  checks.push('a slow call streams: open comment, keep-alives, then the response event')

  const jsonOnly = await post(slow.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x', arguments: {} } }, 'application/json')
  assert.match(jsonOnly.response.headers.get('content-type'), /^application\/json/)
  assert.deepEqual(JSON.parse(jsonOnly.body), { jsonrpc: '2.0', id: 3, result: { slow: true } })
  checks.push('a client that only accepts JSON is never streamed to')
} finally {
  slow.server.close()
}

const failing = await serve(gateway(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  throw new Error('stub failure')
}))
try {
  const { body } = await post(failing.url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'x', arguments: {} } })
  const payload = streamedPayload(body)
  assert.equal(payload.id, 4)
  assert.equal(payload.error.code, -32603)
  assert.match(payload.error.message, /stub failure/)
  checks.push('a slow failure closes the stream with a JSON-RPC error event')
} finally {
  failing.server.close()
}

const resilient = await serve(gateway(async (message) => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  return { jsonrpc: '2.0', id: message.id, result: { done: true } }
}))
try {
  await assert.rejects(post(resilient.url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x', arguments: {} } }, 'application/json, text/event-stream', AbortSignal.timeout(100)))
  const { body } = await post(resilient.url, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'x', arguments: {} } }, 'application/json')
  assert.equal(JSON.parse(body).result.done, true)
  checks.push('a caller that hangs up mid-stream leaves the route healthy')
} finally {
  resilient.server.close()
}

for (const check of checks) console.log(`ok - ${check}`)
console.log(`\n${checks.length} streaming transport checks passed`)
