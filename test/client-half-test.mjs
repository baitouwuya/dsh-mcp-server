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

import { createConfigHandler, validateConfigPatch } from '../lib/config-route.js'

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

assert.equal(registrations.length, 2, 'the client half registers the row page and a first-level settings section')
const page = registrations.find((entry) => entry.options.name === 'plugins.row.config')
const section = registrations.find((entry) => entry.options.name === 'settings.section')
assert.ok(page, 'the Plugins page entry is registered')
assert.equal(page.options.key, '@local/dsh-mcp-server#dsh-mcp-server', 'keyed by package and row id')
checks.push('the page registers into the Plugins page under this bundle row')

// The same panel is a first-level Settings section: a list-slot entry with an
// id, an order and a nav label, so the switches are not two levels deep.
assert.ok(section, 'a settings.section entry is registered')
assert.equal(section.options.id, 'dsh-mcp-server')
assert.equal(typeof section.options.order, 'number')
assert.equal(typeof section.options.label, 'string', 'the nav label is resolvable text')
assert.equal(section.options.locale, 'dshMcpServer')
checks.push('the same panel registers as a first-level Settings section')

assert.equal(page.component({ view: 'summary' }), page.component({ view: 'summary' }))
assert.equal(typeof page.component({ view: 'summary' }), 'string')
const rendered = page.component({ view: 'page' })
assert.equal(typeof rendered.type, 'function', 'the page view renders the configuration panel')
assert.equal(rendered.props.t('title') !== 'title', true, 'the panel receives a translator')
checks.push('the row page renders a summary string and the configuration panel')

// Render the panel body itself: React.createElement does not call a component, so
// a broken control would otherwise only show up in a browser. The stub reports
// every switch as "on", which is what makes the optional controls render.
const renderingReact = {
  createElement: React.createElement,
  useState: (value) => [value === undefined ? true : value, () => {}],
  useEffect: () => {},
  useCallback: (callback) => callback,
}
const panelHost = spec.factory(() => renderingReact)
const panelParts = (() => {
  const registered = new Map()
  const slots = { inject: (_name, callback) => { callback(); return () => {} }, register: (options, component) => { registered.set(options.name, component); return () => {} } }
  panelHost.apply({ get: (name) => (name === 'slots' ? slots : undefined), effect: (create) => create() })
  return registered
})()
const panelPage = panelParts.get('plugins.row.config')
const collectText = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(collectText)
  return collectText(node.children)
}
const labels = collectText(panelPage({ view: 'page' }).type(panelPage({ view: 'page' }).props))
for (const expected of ['Surface', 'On demand', 'All at once', 'Sidebar projects', 'Join an existing project', 'May create projects', 'Delivery while busy', 'Follow the setting', 'Queue', 'Steer', 'Sync progress when a task starts']) {
  assert.ok(labels.includes(expected), `the settings page must offer "${expected}"`)
}
checks.push('the settings page renders every control it offers')

const sectionT = (key) => ({ sectionIntro: 'intro-copy' }[key] ?? key)
const sectionElement = panelParts.get('settings.section')({ t: sectionT })
const sectionLabels = collectText(sectionElement.type(sectionElement.props))
assert.ok(sectionLabels.includes('intro-copy'), 'the section explains what it configures')
assert.ok(sectionLabels.includes('syncLabel'), 'and offers the same controls')
checks.push('the first-level Settings section renders the panel with its own introduction')

// Every switch must be operable: a truthy `disabled` left a page whose main
// enable toggle could never be clicked.
const findButtons = (node, found = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) { for (const child of node) findButtons(child, found); return found }
  if (node.type === 'button') found.push(node)
  for (const child of node.children ?? []) findButtons(child, found)
  return found
}
const panelTree = panelPage({ view: 'page' }).type(panelPage({ view: 'page' }).props)
const switches = findButtons(panelTree).filter((button) => button.props.role === 'switch')
assert.equal(switches.length, 2, 'the page offers the enable switch and the sync switch')
assert.equal(Boolean(switches[0].props.disabled), false, 'the enable switch is operable')
assert.equal(Boolean(switches[1].props.disabled), false, 'the sync switch is operable')
checks.push('both switches are operable in the ready state')
const panelCopy = labels.join(' ')
assert.equal(/\b17 tools\b|17 个工具/.test(panelCopy), false, 'the page does not advertise a stale tool count')
assert.match(panelCopy, /18 tools/, 'the page names the real published count')
checks.push('the page copy matches the eighteen published tools')

