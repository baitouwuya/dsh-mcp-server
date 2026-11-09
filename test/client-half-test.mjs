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
assert.equal(spec.id, 'dsh-mcp-btwy', 'the browser module is this package')
checks.push('the client half registers under this package name')

/** A React just real enough to build elements and hold hook state. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), ...(children.length ? { children } : {}) }, children }),
  Component: class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
  },
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (callback) => callback,
}

/** The Harness primitives, as plain host elements so the tree can be walked. */
const uiMock = {
  Switch: (props) => ({ type: 'button', props: { role: 'switch', 'aria-checked': props.checked ? 'true' : 'false', 'aria-label': props.label, disabled: props.disabled }, children: [] }),
  SegmentedControl: (props) => ({ type: 'div', props: { role: 'tablist', 'aria-label': props.label }, children: (props.options || []).map((option) => ({ type: 'button', props: { 'aria-pressed': option.value === props.value ? 'true' : 'false', disabled: props.disabled }, children: [option.label] })) }),
  Pill: (props) => ({ type: props.onClick ? 'button' : 'span', props: { 'aria-pressed': props.active ? 'true' : 'false', disabled: props.disabled }, children: [props.children] }),
  Button: (props) => ({ type: 'button', props: { onClick: props.onClick }, children: [props.children] }),
  // The Harness bubble chassis and Markdown renderer, as the module finds them
  // in a real page: a delivered message reuses both instead of a look-alike.
  UserMessageBubble: (props) => ({ type: 'div', props: { ...props, 'data-bubble': 'harness' }, children: props.children === undefined ? [] : [].concat(props.children) }),
  MarkdownText: (props) => ({ type: 'div', props: { 'data-markdown': String(props.text) }, children: [props.text] }),
}
const required = []
const exported = spec.factory((name) => {
  required.push(name)
  return name === 'react' ? React : uiMock
})
assert.deepEqual(required, ['react', '@deepseek-ai/dsh-client-ui-primitives'], 'the client half requires React and the Harness primitives')
assert.deepEqual(exported.inject, ['slots', 'locale'])
assert.equal(typeof exported.apply, 'function')
checks.push('the client half requires React and the Harness UI primitives, nothing else')

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

assert.equal(registrations.length, 4, 'the client half registers the bundle page, the row page, the wake card and the origin line')
const page = registrations.find((entry) => entry.options.name === 'plugins.row.config')
const bundle = registrations.find((entry) => entry.options.name === 'plugins.bundle.config')
assert.ok(page, 'the row page entry is registered')
assert.equal(page.options.key, 'dsh-mcp-btwy#dsh-mcp-server', 'keyed by package and row id')
checks.push('the page registers into the Plugins page under this bundle row')

// The bundle's own page shows the panel directly, above its component rows: the
// Plugins page renders plugins.bundle.config for the package whose name keys the
// entry, so no row drill-down is needed to reach the switches.
assert.ok(bundle, 'a plugins.bundle.config entry is registered')
assert.equal(bundle.options.key, 'dsh-mcp-btwy', 'keyed by package name, as the bundle page looks it up')
assert.equal(bundle.options.locale, 'dshMcpServer')
checks.push('the same panel registers on the bundle page itself')

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
  Component: React.Component,
  useState: (value) => [value === undefined ? true : value, () => {}],
  useEffect: () => {},
  useCallback: (callback) => callback,
}
const panelHost = spec.factory((name) => (name === 'react' ? renderingReact : uiMock))
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
// React.createElement does not invoke components, so walk the tree by calling
// every component it meets — that is what puts the primitives' host elements in.
const renderAll = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(renderAll)
  if (typeof node.type === 'function') return renderAll(node.type(node.props))
  return { ...node, children: (node.children ?? []).map(renderAll) }
}
const labels = collectText(renderAll(panelPage({ view: 'page' })))
for (const expected of ['Surface', 'On demand', 'All at once', 'Sidebar projects', 'Join an existing project', 'May create projects', 'Delivery while busy', 'Follow the setting', 'Queue', 'Steer', 'How internal messages appear', 'Bubble', 'Wake card', 'Sync progress when a task starts', 'Approvals', 'Questions']) {
  assert.ok(labels.includes(expected), `the settings page must offer "${expected}"`)
}
checks.push('the settings page renders every control it offers')

