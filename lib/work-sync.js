/**
 * Progress sync between agents that work in the same workspace.
 *
 * When a session starts a task, this module asks the other *root* agents in the
 * same working directory for a short progress report — what they are doing and
 * the absolute paths they are changing — and hands each answer back to the
 * starter once it arrives. The starter never waits: the notice is sent, the
 * round ends, and the report is delivered later as one internal message.
 *
 * Two rules from the user are absolute and are enforced here rather than
 * configured:
 *
 * - **Root only.** One session answers for its whole subtree, so only a
 *   top-level session is ever questioned. A sub-agent asks exactly its own
 *   root; it never queries its peers, and a root never questions its own
 *   descendants.
 * - **Same workspace only.** A peer whose recorded `cwd` differs is invisible,
 *   in both directions and for negotiation.
 *
 * A notice that produced a notice would be a storm, so every message this
 * module injects carries `meta { sync: true, syncRole }` and marks the turn it
 * starts. The next `turn/start` on that session consumes the mark and asks
 * nothing, which is what stops this module from talking to itself.
 *
 * Nothing here imports a DSH package, and the module owns no transport of its
 * own: `ctx.on('session/event', …)` is the only Harness surface it touches, and
 * the caller injects the session listing, the delivery, the transcript reader
 * and the clock.
 *
 * @module dsh-mcp-server/work-sync
 */

/** How far the lineage walk climbs before it accepts the ancestor it reached. */
const ROOT_HOP_CAP = 10

/** The switch's default: sync progress when a task starts. */
const DEFAULT_ENABLED = true

/** The default window in which one session never re-asks one peer. */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000

/** The default grace period for a peer's report. */
const DEFAULT_WAIT_MS = 2 * 60 * 1000

/** The default number of peers questioned in one round. */
const DEFAULT_MAX_PEERS = 3

/** Recent questions kept for `status()`; far more than any cooldown needs. */
const HISTORY_LIMIT = 200

/** Key separator for an (asker, peer) pair; a NUL never occurs in a session id. */
const PAIR_SEPARATOR = '\u0000'

/** Convert an arbitrary failure into a one-line log detail. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Read the session id out of the session a `session/event` hook was handed. */
function sessionIdOf(session) {
  const id = session?.id ?? session?.header?.id ?? session?.sessionId
  return typeof id === 'string' && id ? id : undefined
}

/** A whole, non-negative number from configuration, or the default. */
function countSetting(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback
}

/** The key one directed question is tracked under. */
function pairKey(asker, peer) {
  return `${asker}${PAIR_SEPARATOR}${peer}`
}

/** The parenthesised reason a manual `ask()` can carry, or an empty string. */
function reasonText(reason) {
  return typeof reason === 'string' && reason ? ` (${reason})` : ''
}

/**
 * Build the workspace progress-sync engine.
 *
 * @param options - the module's collaborators.
 * @param options.ctx - the plugin's Cordis context; only `ctx.on(...)` is used.
 * @param options.settings - `{ enabled, cooldownMs, waitMs, maxPeers }`. The
 *   spec'd defaults are applied here as well, and `enabled` must be exactly
 *   `true` (an absent value means the documented default, on).
 * @param options.logger - `(level, message, detail?) => void`, level in
 *   `info|warn|debug`.
 * @param options.listSessions - `async (signal?) => Array` of
 *   `{ sessionId, running, cwd, updatedAt, parentSessionId }`.
 * @param options.deliver - `async (targetSessionId, { text, meta }) => boolean`;
 *   injects one internal user message and reports whether it was accepted.
 * @param options.readAssistant - `(event) => string | undefined`; the text of
 *   one `assistant/message` event.
 * @param options.now - injectable clock, `() => number`.
 * @returns `{ start, dispose, status, ask }`.
 */
