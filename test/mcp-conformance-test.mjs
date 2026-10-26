#!/usr/bin/env node
/**
 * Protocol-conformance test for the MCP endpoint the plugin actually mounts.
 *
 * It loads `apply()` with the smallest Cordis context the plugin needs, mounts
 * the route it registers on a throwaway HTTP server, and drives the wire
 * contract a real MCP client relies on: revision negotiation, capabilities,
 * tools and resources, method dispatch, malformed envelopes, errors,
 * authentication, and the stateless session header.
 *
 * No DSH host is involved and no other test file is imported.
 * Run: node test/mcp-conformance-test.mjs
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const TOKEN = 'conformance-token'

/** Every revision lib/protocol.js says it can speak. */
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
/** The revision the server advertises when the client names an unknown one. */
const FALLBACK_VERSION = '2025-06-18'

const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-conformance-'))
const routes = []
const disposers = []

/** Minimal fake Cordis context: the web carrier the route mounts on. */
const services = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
}
const ctx = {
  ...services,
  get: (name) => services[name],
  on: () => () => {},
  logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
  effect: (create) => {
    const dispose = create()
    disposers.push(dispose)
    return dispose
  },
}

apply(ctx, {
  token: TOKEN,
  // The protocol surface is what this test measures; publishing files and the
  // local DSH front door would only add side effects.
  writeEndpointFile: false,
  exposeToDsh: false,
  exposeToDshPage: false,
  dshHome: dir,
  url: 'http://127.0.0.1:9',
})

const route = routes.find((entry) => entry.path === '/mcp')
assert.ok(route, 'apply() registered the /mcp route')
assert.equal(route.kind, 'exact', 'the MCP route is exact')