const bundleT = (key) => ({ bundleIntro: 'intro-copy' }[key] ?? key)
const bundleElement = panelParts.get('plugins.bundle.config')({ t: bundleT })
const bundleLabels = collectText(renderAll(bundleElement))
assert.ok(bundleLabels.includes('intro-copy'), 'the bundle page explains what it configures')
assert.ok(bundleLabels.includes('syncLabel'), 'and offers the same controls')
assert.ok(bundleLabels.includes('sectionTitle'), 'including the surface row title')
checks.push('the bundle page renders the panel with its own introduction and the settings rows')

// Every switch must be operable: a truthy `disabled` left a page whose main
// enable toggle could never be clicked.
const findButtons = (node, found = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) { for (const child of node) findButtons(child, found); return found }
  if (node.type === 'button') found.push(node)
  for (const child of node.children ?? []) findButtons(child, found)
  return found
}
const panelTree = renderAll(panelPage({ view: 'page' }))
const switches = findButtons(panelTree).filter((button) => button.props.role === 'switch')
assert.equal(switches.length, 4, 'the page offers the enable, approval, question and sync switches')
assert.equal(Boolean(switches[0].props.disabled), false, 'the enable switch is operable')
assert.equal(Boolean(switches[1].props.disabled), false, 'the approval switch is operable')
assert.equal(Boolean(switches[2].props.disabled), false, 'the question switch is operable')
assert.equal(Boolean(switches[3].props.disabled), false, 'the sync switch is operable')
checks.push('every switch is operable in the ready state')
const panelCopy = labels.join(' ')
assert.equal(/\b20 tools\b|20 个工具/.test(panelCopy), false, 'the page does not advertise a stale tool count')
assert.match(panelCopy, /26 tools/, 'the page names the real published count')
checks.push('the page copy matches the twenty-six published tools')

assert.match(validateConfigPatch({ exposeToDsh: true, typo: 1 }).error, /Unknown field/, 'unknown fields are refused, not ignored')
assert.equal(validateConfigPatch({ internalMessageStyle: 'card' }).patch.internalMessageStyle, 'card', 'the transcript style is a validated field')
assert.match(validateConfigPatch({ internalMessageStyle: 'fancy' }).error, /bubble.*card/, 'any other value is refused')
checks.push('the configuration validator refuses unknown fields')

