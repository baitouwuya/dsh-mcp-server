/**
 * Task-start progress sync as its own bundle row.
 *
 * The coordination behaviour is not part of exposing MCP: it is a small
 * service other rows (or a person) can switch, reload and reason about on its
 * own. The MCP server consults it through `ctx.get('workSync')` and reports it
 * in `dsh_status`; nothing else in that bundle depends on it.
 *
 * The engine itself lives in `lib/work-sync.js` and touches the Harness only
 * through `ctx.on('session/event')`; this entry wires the real services and
 * publishes the status/ask service.
 *
 * @module dsh-work-sync
 */

import { assistantTextOf } from './lib/dsh-contracts.js'
import { SYNC_MESSAGE_KIND, createInternalDelivery } from './lib/dsh-delivery.js'
import { createWorkSync } from './lib/work-sync.js'

/** This row's plugin name, as the profile's bundle row spells it. */
export const name = 'dsh-work-sync'

/** Defaults for the row config; the engine has the same defaults. */
const DEFAULTS = { enabled: true, cooldownMs: 5 * 60 * 1000, waitMs: 2 * 60 * 1000, maxPeers: 3 }

/** A non-negative whole number from configuration, or the default. */
function countSetting(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return fallback
  return Math.max(0, Math.min(max, Math.trunc(raw)))
}

/**
 * The session rows the engine reasons about: who is running, in which
 * workspace, and under which top-level agent.
 */
async function sessionRows(ctx) {
  const controller = ctx.get('sessionController')
  if (typeof controller?.list !== 'function') return []
  const listed = await controller.list({})
  const items = Array.isArray(listed?.items) ? listed.items : []
  return items.map((item) => ({
    sessionId: item.sessionId,
    running: item.running === true,
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
    ...(Number.isFinite(Number(item.updatedAt)) ? { updatedAt: Number(item.updatedAt) } : {}),
    ...(typeof item.parentSessionId === 'string' ? { parentSessionId: item.parentSessionId } : {}),
    ...(typeof item.origin === 'string' ? { origin: item.origin } : {}),
  }))
}

/**
 * Mount the progress-sync service.
 *
 * @param ctx - Cordis context of this row's fiber.
 * @param config - the row config: `syncOnStart`, `syncCooldownMs`,
 *   `syncWaitMs`, `syncMaxPeers`.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger?.('dsh-work-sync') ?? { info() {}, warn() {}, debug() {}, error() {} }
  const log = (level, message, detail) => {
    const sink = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info?.bind(logger)
    if (sink) sink(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`)
  }

  const settings = {
    enabled: config.syncOnStart !== false,
    cooldownMs: countSetting(config.syncCooldownMs, DEFAULTS.cooldownMs),
    waitMs: countSetting(config.syncWaitMs, DEFAULTS.waitMs),
    maxPeers: countSetting(config.syncMaxPeers, DEFAULTS.maxPeers, 32),
  }

  const delivery = createInternalDelivery({ ctx, logger: log, kind: SYNC_MESSAGE_KIND })
  const engine = createWorkSync({
    ctx,
    settings,
    logger: log,
    listSessions: () => sessionRows(ctx),
    deliver: (sessionId, message) => delivery.deliver(sessionId, message?.text, message?.meta),
    readAssistant: assistantTextOf,
    now: () => Date.now(),
  })

  const service = {
    /** The lossless snapshot `dsh_status.sync` republishes. */
    status: (sessionId) => engine.status(sessionId),
    /** Ask one session's peers for a progress report now. */
    ask: (sessionId, reason) => engine.ask(sessionId, reason),
    /** What this row is configured to do, for status readers. */
    config: { ...settings },
  }

  // A service, not a side-channel: another row can see whether sync is on and
  // what it is waiting on without importing this bundle. `provide` owns the
  // registration, so a reload or disable withdraws it with the fiber.
  try {
    ctx.provide('workSync', service)
  } catch (error) {
    log('warn', 'could not publish the workSync service', { error: String(error?.message ?? error) })
  }

  ctx.effect(() => {
    engine.start()
    return () => engine.dispose()
  }, 'dsh-work-sync: task-start progress sync')

  return service
}
