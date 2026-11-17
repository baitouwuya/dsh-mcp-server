#!/usr/bin/env node
/**
 * The scope route against a real `apply()`, not a stand-in.
 *
 * The unit tests drive `createScopeHandler` with a fake scope, which proves the
 * HTTP shape but not that the plugin wires a working scope into it — that is what
 * this file is for: GET must report the registry, POST must persist the sidecar,
 * and `dsh_status` must show the same document.
 *
 * Run: node test/tool-scope-integration.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createPluginHarness } from './helpers/plugin-harness.mjs'

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

const h = await createPluginHarness({ label: 'tool-scope-integration' })
// Seed the registry before touching the route: with no workspaces every assertion
// below would compare empty sets and pass without exercising a selection.
await h.workspaceRegistry.create('/repo/seed-a')
await h.workspaceRegistry.create('/repo/seed-b')

try {
  const first = await (await fetch(h.scopeUrl)).json()

  await check('GET reports a supported scope and the seeded workspaces', () => {
    assert.equal(first.supported, true, 'the harness registry must be usable')
    assert.equal(first.mode, 'global', 'a deployment that never chose is global')
    assert.deepEqual(first.workspaces.map((row) => row.path).sort(), ['/repo/seed-a', '/repo/seed-b'])
  })

  await check('POST saves the sidecar, and GET reads it back', async () => {
    const target = (await (await fetch(h.scopeUrl)).json()).workspaces
    const response = await fetch(h.scopeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'selected', workspaceIds: target.map((row) => row.id) }),
    })
    assert.equal(response.status, 200)
    const saved = await response.json()
    assert.equal(saved.mode, 'selected')

    const reread = await (await fetch(h.scopeUrl)).json()
    assert.equal(reread.mode, 'selected')
    assert.deepEqual([...reread.workspaceIds].sort(), target.map((row) => row.id).sort())

    const text = await readFile(join(h.dir, 'mcp', 'tool-scope.json'), 'utf8')
    assert.equal(JSON.parse(text).mode, 'selected', 'the document must actually be on disk')
  })

  await check('dsh_status reports the same document the route just saved', async () => {
    const status = await h.call('dsh_status', {})
    assert.equal(status.scope?.mode, 'selected')
    assert.ok(Array.isArray(status.scope?.workspaceIds))
  })

  await check('an unknown workspace id changes nothing', async () => {
    const before = await (await fetch(h.scopeUrl)).json()
    const response = await fetch(h.scopeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'selected', workspaceIds: ['ws-ghost'] }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'unknown-workspace')
    const after = await (await fetch(h.scopeUrl)).json()
    assert.deepEqual(after.workspaceIds, before.workspaceIds, 'a refused save must not change the document')
  })

  await check('going global again keeps the selection for next time', async () => {
    const before = await (await fetch(h.scopeUrl)).json()
    const response = await fetch(h.scopeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'global', workspaceIds: before.workspaceIds }),
    })
    assert.equal(response.status, 200)
    const after = await response.json()
    assert.equal(after.mode, 'global')
    assert.deepEqual(after.workspaceIds, before.workspaceIds, 'switching to global must not forget the selection')
  })
  await check('a browser-shaped same-origin POST is admitted, a foreign Origin is not', async () => {
    const host = new URL(h.address).host
    const same = await fetch(h.scopeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://${host}` },
      body: JSON.stringify({ mode: 'global' }),
    })
    assert.equal(same.status, 200, 'the settings page always sends an Origin; without it every save would 403')

    const foreign = await fetch(h.scopeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ mode: 'global' }),
    })
    assert.equal(foreign.status, 403)
  })

} finally {
  await h.close()
}

console.log(`\n${passed} tool-scope-integration checks passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