// --- the switch's read/write contract ----------------------------------------
let written
let command = null
const handler = createConfigHandler({
  snapshot: () => ({
    package: 'dsh-mcp-btwy',
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


// --- the wake card above a turn no person started ---------------------------
// DSH renders a card, not a bubble, for a message that started a turn on its own.
// Its title map has no entry for this endpoint's kinds, so the card said only
// "a request started this turn". The shadowed cell names the sender instead.
const cardEntry = registrations.find((entry) => entry.options.name === 'conversation.chat.node')
assert.ok(cardEntry, 'the wake card registers into the keyed Chat node seat')
assert.equal(cardEntry.options.key, 'turn-trigger', 'it replaces the shipped trigger cell')
assert.equal(cardEntry.options.priority, -1, 'a lower priority is what shadows a keyed cell')
checks.push('the wake card shadows the shipped turn-trigger cell')

const cardZh = (key) => ({
  originFrom: '来自「{name}」',
  originOpen: '打开来源会话',
  originSync: '进度同步',
  originMcp: 'MCP 消息',
  triggerExplanation: '这条通知触发了本轮回复。',
  triggerRequest: '收到执行请求',
  triggerSchedule: '本轮由定时任务唤醒',
  bubbleMore: '展开全部（{lines} 行）',
  bubbleLess: '收起',
}[key] ?? key)
const cardList = { byId: { s1: { displayTitle: 'MCP 插件开发' } } }
// A delivery from this endpoint is a message, not a wake: it renders as a bubble
// on the right, with the sender above it, exactly like the ChatGPT-style header
// the person asked for.
const named = exported.buildTriggerCard({ node: { data: { source: { kind: 'dsh-mcp-server', sessionId: 's1' }, content: [{ type: 'text', text: '只回复一句：内部来源测试 OK。' }], time: Date.parse('2026-11-06T10:17:39Z') } }, t: cardZh, getList: () => cardList }, cardList)
assert.equal(named.props['data-dsh-mcp-bubble'], 's1', 'a delivered prompt renders as a bubble, not a card')
assert.match(collectText(named).join(' '), /来自「MCP 插件开发」 · MCP 消息/, 'the header names the sender and the delivery')
const track = (node, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) track(child, out); return out }
  out.push(node)
  for (const child of node.props?.children ?? []) track(child, out)
  return out
}
const mdNode = track(named).find((node) => node.type === uiMock.MarkdownText)
assert.ok(mdNode, 'the text goes through the Harness Markdown renderer')
assert.match(String(mdNode.props.text), /内部来源测试 OK/, 'and it is the delivered text')
const chassis = track(named).find((node) => node.type === uiMock.UserMessageBubble)
assert.ok(chassis, 'the bubble itself is the Harness component, not a look-alike')
const syncBubble = exported.buildTriggerCard({ node: { data: { source: { kind: 'dsh-work-sync', sessionId: 's1' }, content: [{ type: 'text', text: '【进度同步】…' }], time: Date.now() } }, t: cardZh, getList: () => cardList }, cardList)
assert.equal(syncBubble.props['data-dsh-mcp-bubble'], 's1', 'a progress-sync notice is a bubble too')
checks.push('a message this endpoint delivered renders as a bubble with its sender above')

// The switch puts the shipped wake card back, for a reader who prefers it.
const asCard = exported.buildTriggerCard({ node: { data: { source: { kind: 'dsh-mcp-server', sessionId: 's1' }, content: [{ type: 'text', text: 'x' }], time: Date.now() } }, t: cardZh, getList: () => cardList }, cardList, 'card')
assert.equal(asCard.props['data-dsh-mcp-trigger'], 's1', 'the card style renders the wake card again')
assert.equal(asCard.props['data-dsh-mcp-bubble'], undefined, 'and no bubble')
checks.push('the transcript style switch puts the wake card back')

// The title is the affordance the reader clicks; the chevron is the disclosure.
const finder = (node, type, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) { for (const child of node) finder(child, type, found); return found }
  if (node.type === type) found.push(node)
  for (const child of node.props?.children ?? []) finder(child, type, found)
  if (Array.isArray(node.children)) for (const child of node.children) finder(child, type, found)
  return found
}
const openedCard = []
const clickableCard = exported.buildTriggerCard({ node: { data: { source: { kind: 'dsh-work-sync', sessionId: 's1' }, content: [{ type: 'text', text: 'ping' }], time: Date.now() } }, t: cardZh, getList: () => cardList, openSession: (id) => openedCard.push(id) }, cardList)
const titleButton = finder(clickableCard, 'button').find((button) => button.props['data-dsh-mcp-origin'] === 's1')
assert.ok(titleButton, 'the bubble header is its own control')
titleButton.props.onClick()
assert.deepEqual(openedCard, ['s1'], 'clicking the header opens the sending Session')
checks.push('clicking the bubble header opens the sending Session')

// A long delivered prompt must not push the conversation off the screen: it
// folds to a fixed height with the line count on the control that opens it.
assert.equal(exported.foldInfo([{ type: 'text', text: 'short' }]).long, false, 'a short message does not fold')
assert.equal(exported.foldInfo([{ type: 'text', text: Array.from({ length: 13 }, (_, i) => 'line ' + i).join('\n') }]).long, true, 'a message past the line cap folds')
assert.equal(exported.foldInfo([{ type: 'text', text: 'x'.repeat(exported.BUBBLE_CLAMP_CHARS + 1) }]).long, true, 'one enormous line folds too')
checks.push('a delivered message folds past a line or character cap')

const longParts = [{ type: 'text', text: Array.from({ length: 30 }, (_, i) => '第 ' + (i + 1) + ' 行').join('\n') }]
const longNode = { data: { source: { kind: 'dsh-mcp-server', sessionId: 's1' }, content: longParts, time: Date.now() } }
const folded = exported.buildTriggerCard({ node: longNode, t: cardZh, getList: () => cardList }, cardList)
assert.equal(folded.props['data-dsh-mcp-folded'], 'true', 'a long bubble starts folded')
const foldToggle = finder(folded, 'button').find((button) => String(button.props.className).includes('dsh-mcp-bubble-more'))
assert.ok(foldToggle, 'the folded bubble offers a control')
assert.match(collectText(foldToggle).join(''), /展开全部（30 行）/, 'the control says how much is hidden')

let toggled = 0
const unfolded = exported.buildTriggerCard({ node: longNode, t: cardZh, getList: () => cardList, expanded: true, toggleExpanded: () => (toggled += 1) }, cardList)
assert.equal(unfolded.props['data-dsh-mcp-folded'], 'false', 'an opened bubble is not folded')
const foldOpenToggle = finder(unfolded, 'button').find((button) => String(button.props.className).includes('dsh-mcp-bubble-more'))
assert.match(collectText(foldOpenToggle).join(''), /收起/, 'and the control offers to fold it again')
foldOpenToggle.props.onClick()
const foldedClickable = exported.buildTriggerCard({ node: longNode, t: cardZh, getList: () => cardList, toggleExpanded: () => (toggled += 1) }, cardList)
finder(foldedClickable, 'button').find((button) => String(button.props.className).includes('dsh-mcp-bubble-more')).props.onClick()
assert.equal(toggled, 2, 'both controls drive the same disclosure')
checks.push('the fold control opens and closes the long bubble')


const generic = exported.buildTriggerCard({ node: { data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'nightly' }], time: Date.now() } }, t: cardZh, getList: () => ({ byId: {} }) }, { byId: {} })
assert.equal(generic.props['data-dsh-mcp-trigger'], 'generic', 'a wake with no sender keeps the shipped generic title')
assert.match(collectText(generic).join(' '), /本轮由定时任务唤醒/, 'a known wake family keeps its own title')
checks.push('a wake that names no Session keeps the generic card')

