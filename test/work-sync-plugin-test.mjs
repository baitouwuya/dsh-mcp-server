/**
 * The work-sync bundle row, mounted on a fake Harness.
 *
 * The engine has its own suite; this one covers the row itself: the service it
 * publishes, the source kind its messages carry, and the switch in its config.
 * A host that installs the row (and nothing else) must get exactly one sync
 * service and no session-event surprises when the switch is off.
 */
import assert from 'node:assert/strict'

import { apply } from '../work-sync.js'

const checks = []

/** One mounted row, a fake Cordis context, and the messages it handed out. */
function mount({ config = {}, running = true } = {}) {
  const hooks = new Map()
  const provided = new Map()
  const delivered = []
  const disposers = []
  const handles = new Map()

  const rows = [
    { sessionId: 'asker', running, cwd: '/work', updatedAt: 10 },
    { sessionId: 'peer', running: true, cwd: '/work', updatedAt: 20 },
  ]

  const handle = (sessionId) => {
    if (!handles.has(sessionId)) {
      handles.set(sessionId, {
        status: 'running',
        steer: (message) => { delivered.push({ target: sessionId, mode: 'steer', message }) },
        followup: (message) => { delivered.push({ target: sessionId, mode: 'followup', message }) },
      })
    }
    return handles.get(sessionId)
  }

  const services = {
    sessionController: {
      list: async () => ({ items: rows }),
      resolveAgent: async (sessionId) => ({ agent: handle(sessionId) }),
    },
    agents: { get: (sessionId) => handle(sessionId) },
    configEditor: { entries: () => [{ options: { id: 'ui-conversation', config: { busyEnter: 'queue' } } }] },
  }

  const ctx = {
    get: (name) => services[name],
    on: (event, handler) => {
      hooks.set(event, handler)
      return () => hooks.delete(event)
    },
    effect: (create) => {
      const dispose = create()
      disposers.push(dispose)
      return dispose
    },
    // Cordis's `provide` owns an effect: disposing the fiber withdraws it. The
    // fake does the same, so the row's disposal contract is exercised.
    provide: (name, value) => {
      provided.set(name, value)
      const off = () => provided.delete(name)
      disposers.push(off)
      return off
    },
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
  }

  const service = apply(ctx, config)
  const fire = (sessionId, event) => hooks.get('session/event')?.({ id: sessionId, header: { id: sessionId, cwd: '/work' } }, event)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const dispose = () => { for (const fn of disposers.splice(0)) fn?.() }

  return { ctx, provided, delivered, rows, service, fire, settle, dispose, hooks }
}

// --- the published service ---------------------------------------------------
const mounted = mount()
assert.equal(typeof mounted.service?.status, 'function')
assert.equal(mounted.provided.get('workSync'), mounted.service, 'the row publishes the service it returns')
assert.deepEqual(mounted.service.config, { enabled: true, cooldownMs: 300000, waitMs: 120000, maxPeers: 3 })
checks.push('mounting the row publishes a workSync service with its config')

// --- one round ---------------------------------------------------------------
mounted.fire('asker', { type: 'turn/start', data: { turn: 1 } })
await mounted.settle()
assert.equal(mounted.delivered.length, 1, 'a starting task asks the other running root in its workspace')
const notice = mounted.delivered[0]
assert.equal(notice.target, 'peer')
assert.equal(notice.message.source.kind, 'dsh-work-sync', 'a sync notice is labelled with its own source kind')
assert.equal(notice.message.source.sessionId, 'asker')
assert.match(notice.message.content[0].text, /进度同步/)
checks.push('a notice is delivered with the work-sync source kind and the asking session')

mounted.fire('peer', { type: 'user/message', data: { turn: 1, source: { kind: 'dsh-work-sync', sessionId: 'asker' } } })
mounted.fire('peer', { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '我在改 /work/lib/x.js' }] } } })
await mounted.settle()
const report = mounted.delivered.at(-1)
assert.equal(report.target, 'asker')
assert.equal(report.message.source.sessionId, 'peer', 'the report names the session that sent it')
const status = mounted.service.status()
assert.equal(status.reports, 1)
assert.deepEqual(status.pending, [])
checks.push('a claimed answer comes back to the asker as one labelled report')

// --- the switch --------------------------------------------------------------
const off = mount({ config: { syncOnStart: false } })
off.fire('asker', { type: 'turn/start', data: { turn: 1 } })
await off.settle()
assert.deepEqual(off.delivered, [], 'with syncOnStart: false the row asks nobody')
assert.equal(off.service.config.enabled, false)
checks.push('syncOnStart: false turns the row off')

// --- disposal ----------------------------------------------------------------
const gone = mount()
gone.dispose()
assert.equal(gone.hooks.size, 0, 'disposing the row unsubscribes from session events')
assert.equal(gone.provided.size, 0, 'and withdraws its service')
checks.push('disposal unsubscribes and withdraws the service')

console.log(`${checks.length} work-sync plugin checks passed`)
for (const check of checks) console.log(`ok - ${check}`)