assert.match(validateConfigPatch({ exposeToDsh: true, typo: 1 }).error, /Unknown field/, 'unknown fields are refused, not ignored')
checks.push('the configuration validator refuses unknown fields')

// --- the switch's read/write contract ----------------------------------------
let written
let command = null
const handler = createConfigHandler({
  snapshot: () => ({
    package: '@local/dsh-mcp-server',
    version: '0.9.0',
    exposeToDsh: written?.exposeToDsh ?? true,
    exposeToDshMode: written?.exposeToDshMode ?? 'lazy',
    groupSessions: written?.groupSessions ?? true,
    createGroups: written?.createGroups ?? false,
    busyMode: written?.busyMode ?? 'setting',
    busyEffective: 'steer',
    published: ['dsh_status'],
    registered: ['dsh_mcp_tools'],
    url: 'http://127.0.0.1:9/mcp',
    command,
  }),
  write: async (patch) => { written = { ...(written ?? {}), ...patch } },
  queueSession: async (sessionId) => { command = { kind: 'open-session', sessionId, at: Date.now() }; return true },
  ackCommand: async () => { command = null },
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

assert.equal(exported.pollMs, 1500, 'the watcher polls at the documented interval')

const jump = await exported.writePatch({ openSession: 'session-abc' }, base)
assert.equal(jump.ok, true)
assert.equal(jump.command.sessionId, 'session-abc', 'the Host queues the GUI command')
checks.push('the client half can ask the Host to open a session')

const acknowledged = await exported.writePatch({ ackCommand: true }, base)
assert.equal(acknowledged.command, null, 'the command is consumed once acknowledged')
checks.push('an acknowledged GUI command is cleared')

const reread = await exported.readSetting(base)
assert.equal(reread.exposeToDsh, false, 'a later read sees the saved value')
assert.equal(reread.exposeToDshMode, 'full', 'a later read sees the saved mode')
checks.push('a saved setting is what the next read reports')

// The POST ceiling belongs to the route and is configurable: the default is
// tiny, and a deployment that needs more can raise it.
const oversizedDefault = await fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ openSession: 'x'.repeat(5000) }),
})
assert.equal(oversizedDefault.status, 413, 'a body past the default ceiling is refused')
assert.match(String((await oversizedDefault.json()).error), /4096/, 'the refusal names the default ceiling')
checks.push('the configuration route refuses a body past its default 4 KB ceiling')

const raisedHandler = createConfigHandler({
  snapshot: () => ({ exposeToDsh: true, exposeToDshMode: 'lazy', busyMode: 'setting', published: [], registered: [], command: null }),
  write: async () => {},
  maxBodyBytes: 8192,
})
const raisedServer = createServer((req, res) => { void raisedHandler(req, res) })
await new Promise((resolve) => raisedServer.listen(0, '127.0.0.1', resolve))
const raisedBase = `http://127.0.0.1:${raisedServer.address().port}`
const raised = await fetch(raisedBase, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ openSession: 'x'.repeat(5000) }),
})
assert.equal(raised.status, 400, 'a raised ceiling lets the same body reach validation')
assert.match(String((await raised.json()).error), /session id/, 'it is refused for its content, not its size')
await new Promise((resolve) => raisedServer.close(resolve))
checks.push('a raised configMaxBodyBytes reaches the route option and changes the ceiling')

await new Promise((resolve) => server.close(resolve))
console.log(`${checks.length} client half checks passed`)
for (const check of checks) console.log(`ok - ${check}`)