export function createWorkSync({
  ctx,
  settings = {},
  logger = () => {},
  listSessions,
  deliver,
  readAssistant,
  now = () => Date.now(),
} = {}) {
  const enabled = settings.enabled === undefined ? DEFAULT_ENABLED : settings.enabled === true
  const cooldownMs = countSetting(settings.cooldownMs, DEFAULT_COOLDOWN_MS)
  const waitMs = countSetting(settings.waitMs, DEFAULT_WAIT_MS)
  const maxPeers = countSetting(settings.maxPeers, DEFAULT_MAX_PEERS)

  /** The live question per (asker, peer) pair: `{ asker, peer, at, timer }`. */
  const pending = new Map()
  /** Questions already asked, newest last, for the cooldown and `status()`. */
  const history = []
  /** Session -> the mark one delivery made, consumed by that session's next turn. */
  const deliveredMarks = new Map()
  /** Reports handed back to their asker, as reported by `status()`. */
  let reports = 0
  /** Monotonic token, so a failed delivery only clears its own mark. */
  let deliveryToken = 0
  /** Disposer of the `session/event` subscription, when one was returned. */
  let unsubscribe
  let started = false

  /**
   * Walk `parentSessionId` to the top of one session's lineage.
   *
   * A session the listing does not know, an ancestor the listing does not know,
   * and a cycle all fall back to the session itself: an unknown root must never
   * be invented, and treating the session as its own root is the safe answer.
   * The hop cap only stops a pathological chain from spinning.
   */
  function rootOf(sessionId, byId) {
    if (!byId.has(sessionId)) return sessionId
    let current = sessionId
    const seen = new Set([sessionId])
    for (let hop = 0; hop < ROOT_HOP_CAP; hop += 1) {
      const row = byId.get(current)
      if (!row) return sessionId
      const parent = row.parentSessionId
      if (typeof parent !== 'string' || !parent) return current
      if (seen.has(parent)) return sessionId
      seen.add(parent)
      current = parent
    }
    return current
  }

  /**
   * The roots one session may question, newest activity first.
   *
   * A sub-agent has exactly one peer, its own top-level session. A top-level
   * session questions the other roots that have a running session in the same
   * recorded `cwd`, never itself, never its own descendants, and never a
   * session the listing places in another workspace. Without an own `cwd` a
   * root asks nobody at all: crossing workspaces is the one thing this feature
   * must never do, even by accident.
   */
  function peerCandidates(asker, myRoot, byId) {
    const myCwd = byId.get(asker)?.cwd
    if (myRoot !== asker) {
      const rootCwd = byId.get(myRoot)?.cwd
      const crossWorkspace = typeof myCwd === 'string' && myCwd
        && typeof rootCwd === 'string' && rootCwd && rootCwd !== myCwd
      return crossWorkspace ? [] : [myRoot]
    }
    if (typeof myCwd !== 'string' || !myCwd) return []
    /** root id -> the newest `updatedAt` among the running sessions below it. */
    const newest = new Map()
    for (const row of byId.values()) {
      if (row?.running !== true) continue
      if (row.sessionId === asker) continue
      const root = rootOf(row.sessionId, byId)
      if (root === asker) continue
      if (row.cwd !== myCwd) continue
      const updatedAt = Number.isFinite(row.updatedAt) ? row.updatedAt : 0
      const previous = newest.get(root)
      if (previous === undefined || updatedAt > previous) newest.set(root, updatedAt)
    }
    return [...newest.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id)
  }

  /** Whether `asker` already questioned `peer` inside the cooldown window. */
  function inCooldown(asker, peer, at) {
    if (cooldownMs <= 0) return false
    return history.some(
      (entry) => entry.asker === asker && entry.peer === peer && at - entry.at < cooldownMs,
    )
  }

  /**
   * Hand one internal message to a session and mark the turn it will start.
   *
   * The mark is set *before* the delivery, because the turn it starts can begin
   * before this function resumes; a refused delivery takes its own mark back
   * again so a later real turn is not skipped for a message that never landed.
   */
  async function send(targetSessionId, text, syncRole, from) {
    deliveryToken += 1
    const mark = { syncRole, token: deliveryToken }
    deliveredMarks.set(targetSessionId, mark)
    try {
      // `from` is the session the message comes from, so the transcript shows a
      // peer report as the peer's and a notice as the asking session's.
      const accepted = await deliver(targetSessionId, {
        text,
        meta: { sync: true, syncRole, ...(typeof from === 'string' && from ? { from } : {}) },
      })
      if (accepted === false) {
        if (deliveredMarks.get(targetSessionId) === mark) deliveredMarks.delete(targetSessionId)
        logger('debug', 'work-sync delivery was refused', { targetSessionId, syncRole })
        return false
      }
      return true
    } catch (error) {
      if (deliveredMarks.get(targetSessionId) === mark) deliveredMarks.delete(targetSessionId)
      logger('warn', 'work-sync delivery failed', { targetSessionId, syncRole, error: messageOf(error) })
      return false
    }
  }

  /** The short notice one peer receives: three sentences, never a task. */
  function noticeText(asker) {
    return [
      `【进度同步】会话 ${asker} 刚开始一项任务，想先同步一下彼此的工作。`,
      '请用 2-3 句话说明：你（以及你的子代理）正在做什么，正在改动或可能改动哪些文件的绝对路径，以及大致的先后顺序。',
      '这只是一次进度同步，不要因此中断或放弃你当前的任务；直接在正常回复里简要回答即可。',
    ].join('\n')
  }

  /** One peer's answer, wrapped in the instruction that makes it useful. */
  function reportText(peer, text) {
    return [
      `【进度同步】会话 ${peer} 的进度报告如下：`,
      '',
      text,
      '',
      '请据此调整你的执行顺序，避免文件冲突；如果发现工作重复或存在冲突，请先与该会话协商再继续。',
    ].join('\n')
  }

  /** One line telling the asker a peer's turn ended without a report. */
  function turnEndedText(peer) {
    return `【进度同步】会话 ${peer} 的回合已经结束，但没有给出进度报告。`
  }

  /** One line telling the asker a peer is still working with no report yet. */
  function timeoutText(peer) {
    return `【进度同步】会话 ${peer} 仍在处理中，暂时还没有进度报告。`
  }

  /** Every question still waiting on one peer's report. */
  function pendingFor(peer) {
    const waiting = []
    for (const entry of pending.values()) if (entry.peer === peer) waiting.push(entry)
    return waiting
  }

  /** Drop one pair's deadline without delivering anything. */
  function clearEntryTimer(entry) {
    if (entry.timer === undefined) return
    try {
      clearTimeout(entry.timer)
    } catch (error) {
      logger('debug', 'work-sync timer clear failed', { error: messageOf(error) })
    }
    entry.timer = undefined
  }

  /**
   * Arm one pair's report deadline.
   *
   * Every timer is unref'd: a waiting deadline must never hold the Harness
   * process open. A `waitMs` of zero disables the note entirely.
   */
  function armDeadline(key, entry) {
    if (waitMs <= 0) return
    const timer = setTimeout(() => {
      expireDeadline(key).catch((error) => {
        logger('debug', 'work-sync deadline note failed', { error: messageOf(error) })
      })
    }, waitMs)
    if (typeof timer?.unref === 'function') timer.unref()
    entry.timer = timer
  }

  /** Deliver the one note a peer's silence earns, then forget the pair. */
  async function expireDeadline(key) {
    const entry = pending.get(key)
    if (!entry) return
    pending.delete(key)
    await send(entry.asker, timeoutText(entry.peer), 'notice', entry.peer)
  }

  /**
   * Run one asking round for one session.
   *
   * Returns `{ asked, skipped }`; the event handler ignores both and `ask()`
   * turns them into words. Nothing at all happens when the switch is off, the
   * listing is unusable, or every candidate is cooling down, already pending, or
   * currently asking this very session.
   */
  async function round(asker, reason) {
    if (!enabled) return { asked: [], skipped: 'disabled' }
    let rows
    try {
      rows = await listSessions()
    } catch (error) {
      logger('debug', 'work-sync listing failed', { sessionId: asker, error: messageOf(error) })
      return { asked: [], skipped: 'listing-failed' }
    }
    if (!Array.isArray(rows)) return { asked: [], skipped: 'listing-failed' }

    const byId = new Map()
    for (const row of rows) {
      if (row && typeof row.sessionId === 'string' && row.sessionId) byId.set(row.sessionId, row)
    }
    const at = now()
    const asked = []
    for (const peer of peerCandidates(asker, rootOf(asker, byId), byId)) {
      // The cap counts peers actually asked, so a cooling-down candidate never
      // spends the round's quota.
      if (asked.length >= maxPeers) break
      if (peer === asker) continue
      if (inCooldown(asker, peer, at)) continue
      const key = pairKey(asker, peer)
      // One question per pair at a time, in one direction: never stack a second
      // notice, and never question a peer that is asking this session right now.
      if (pending.has(key) || pending.has(pairKey(peer, asker))) continue
      const accepted = await send(peer, noticeText(asker), 'notice', asker)
      if (!accepted) continue
      const entry = { asker, peer, at, timer: undefined }
      pending.set(key, entry)
      history.push({ asker, peer, at })
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
      armDeadline(key, entry)
      asked.push(peer)
    }
    if (asked.length > 0) {
      logger('debug', 'work-sync asked peers for a progress report', {
        sessionId: asker,
        peers: asked,
        ...(reason ? { reason } : {}),
      })
    }
    return { asked, skipped: undefined }
  }

  /** Hand every asker waiting on this peer the text of one assistant message. */
  async function forwardReport(peer, event) {
    const waiting = pendingFor(peer)
    if (waiting.length === 0) return
    let text
    try {
      text = readAssistant(event)
    } catch (error) {
      logger('debug', 'work-sync could not read an assistant message', {
        sessionId: peer,
        error: messageOf(error),
      })
      return
    }
    // An assistant message can be a tool call with no text; the report is only
    // ever what the peer actually said, so an empty one leaves the pair waiting.
    if (typeof text !== 'string' || !text.trim()) return
    const report = reportText(peer, text.trim())
    for (const entry of waiting) {
      pending.delete(pairKey(entry.asker, entry.peer))
      clearEntryTimer(entry)
      if (await send(entry.asker, report, 'report', peer)) reports += 1
    }
  }

  /** Tell every asker that one peer's turn ended without answering. */
  async function noteTurnEnded(peer) {
    for (const entry of pendingFor(peer)) {
      pending.delete(pairKey(entry.asker, entry.peer))
      clearEntryTimer(entry)
      await send(entry.asker, turnEndedText(peer), 'notice', peer)
    }
  }

  /**
   * Handle one `session/event`.
   *
   * This is the storm surface, so it never throws at the Harness and it consumes
   * the mark one of its own deliveries left behind: the turn a notice or report
   * started is skipped, and that is what keeps a notice from producing a notice.
   */
  async function onSessionEvent(session, event) {
    try {
      const sessionId = sessionIdOf(session)
      if (!sessionId || typeof event?.type !== 'string') return
      if (event.type === 'turn/start') {
        if (deliveredMarks.has(sessionId)) {
          deliveredMarks.delete(sessionId)
          return
        }
        await round(sessionId, undefined)
        return
      }
      if (event.type === 'assistant/message') {
        await forwardReport(sessionId, event)
        return
      }
      if (event.type === 'turn/end') await noteTurnEnded(sessionId)
    } catch (error) {
      logger('warn', 'work-sync event handling failed', { error: messageOf(error) })
    }
  }

  /** Subscribe to the Harness event stream; calling it twice is a no-op. */
  function start() {
    if (started) return
    if (typeof ctx?.on !== 'function') {
      logger('warn', 'work-sync could not subscribe: ctx.on is unavailable')
      return
    }
    started = true
    try {
      const off = ctx.on('session/event', (session, event) => {
        const handled = onSessionEvent(session, event)
        // The handler reports its own failures; this is the last line of defence
        // against an unhandled rejection if the logger itself misbehaves.
        if (handled && typeof handled.catch === 'function') {
          handled.catch((error) => logger('warn', 'work-sync event failed', { error: messageOf(error) }))
        }
        return handled
      })
      if (typeof off === 'function') unsubscribe = off
    } catch (error) {
      started = false
      logger('warn', 'work-sync could not subscribe to session events', { error: messageOf(error) })
    }
  }

  /** Unsubscribe, drop every deadline, and forget all round state. */
  function dispose() {
    started = false
    const off = unsubscribe
    unsubscribe = undefined
    if (typeof off === 'function') {
      try {
        off()
      } catch (error) {
        logger('debug', 'work-sync unsubscribe failed', { error: messageOf(error) })
      }
    }
    for (const entry of pending.values()) clearEntryTimer(entry)
    pending.clear()
    history.length = 0
    deliveredMarks.clear()
  }

  /**
   * One lossless snapshot of what this module knows.
   *
   * Passing a session id narrows the view to that session: the peers it asked,
   * the questions it has open (either direction), and its reports. Every member
   * is JSON-safe, so a caller can serialize the result as-is.
   */
  function status(sessionId) {
    const scope = typeof sessionId === 'string' && sessionId ? sessionId : undefined
    const peersAsked = history
      .filter((entry) => scope === undefined || entry.asker === scope)
      .map((entry) => ({ sessionId: entry.peer, at: entry.at }))
    const waiting = [...pending.values()]
      .filter((entry) => scope === undefined || entry.asker === scope || entry.peer === scope)
      .map((entry) => ({ asker: entry.asker, peer: entry.peer, at: entry.at }))
    return { enabled, peersAsked, pending: waiting, reports }
  }

  /**
   * Run one asking round now and describe, in plain words, what it asked.
   *
   * The same rules as an automatic round apply, including the switch, the
   * cooldown and the one-question-per-pair rule.
   */
  async function ask(sessionId, reason) {
    const target = typeof sessionId === 'string' && sessionId ? sessionId : undefined
    if (!target) return 'work-sync: no session was named, so nothing was asked'
    try {
      const outcome = await round(target, reason)
      if (outcome.skipped === 'disabled') return 'work-sync is off; nothing was asked'
      if (outcome.skipped === 'listing-failed') {
        return `work-sync could not list sessions; nothing was asked for ${target}`
      }
      if (outcome.asked.length === 0) {
        return `no same-workspace peer needed asking for ${target}${reasonText(reason)}`
      }
      return `asked ${outcome.asked.length} peer(s) of ${target}: ${outcome.asked.join(', ')}${reasonText(reason)}`
    } catch (error) {
      logger('warn', 'work-sync manual ask failed', { sessionId: target, error: messageOf(error) })
      return `work-sync could not ask for ${target}: ${messageOf(error)}`
    }
  }

  return { start, dispose, status, ask }
}