const server = createServer((req, res) => {
  void route.handler(req, res)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const endpoint = `http://127.0.0.1:${server.address().port}/mcp`

/** POST a raw body and decode whatever comes back. */
async function postRaw(body, { headers = {}, token = TOKEN } = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed, headers: response.headers }
}

/** POST one JSON-RPC message. */
function rpc(message, options = {}) {
  return postRaw(JSON.stringify(message), options)
}

/** Send one JSON-RPC notification (no id). */
function notify(method, params) {
  return rpc({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
}

const checks = []
try {
  // --- initialize -------------------------------------------------------------
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conformance', version: '1' } },
  })
  assert.equal(init.status, 200)
  assert.equal(init.body.jsonrpc, '2.0')
  assert.equal(init.body.id, 1)
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  assert.equal(init.body.result.serverInfo.name, 'dsh-mcp-server')
  assert.equal(init.body.result.serverInfo.title, 'DeepSeek Harness MCP Server')
  assert.equal(typeof init.body.result.serverInfo.version, 'string')
  assert.ok(init.body.result.serverInfo.version.length > 0, 'serverInfo carries a version')
  assert.ok(init.body.result.capabilities.tools, 'advertises tools')
  assert.equal(init.body.result.capabilities.tools.listChanged, false)
  assert.ok(init.body.result.capabilities.resources, 'advertises resources')
  assert.equal(init.body.result.capabilities.resources.subscribe, false)
  assert.equal(init.body.result.capabilities.resources.listChanged, false)
  assert.deepEqual(init.body.result.capabilities.logging, {})
  assert.equal(init.body.result.capabilities.prompts, undefined, 'prompts are not advertised')
  assert.equal(typeof init.body.result.instructions, 'string')
  assert.ok(init.body.result.instructions.trim().length > 0, 'instructions are published')
  checks.push('initialize negotiates 2025-06-18 and reports serverInfo, capabilities, instructions')

  for (const version of SUPPORTED_VERSIONS) {
    const negotiated = await rpc({ jsonrpc: '2.0', id: `v-${version}`, method: 'initialize', params: { protocolVersion: version } })
    assert.equal(negotiated.body.result.protocolVersion, version, `${version} must be echoed`)
  }
  checks.push('every supported protocol revision is echoed back to the client')

  for (const params of [{ protocolVersion: '1999-01-01' }, {}]) {
    const fallback = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params })
    assert.equal(fallback.body.result.protocolVersion, FALLBACK_VERSION)
  }
  checks.push('an unknown or absent protocol revision falls back to 2025-06-18')

  // --- notifications and ping -------------------------------------------------
  const initialized = await notify('notifications/initialized')
  assert.equal(initialized.status, 202)
  assert.equal(initialized.body, undefined, 'a notification has no response body')
  checks.push('notifications/initialized is accepted with 202 and no body')

  const ping = await rpc({ jsonrpc: '2.0', id: 3, method: 'ping', params: {} })
  assert.equal(ping.status, 200)
  assert.deepEqual(ping.body.result, {})
  checks.push('ping returns an empty result')

  // --- tools ------------------------------------------------------------------
  const toolList = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
  assert.equal(toolList.status, 200)
  const toolNames = toolList.body.result.tools.map((tool) => tool.name)
  assert.equal(toolNames.length, 21, `tools/list must return exactly 21 tools, got ${toolNames.length}`)
  assert.equal(new Set(toolNames).size, 21, 'tool names are unique')
  for (const tool of toolList.body.result.tools) {
    assert.equal(typeof tool.name, 'string')
    assert.match(tool.name, /^dsh_/, 'every published MCP tool is a dsh_* tool')
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `${tool.name} carries an inputSchema`)
  }
  assert.ok(toolNames.includes('dsh_run_prompt'))
  assert.ok(toolNames.includes('dsh_mcp_call') === false, 'the local front door is not an MCP tool')
  checks.push('tools/list returns exactly 21 well-formed dsh_* tool definitions')

  const unknownTool = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'no_such_tool', arguments: {} },
  })
  assert.equal(unknownTool.status, 200)
  assert.equal(unknownTool.body.error.code, -32602)
  assert.match(unknownTool.body.error.message, /Unknown tool/)
  checks.push('tools/call with an unknown tool is -32602 invalid params')

  for (const params of [{}, { name: 'dsh_status', arguments: 'not-an-object' }]) {
    const badParams = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params })
    assert.equal(badParams.body.error.code, -32602)
  }
  checks.push('tools/call rejects a missing name or non-object arguments with -32602')

  // --- resources --------------------------------------------------------------
  const resourceList = await rpc({ jsonrpc: '2.0', id: 7, method: 'resources/list', params: {} })
  const resourceUris = resourceList.body.result.resources.map((resource) => resource.uri)
  assert.deepEqual(resourceUris.sort(), ['dsh://sessions', 'dsh://status'])
  assert.ok(resourceList.body.result.resources.every((resource) => typeof resource.name === 'string'))
  checks.push('resources/list returns the two static dsh:// resources')

  const templateList = await rpc({ jsonrpc: '2.0', id: 8, method: 'resources/templates/list', params: {} })
  const templates = templateList.body.result.resourceTemplates
  assert.equal(templates.length, 1)
  assert.equal(templates[0].uriTemplate, 'dsh://session/{sessionId}')
  checks.push('resources/templates/list returns the one session-transcript template')

  const statusRead = await rpc({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'dsh://status' } })
  assert.equal(statusRead.status, 200)
  assert.equal(statusRead.body.result.contents.length, 1)
  assert.equal(statusRead.body.result.contents[0].uri, 'dsh://status')
  assert.equal(statusRead.body.result.contents[0].mimeType, 'application/json')
  assert.equal(typeof JSON.parse(statusRead.body.result.contents[0].text), 'object')
  checks.push('resources/read projects a known resource as one JSON contents entry')

  const unknownResource = await rpc({ jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'dsh://nope' } })
  assert.equal(unknownResource.body.error.code, -32002)
  assert.match(unknownResource.body.error.message, /Unknown resource/)
  checks.push('resources/read of an unknown uri is -32002 resourceNotFound')

  const missingUri = await rpc({ jsonrpc: '2.0', id: 11, method: 'resources/read', params: {} })
  assert.equal(missingUri.body.error.code, -32602)
  checks.push('resources/read without a string uri is -32602')

  // --- method dispatch --------------------------------------------------------
  const unknownMethod = await rpc({ jsonrpc: '2.0', id: 12, method: 'prompts/list', params: {} })
  assert.equal(unknownMethod.status, 200)
  assert.equal(unknownMethod.body.error.code, -32601)
  assert.equal(unknownMethod.body.id, 12)
  checks.push('an unsupported method, including prompts/list, is -32601 methodNotFound')

  const unknownNotification = await notify('notifications/not-implemented')
  assert.equal(unknownNotification.status, 202)
  assert.equal(unknownNotification.body, undefined)
  checks.push('an unknown notification is acknowledged with 202 and never answered')

  // --- malformed JSON-RPC envelopes ------------------------------------------
  const badJson = await postRaw('{not json')
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.error.code, -32700)
  checks.push('a body that is not JSON is HTTP 400 with -32700 parseError')

  const batch = await postRaw('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')
  assert.equal(batch.status, 400)
  assert.equal(batch.body.error.code, -32600)
  assert.match(batch.body.error.message, /batch/i)
  checks.push('a JSON-RPC batch is refused with -32600 instead of being split')

  for (const raw of ['"hello"', '42', '']) {
    const nonObject = await postRaw(raw)
    assert.equal(nonObject.status, 400, `${JSON.stringify(raw)} must be refused`)
    assert.equal(nonObject.body.error.code, -32600)
  }
  checks.push('a non-object or empty body is HTTP 400 with -32600')

  const noMethod = await rpc({ jsonrpc: '2.0', id: 13 })
  assert.equal(noMethod.status, 400)
  assert.equal(noMethod.body.error.code, -32600)
  assert.equal(noMethod.body.id, 13, 'the id is preserved on an invalid envelope')
  checks.push('an envelope without a string method is -32600 and keeps the id')

  // The wire check is structural: a method string is required, while the
  // jsonrpc member is not re-validated. Both of these are dispatched.
  for (const message of [{ id: 14, method: 'ping' }, { jsonrpc: '1.0', id: 15, method: 'ping' }]) {
    const lenient = await rpc(message)
    assert.equal(lenient.status, 200)
    assert.deepEqual(lenient.body.result, {})
    assert.equal(lenient.body.jsonrpc, '2.0', 'every response still declares 2.0')
  }
  checks.push('the envelope check requires a method string and does not re-validate jsonrpc')

  // --- authentication ---------------------------------------------------------
  const noAuth = await postRaw('{not json', { token: '' })
  assert.equal(noAuth.status, 401)
  assert.match(String(noAuth.body), /Unauthorized/)
  assert.match(noAuth.headers.get('www-authenticate') ?? '', /^Bearer /)
  checks.push('a request with no Authorization is 401 before the body is parsed')

  const wrongToken = await rpc({ jsonrpc: '2.0', id: 16, method: 'ping' }, { token: 'wrong-token' })
  assert.equal(wrongToken.status, 401)
  checks.push('a wrong bearer token is rejected with 401')

  const headerToken = await rpc({ jsonrpc: '2.0', id: 17, method: 'ping' }, { token: '', headers: { 'x-dsh-mcp-token': TOKEN } })
  assert.equal(headerToken.status, 200)
  assert.deepEqual(headerToken.body.result, {})
  checks.push('the x-dsh-mcp-token header is an accepted alternative to Bearer')

  const queryToken = await fetch(`${endpoint}?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 18, method: 'ping' }),
  })
  assert.equal(queryToken.status, 401)
  checks.push('a token in the query string is not accepted')

  // --- stateless session handling --------------------------------------------
  assert.equal(init.headers.get('mcp-session-id'), null, 'the server never assigns a session id')
  const withSession = await rpc(
    { jsonrpc: '2.0', id: 19, method: 'tools/list', params: {} },
    { headers: { 'mcp-session-id': 'client-chosen-session', 'mcp-protocol-version': '2025-06-18' } },
  )
  assert.equal(withSession.status, 200)
  assert.equal(withSession.body.result.tools.length, 21)
  assert.equal(withSession.headers.get('mcp-session-id'), null)
  checks.push('a client-supplied Mcp-Session-Id is accepted and ignored by this stateless endpoint')

  // --- HTTP transport shape ---------------------------------------------------
  const getRequest = await fetch(endpoint, { method: 'GET' })
  assert.equal(getRequest.status, 405)
  assert.equal(getRequest.headers.get('allow'), 'POST, OPTIONS')
  const optionsRequest = await fetch(endpoint, { method: 'OPTIONS' })
  assert.equal(optionsRequest.status, 204)
  assert.equal(optionsRequest.headers.get('allow'), 'POST, OPTIONS')
  checks.push('GET is refused with 405 and OPTIONS advertises POST, OPTIONS')

  for (const check of checks) process.stdout.write(`ok - ${check}\n`)
  process.stdout.write(`\n${checks.length} MCP conformance checks passed\n`)
} finally {
  await new Promise((resolve) => server.close(resolve))
  for (const dispose of disposers.reverse()) {
    try {
      await dispose?.()
    } catch {
      // A cleanup failure must not mask the result.
    }
  }
  await rm(dir, { recursive: true, force: true })
}