const openCard = exported.buildTriggerCard({ node: { data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'nightly build' }], time: Date.now() } }, t: cardZh, getList: () => ({ byId: {} }), open: true }, { byId: {} })
assert.match(collectText(openCard).join(' '), /这条通知触发了本轮回复。/, 'the opened card explains what it is')
assert.match(collectText(openCard).join(' '), /nightly build/, 'and shows the delivered text')
const closed = exported.buildTriggerCard({ node: { data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'nightly build' }], time: Date.now() } }, t: cardZh, getList: () => ({ byId: {} }) }, { byId: {} })
assert.equal(collectText(closed).join(' ').includes('nightly build'), false, 'a closed card keeps the body out of the flow')
checks.push('the card keeps its disclosure: closed by default, text on open')

// --- the origin line above a delivered message -------------------------------
// Every internal message carries a durable source naming who sent it; the Chat
// shows only the body, so a work-sync notice or a relayed report reads as if the
// user typed it. This entry puts the sender back above the bubble.
const originEntry = registrations.find((entry) => entry.options.name === 'conversation.chat.user.before')
assert.ok(originEntry, 'the origin line registers into the Chat user-row chain slot')
assert.equal(originEntry.options.locale, 'dshMcpServer')
assert.equal(typeof originEntry.options.select, 'function', 'a chain slot entry must carry a selector')
assert.equal(originEntry.options.select({ source: null }), null, 'an ordinary prompt claims nothing')
assert.equal(originEntry.options.select({ source: { kind: 'user', rpcId: 'r1' } }), null, 'a typed message claims nothing')
assert.equal(originEntry.options.select({ source: { kind: 'dsh-mcp-server' } }), null, 'an external MCP delivery names no Session')
assert.notEqual(originEntry.options.select({ source: { kind: 'dsh-work-sync', sessionId: 's1' } }), null, 'a work-sync notice is claimed')
checks.push('the origin line claims only messages that name a sending Session')

assert.deepEqual(exported.originOf({ kind: 'dsh-work-sync', sessionId: 's1', agentId: 'a1' }), { sessionId: 's1', kindKey: 'originSync' }, 'a work-sync notice names its asking Session')
assert.deepEqual(exported.originOf({ kind: 'dsh-mcp-server', sessionId: 's2' }), { sessionId: 's2', kindKey: 'originMcp' }, 'a prompted session names its caller')
assert.deepEqual(exported.originOf({ kind: 'agent-message', form: 'relay', senderSessionId: 's3' }), { sessionId: 's3', kindKey: 'originAgent' }, 'a Harness relay names the agent that sent it')
assert.equal(exported.originOf({ kind: 'dsh-mcp-server' }), null, 'a delivery from an external client names nothing')
assert.equal(exported.originOf(null), null)
assert.equal(exported.originOf('dsh-work-sync'), null)
checks.push('the origin reads both source shapes: source.sessionId and source.senderSessionId')

const titled = exported.sessionTitle({ byId: { s1: { displayTitle: '重构 work-sync' } } }, 's1')
assert.deepEqual(titled, { title: '重构 work-sync', known: true }, 'the header shows the Session title')
assert.deepEqual(exported.sessionTitle({ byId: { s1: { projectionValues: { subagent: { label: 'review-mcp-103' } } } } }, 's1'), { title: 'review-mcp-103', known: true }, 'a subagent falls back to its label')
assert.deepEqual(exported.sessionTitle({ byId: {} }, 'abcdef123456'), { title: 'abcdef12…', known: false }, 'an unloaded row shows a short id')
checks.push('the header resolves a title, a subagent label, or a short id')

