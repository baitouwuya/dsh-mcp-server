#!/usr/bin/env node
/**
 * The `/mcp-scope` route: what the settings page reads and writes.
 *
 * The handler is driven over a real socket so the peer address is genuinely
 * loopback, and `trust` is stubbed because what it decides here is only whether
 * workspace paths travel, not whether the write is allowed.
 *
 * Run: node test/scope-route-test.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createScopeHandler } from '../lib/scope-route.js'

let passed = 0
const failures = []
async function check(name, run) {
  try {
    await run()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL - ${name}\n  ${error && error.message ? error.message : String(error)}`)
  }
}

const WORKSPACES = [
  { id: 'ws_a', title: 'hermes', path: '/repo/hermes' },
  { id: 'ws_b', title: 'twin', path: '/workspace/twin' },
]

/** A scope double whose save records what it was asked to store. */
function fakeScope({ supported = true, mode = 'global', workspaceIds = [], saveError = undefined } = {}) {
  const saved = []
  let current = { supported, mode, workspaceIds, notes: [], unmatchedAgents: 0 }
  return {
    saved,
    supported,
    state: () => ({ ...current, workspaceIds: [...current.workspaceIds] }),
    async save(input) {
      if (saveError) throw saveError
      saved.push(input)
      current = { ...current, mode: input.mode, workspaceIds: [...(input.workspaceIds ?? [])] }
      return { ...current }
    },
  }
}

async function serve(handler) {
  const server = createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function withServer(options, run) {
  const handler = createScopeHandler({ registry: { list: () => WORKSPACES }, trust: () => true, ...options })
  const { server, base } = await serve(handler)
  try {
    await run(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// --- reading -----------------------------------------------------------------

await check('GET reports the document and the workspaces the page can pick from', async () => {
  const scope = fakeScope({ mode: 'selected', workspaceIds: ['ws_a'] })
  await withServer({ scope }, async (base) => {
    const body = await (await fetch(base)).json()
    assert.equal(body.supported, true)
    assert.equal(body.mode, 'selected')
    assert.deepEqual(body.workspaceIds, ['ws_a'])
    assert.deepEqual(body.workspaces.map((row) => row.id), ['ws_a', 'ws_b'])
  })
})

await check('an untrusted caller learns nothing at all, not even the workspace list', async () => {
  const scope = fakeScope()
  await withServer({ scope, trust: () => false }, async (base) => {
    const response = await fetch(base)
    assert.equal(response.status, 403, 'reading the picker is as local-only as changing it')
  })
})

await check('a registry that arrives after the route is built still fills the picker', async () => {
  // The defect: the handler captured the registry when it was constructed. A Harness
  // that exposes it later left the picker empty forever, with no note explaining why.
  let registry
  const scope = fakeScope({ mode: 'selected', workspaceIds: [] })
  const handler = createScopeHandler({
    scope,
    getRegistry: () => registry,
    trust: () => true,
  })
  const { server, base } = await serve(handler)
  try {
    const before = await (await fetch(base)).json()
    assert.deepEqual(before.workspaces, [])
    registry = { list: () => WORKSPACES }
    const after = await (await fetch(base)).json()
    assert.deepEqual(after.workspaces.map((row) => row.id), ['ws_a', 'ws_b'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// --- writing -----------------------------------------------------------------

await check('POST saves the selection and answers with the live state', async () => {
  const scope = fakeScope()
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.mode, 'selected')
    assert.deepEqual(body.workspaceIds, ['ws_a'], 'the answer must be the saved state, not the previous one')
    assert.deepEqual(scope.saved, [{ mode: 'selected', workspaceIds: ['ws_a'] }])
  })
})

await check('a refused save reports its own status and code', async () => {
  const error = Object.assign(new Error('invalid-mode: nope'), { status: 400, code: 'invalid-mode' })
  const scope = fakeScope({ saveError: error })
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'nope' }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'invalid-mode')
  })
})

await check('an unsupported Harness refuses the write instead of storing it', async () => {
  const scope = fakeScope({ supported: false })
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'global' }),
    })
    assert.equal(response.status, 501)
    assert.equal((await response.json()).code, 'scope-unsupported')
    assert.equal(scope.saved.length, 0)
  })
})

await check('a non-JSON body is refused before anything is stored', async () => {
  const scope = fakeScope()
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'mode=global' })
    assert.equal(response.status, 415)
    assert.equal(scope.saved.length, 0)
  })
})

await check('malformed JSON is a 400, not a crash', async () => {
  const scope = fakeScope()
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'invalid-body')
  })
})

await check('a method other than GET/HEAD/POST is refused with the allowed list', async () => {
  const scope = fakeScope()
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD, POST')
  })
})

await check('a failing scope answers 500 instead of hanging the request', async () => {
  const scope = { ...fakeScope(), state: async () => { throw new Error('boom') } }
  await withServer({ scope }, async (base) => {
    const response = await fetch(base)
    assert.equal(response.status, 500)
    assert.equal((await response.json()).code, 'scope-failed')
  })
})

await check('a registry that throws is reported as degraded, not as an empty Harness', async () => {
  const scope = fakeScope()
  const registry = { list: () => { throw new Error('registry down') } }
  await withServer({ scope, registry }, async (base) => {
    const body = await (await fetch(base)).json()
    assert.deepEqual(body.workspaces, [])
    assert.ok(body.notes.includes('scope-registry-degraded'), JSON.stringify(body.notes))
  })
})

await check('a JSON null body is a 400, not a 500 with internals', async () => {
  const scope = fakeScope()
  await withServer({ scope }, async (base) => {
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'invalid-body')
    assert.equal(scope.saved.length, 0, 'and nothing was written')
  })
})

await check('an oversized body is a 413 with JSON, not a dropped connection', async () => {
  const scope = fakeScope()
  await withServer({ scope, maxBodyBytes: 1024 }, async (base) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'global', filler: 'x'.repeat(4000) }),
    })
    assert.equal(response.status, 413)
    assert.equal((await response.json()).code, 'BODY_TOO_LARGE')
  })
})

await check('the allowlist relaxes only the Origin/Host comparison', async () => {
  const scope = fakeScope()
  // The real `configTrust` for a browser request: Origin must match Host.
  const browserTrust = (req) => {
    const origin = req.headers?.origin
    if (typeof origin !== 'string') return true
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }
  const LAN = 'http://192.168.50.216:23022'
  await withServer({ scope, trust: browserTrust, allowedOrigins: [LAN] }, async (base) => {
    const allowed = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', origin: LAN }, body: JSON.stringify({ mode: 'global' }) })
    assert.equal(allowed.status, 200, 'a named origin is admitted')

    const foreign = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ mode: 'global' }),
    })
    assert.equal(foreign.status, 403, 'any other Origin is still refused')
  })
})

await check('a stock deployment (no allowlist) can still save from the page', async () => {
  const scope = fakeScope()
  // Same-origin page request: Origin matches Host, which is the normal case.
  const browserTrust = (req) => {
    const origin = req.headers?.origin
    if (typeof origin !== 'string') return true
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }
  await withServer({ scope, trust: browserTrust }, async (base) => {
    const host = new URL(base).host
    const response = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://${host}` },
      body: JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] }),
    })
    assert.equal(response.status, 200, 'without any allowlist, the page must still be able to save')
    assert.equal(scope.saved.length, 1)
  })
})

// --- summary -----------------------------------------------------------------

console.log(`\n${passed} scope-route checks passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
