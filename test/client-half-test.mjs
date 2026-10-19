/**
 * The client half's contract, checked without a browser.
 *
 * The bundle is a `window.__ModuleLoader__.load` registration, so the test
 * plays the module loader, gives the factory a minimal React, and drives the
 * exported helpers against the real configuration route over loopback HTTP.
 *
 * @module dsh-mcp-server/test/client-half
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createConfigHandler } from '../lib/config-route.js'

const checks = []

// --- the module loader facade ------------------------------------------------
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded.push(spec) } } }
await import('../lib/client.js')

assert.equal(loaded.length, 1, 'the bundle registers exactly one factory')
const spec = loaded[0]
assert.equal(spec.id, '@local/dsh-mcp-server', 'the browser module is this package')
checks.push('the client half registers under this package name')

/** A React just real enough to build elements and hold hook state. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (callback) => callback,
}

let required
const exported = spec.factory((name) => {
  required = name
  return React
})
assert.equal(required, 'react', 'the client half asks only for React')
assert.deepEqual(exported.inject, ['slots', 'locale'])
assert.equal(typeof exported.apply, 'function')
checks.push('the client half requires only the baseline React module')

// --- the row configuration page ----------------------------------------------
const registrations = []
const slots = {
  inject: (_name, callback) => { callback(); return () => {} },
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}
const ctx = {
  get: (name) => (name === 'slots' ? slots : undefined),
  effect: (create) => create(),
}
exported.apply(ctx)

assert.equal(registrations.length, 1, 'the page registers exactly one slot entry')
const page = registrations[0]
assert.equal(page.options.name, 'plugins.row.config', 'it configures a plugin row')
assert.equal(page.options.key, '@local/dsh-mcp-server#dsh-mcp-server', 'keyed by package and row id')
checks.push('the page registers into the Plugins page under this bundle row')

assert.equal(page.component({ view: 'summary' }), page.component({ view: 'summary' }))
assert.equal(typeof page.component({ view: 'summary' }), 'string')
const rendered = page.component({ view: 'page' })
assert.equal(typeof rendered.type, 'function', 'the page view renders the configuration panel')
assert.equal(rendered.props.t('title') !== 'title', true, 'the panel receives a translator')
checks.push('the row page renders a summary string and the configuration panel')

// --- the switch's read/write contract ----------------------------------------
let written
const handler = createConfigHandler({
  snapshot: () => ({
    package: '@local/dsh-mcp-server',
    version: '0.8.0',
    exposeToDsh: written?.exposeToDsh ?? true,
    exposeToDshMode: written?.exposeToDshMode ?? 'lazy',
    published: ['dsh_status'],
    registered: ['dsh_mcp_tools'],
    url: 'http://127.0.0.1:9/mcp',
  }),
  write: async (patch) => { written = { ...(written ?? {}), ...patch } },
})
const server = createServer((req, res) => { void handler(req, res) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const read = await exported.readSetting(base)
assert.equal(read.exposeToDsh, true, 'a read reports the live switch')
assert.equal(read.exposeToDshMode, 'lazy', 'a read reports the surface mode')
assert.equal(read.url, 'http://127.0.0.1:9/mcp')
checks.push('the client half reads the switch and the mode from the Host route')

const write = await exported.writePatch({ exposeToDsh: false }, base)
assert.equal(write.ok, true)
assert.equal(write.exposeToDsh, false, 'the response echoes what was asked for')
assert.equal(written.exposeToDsh, false, 'the Host route received the new value')
checks.push('the client half writes the switch through the Host route')

const modeWrite = await exported.writePatch({ exposeToDshMode: 'full' }, base)
assert.equal(modeWrite.ok, true)
assert.equal(written.exposeToDshMode, 'full', 'the mode patch reached the Host route')
checks.push('the client half writes the surface mode through the same route')

const reread = await exported.readSetting(base)
assert.equal(reread.exposeToDsh, false, 'a later read sees the saved value')
assert.equal(reread.exposeToDshMode, 'full', 'a later read sees the saved mode')
checks.push('a saved setting is what the next read reports')

await new Promise((resolve) => server.close(resolve))
console.log(`${checks.length} client half checks passed`)
for (const check of checks) console.log(`ok - ${check}`)
