#!/usr/bin/env node
/**
 * Transport-level self-test for the MCP server, with no DSH host involved.
 *
 * It starts a throwaway HTTP server that mounts the exact handler the plugin
 * registers, then exercises the wire contract a real MCP client uses:
 * initialize, tools/list, tools/call, notifications, auth, and method handling.
 *
 * Run: node test/mcp-self-test.mjs
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'

import { createMcpHttpHandler } from '../lib/http-route.js'
import { McpGateway } from '../lib/protocol.js'

const TOKEN = 'self-test-token'

const gateway = new McpGateway({
  serverInfo: { name: 'dsh-mcp-server', version: '0.0.0-test' },
  instructions: 'test instructions',
  listTools: () => [{
    name: 'echo',
    description: 'Echo text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  }],
  callTool: async (name, args) => {
    if (name !== 'echo') throw new Error(`no such tool: ${name}`)
    return { text: `echo:${args.text}`, structuredContent: { echoed: args.text } }
  },
  listResources: () => [{ uri: 'dsh://status', name: 'status' }],
  readResource: async (uri) => ({ text: `resource:${uri}`, mimeType: 'application/json' }),
})

const handler = createMcpHttpHandler({
  gateway,
  authorize: (req, url) => {
    const header = req.headers.authorization ?? ''
    const query = url.searchParams.get('token')
    if (header === `Bearer ${TOKEN}` || query === TOKEN) return { ok: true, peer: 'test' }
    return { ok: false, status: 401, message: 'Unauthorized\n' }
  },
  path: '/mcp',
})

const server = createServer((req, res) => {
  void handler(req, res)
})

/** POST one JSON-RPC message and return `{ status, body }`. */
async function post(message, { token = TOKEN, method = 'POST' } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(message) } : {}),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  return { status: response.status, body }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const checks = []

try {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'self-test', version: '1' } } })
  assert.equal(init.status, 200)
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  assert.equal(init.body.result.serverInfo.name, 'dsh-mcp-server')
  assert.ok(init.body.result.capabilities.tools, 'advertises the tools capability')
  assert.equal(init.body.result.instructions, 'test instructions')
  checks.push('initialize negotiates the requested revision and reports capabilities')

  const unknownVersion = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal(unknownVersion.body.result.protocolVersion, '2025-06-18')
  checks.push('initialize falls back to a supported revision')

  const list = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  assert.equal(list.body.result.tools.length, 1)
  assert.equal(list.body.result.tools[0].name, 'echo')
  checks.push('tools/list projects name, description, and inputSchema')

  const call = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })
  assert.equal(call.body.result.content[0].text, 'echo:hi')
  assert.deepEqual(call.body.result.structuredContent, { echoed: 'hi' })
  checks.push('tools/call returns text plus structuredContent')

  const toolFailure = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'missing', arguments: {} } })
  assert.equal(toolFailure.body.result.isError, true)
  checks.push('an unknown tool fails as a tool result, not a protocol error')

  const resource = await post({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'dsh://status' } })
  assert.equal(resource.body.result.contents[0].text, 'resource:dsh://status')
  checks.push('resources/read returns one contents entry')

  const unknown = await post({ jsonrpc: '2.0', id: 7, method: 'nope/nope', params: {} })
  assert.equal(unknown.body.error.code, -32601)
  checks.push('an unknown method returns JSON-RPC -32601')

  const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(notification.status, 202)
  assert.equal(notification.body, undefined)
  checks.push('a notification is acknowledged with 202 and no body')

  const unauthorized = await post({ jsonrpc: '2.0', id: 8, method: 'ping' }, { token: '' })
  assert.equal(unauthorized.status, 401)
  checks.push('a missing bearer token is rejected with 401')

  const getNotAllowed = await post(undefined, { method: 'GET' })
  assert.equal(getNotAllowed.status, 405)
  checks.push('GET is refused with 405 because this server owns no event stream')

  const badJson = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: '{not json',
  })
  const badBody = JSON.parse(await badJson.text())
  assert.equal(badJson.status, 400)
  assert.equal(badBody.error.code, -32700)
  checks.push('malformed JSON returns -32700')

  for (const check of checks) process.stdout.write(`ok - ${check}\n`)
  process.stdout.write(`\n${checks.length} checks passed\n`)
} finally {
  await new Promise((resolve) => server.close(resolve))
}