const tZh = (key) => ({ originFrom: '来自「{name}」', originOpen: '打开来源会话', originSync: '进度同步', originAgent: '智能体消息' }[key] ?? key)
const known = exported.buildOriginLine({ source: { kind: 'dsh-work-sync', sessionId: 's1' }, t: tZh, openSession: () => {} }, { byId: { s1: { displayTitle: 'sync-engine' } } })
assert.equal(known.type, 'button', 'a known sender renders a button')
assert.equal(known.props['data-dsh-mcp-origin'], 's1')
assert.equal(collectText(known).join(''), '来自「sync-engine」·进度同步')
assert.equal(known.props.title, '打开来源会话')
checks.push('the header names the sender and the kind of delivery')

const opened = []
const clickable = exported.buildOriginLine({ source: { kind: 'dsh-mcp-server', sessionId: 's2' }, t: tZh, openSession: (id) => opened.push(id) }, { byId: { s2: { displayTitle: 'lead' } } })
let stopped = 0
clickable.props.onClick({ preventDefault: () => {}, stopPropagation: () => { stopped += 1 } })
assert.deepEqual(opened, ['s2'], 'clicking opens the sending Session')
assert.equal(stopped, 1, 'the click does not bubble into the bubble below')
checks.push('clicking the header opens the sending Session')

const unknown = exported.buildOriginLine({ source: { kind: 'agent-message', senderSessionId: 's3' }, t: tZh, openSession: () => assert.fail('must not open an unknown Session') }, { byId: {} })
assert.equal(unknown.type, 'span', 'an unloaded Session is not a dead click target')
assert.equal(collectText(unknown).join(''), '来自「s3」·智能体消息', 'the unknown row still says where it came from')
assert.equal(exported.buildOriginLine({ source: { kind: 'user' }, t: tZh }, { byId: {} }), null, 'a typed message renders no header')
checks.push('an unloaded sender still shows the short id, without a dead click')

// --- the settings route's Origin allowlist ------------------------------------
// A page served from another origin (the usual LAN + reverse-proxy setup) is a
// different *site* to the browser, so the Origin/Host comparison refuses it. The
// operator can name that origin; nothing else about the fence changes.
const LAN = 'http://192.168.50.216:23022'
// Mirrors index.js configTrust for a browser-shaped request: Origin must match Host.
const hostFence = (req) => {
  const origin = req.headers?.origin
  if (typeof origin !== 'string') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}
const makeServer = async (options) => {
  const srv = createServer((req, res) => {
    void createConfigHandler({
      snapshot: async () => ({ package: 'dsh-mcp-btwy', version: '0.9.0', exposeToDsh: true }),
      write: async () => {},
      trust: hostFence,
      ...options,
    })(req, res)
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  return { srv, base: `http://127.0.0.1:${srv.address().port}` }
}

const plain = await makeServer({})
const plainHit = await fetch(plain.base, { headers: { origin: LAN } })
assert.equal(plainHit.status, 403, 'absent allowedConfigOrigins the fence behaves exactly as before')
checks.push('absent allowedConfigOrigins the route is unchanged')

const allowed = await makeServer({ allowedOrigins: [LAN] })
const allowHit = await fetch(allowed.base, { headers: { origin: LAN } })
assert.equal(allowHit.status, 200, 'the operator-named origin reaches the settings route')
checks.push('an allowlisted Origin is admitted, loopback still required')

const allowMiss = await fetch(allowed.base, { headers: { origin: 'http://evil.example' } })
assert.equal(allowMiss.status, 403, 'any other Origin is still refused')
checks.push('an Origin outside the allowlist is refused')

const allowPost = await fetch(allowed.base, {
  method: 'POST',
  headers: { origin: LAN, 'content-type': 'application/json' },
  body: JSON.stringify({ syncOnStart: false }),
})
assert.equal(allowPost.status, 200, 'the allowlisted origin may also write')
checks.push('an allowlisted Origin may POST a patch too')

await new Promise((resolve) => plain.srv.close(resolve))
await new Promise((resolve) => allowed.srv.close(resolve))

await new Promise((resolve) => server.close(resolve))
console.log(`${checks.length} client half checks passed`)
for (const check of checks) console.log(`ok - ${check}`)