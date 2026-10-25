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
 * Every question names the session that asked it. A peer questioned by several
 * agents (each sub-agent asks its own root) and one asker re-asking the same
 * peer are different situations, and `status()` has to make them tellable
 * apart: `peersAsked` entries are `{ sessionId, peer, asker, at, turn? }`.
 *
 * Nothing here imports a DSH package, and the module owns no transport of its
 * own: `ctx.on('session/event', …)` is the only Harness surface it touches, and
 * the caller injects the session listing, the delivery, the transcript reader
 * and the clock.
 *
 * @module dsh-mcp-server/work-sync
 */

import { errorText, sessionIdOf, turnOfEvent } from './dsh-contracts.js'
import { SYNC_MESSAGE_KIND } from './dsh-delivery.js'

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

/** Recent questions kept for `status()`; the cooldown needs the tail of this. */
const HISTORY_LIMIT = 2000

/**
 * How long a delivery's mark may claim a turn.
 *
 * The mark exists so the turn this module's own message opens is not mistaken
 * for a task start. A message queued behind a long turn can open its turn much
 * later, so the mark expires instead of lying in wait for a real task start.
 */
const MARK_TTL_MS = 2 * 60 * 1000

/** Key separator for an (asker, peer) pair; a NUL never occurs in a session id. */
const PAIR_SEPARATOR = '\u0000'

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

  /** The live question per (asker, peer) pair. */
  const pending = new Map()
  /** Questions already asked, newest last, for `status()`. */
  const history = []
  /** Pair key -> when that pair was last asked, for the cooldown. */
  const lastAsked = new Map()
  /** Session -> deliveries that will open a turn, consumed by that session's next turn. */
  const syntheticTurns = new Map()
  /** Session -> the last turn number observed for it. */
  const lastTurn = new Map()
  /**
   * Session -> whether a turn of its own is currently open.
   *
   * A report only helps an asker that is still working: once its turn ends it
   * can no longer act on the answer, and delivering it anyway would start an
   * unrequested turn (or a timeout note) in a session its caller believed idle.
   */
  const turnOpen = new Map()
  /** Askers whose round is already running, so two overlaps cannot ask twice. */
  const roundsInFlight = new Set()
  /** Pairs reserved while a delivery is in flight, so a second round cannot race it. */
  const reservedPairs = new Set()
  /**
   * Asker -> the turn whose round already asked somebody.
   *
   * A task start asks once. A duplicated or replayed `turn/start` for the same
   * turn must not spend a second round on the same peers — not even when the
   * cooldown is switched off — while a genuinely new turn carries a new number
   * and is unaffected. Only a round that actually asked leaves a mark, so a
   * round that found nobody to ask can be retried.
   */
  const askedTurns = new Map()
  /** Reports handed back to their asker, as reported by `status()`. */
  let reports = 0
  /** Monotonic delivery token, so a refused delivery only clears its own mark. */
  let deliveryToken = 0
  /** Bumped by start()/dispose(); work captured under another generation stops. */
  let generation = 0
  /** Disposer of the `session/event` subscription, when one was returned. */
  let unsubscribe
  let started = false
  /** Set the moment dispose() runs, so work already in flight stops at its next await. */
  let disposed = false

  /** One delivery mark: how many synthetic turns this session still owes, and its token. */
  function bumpSynthetic(sessionId) {
    const token = ++deliveryToken
    const mark = syntheticTurns.get(sessionId)
    if (mark) {
      mark.count += 1
      mark.token = token
      mark.at = now()
    } else {
      syntheticTurns.set(sessionId, { count: 1, token, at: now() })
    }
    return token
  }

  /** Remove the mark one delivery made, but only while that delivery still owns it. */
  function dropSynthetic(sessionId, token) {
    const mark = syntheticTurns.get(sessionId)
    if (!mark || mark.token !== token) return
    mark.count -= 1
    if (mark.count <= 0) syntheticTurns.delete(sessionId)
  }

  /** Whether this turn is one a delivery opened; consuming the mark skips the round. */
  function consumeSynthetic(sessionId) {
    const mark = syntheticTurns.get(sessionId)
    if (!mark) return false
    if (now() - mark.at > MARK_TTL_MS) {
      syntheticTurns.delete(sessionId)
      return false
    }
    mark.count -= 1
    if (mark.count <= 0) syntheticTurns.delete(sessionId)
    return true
  }

  /** Mark the questions one peer has actually seen, from its own sourced message. */
  function claimPending(peerSessionId, source) {
    if (!source || source.kind !== SYNC_MESSAGE_KIND) return
    const asker = source.sessionId
    if (typeof asker !== 'string' || !asker) return
    const turn = lastTurn.get(peerSessionId)
    for (const entry of pending.values()) {
      if (entry.peer !== peerSessionId || entry.asker !== asker || entry.claimed) continue
      entry.claimed = true
      entry.claimTurn = Number.isFinite(turn) ? turn : undefined
    }
  }

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
    const seen = new Set()
    for (let hop = 0; hop < ROOT_HOP_CAP; hop += 1) {
      const row = byId.get(current)
      if (!row) return undefined
      // A fork is a top-level session that happens to carry a parent: only a
      // session the Harness marks as a subagent is answered for by an ancestor.
      if (row.origin !== undefined && row.origin !== 'subagent') return current
      const parent = row.parentSessionId
      if (typeof parent !== 'string' || !parent) return current
      if (seen.has(parent)) return undefined
      seen.add(parent)
      current = parent
    }
    // A lineage this deep is not trustworthy; ask nobody rather than accept an
    // intermediate ancestor as "the root".
    return undefined
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
    // A workspace is only ever equal to another when both sides recorded one.
    const sameWorkspace = (cwd) => typeof myCwd === 'string' && myCwd !== '' && cwd === myCwd
    if (!myRoot) return []
    if (myRoot !== asker) {
      // A sub-agent asks its root, and only when that root is working in the
      // same workspace: an unrecorded cwd is not evidence of one, and a root
      // that is not running must not be woken by a notice.
      const rootRow = byId.get(myRoot)
      if (rootRow?.running !== true) return []
      return sameWorkspace(rootRow.cwd) ? [myRoot] : []
    }
    if (typeof myCwd !== 'string' || !myCwd) return []
    /** root id -> the newest `updatedAt` among the running sessions below it. */
    const newest = new Map()
    for (const row of byId.values()) {
      if (row?.running !== true) continue
      if (row.sessionId === asker) continue
      const root = rootOf(row.sessionId, byId)
      if (!root || root === asker) continue
      // The session that gets questioned is the ROOT, so the root's own row is
      // what has to be running and in this workspace — a descendant's cwd says
      // nothing about where the agent being asked is working.
      const rootRow = byId.get(root)
      if (rootRow?.running !== true) continue
      if (rootRow.cwd !== myCwd) continue
      const updatedAt = Number.isFinite(rootRow.updatedAt) ? rootRow.updatedAt : 0
      const previous = newest.get(root)
      if (previous === undefined || updatedAt > previous) newest.set(root, updatedAt)
    }
    return [...newest.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id)
  }

  /** Whether `asker` already questioned `peer` inside the cooldown window. */
  function inCooldown(asker, peer, at) {
    const key = pairKey(asker, peer)
    const previous = lastAsked.get(key)
    if (previous === undefined) return false
    if (cooldownMs <= 0) return false
    if (at - previous < cooldownMs) return true
    lastAsked.delete(key)
    return false
  }

  /**
   * Hand one internal message to a session and mark the turn it will start.
   *
   * The mark is set *before* the delivery, because the turn it starts can begin
   * before this function resumes; a refused delivery takes its own mark back
   * again so a later real turn is not skipped for a message that never landed.
   */
  async function send(targetSessionId, text, syncRole, from) {
    if (disposed) return { accepted: false }
    // An event listener runs inside the session's commit; a delivery that
    // splices the inbox would be a nested append and is rejected there. One
    // microtask later the commit has closed.
    await Promise.resolve()
    const token = bumpSynthetic(targetSessionId)
    try {
      // `from` is the session the message comes from, so the transcript shows a
      // peer report as the peer's and a notice as the asking session's.
      const accepted = await deliver(targetSessionId, {
        text,
        meta: { sync: true, syncRole, ...(typeof from === 'string' && from ? { from } : {}) },
      })
      const refused = accepted === false
        || (accepted !== null && typeof accepted === 'object' && accepted.accepted === false)
      if (refused) {
        dropSynthetic(targetSessionId, token)
        logger('debug', 'work-sync delivery was refused', { targetSessionId, syncRole })
        return { accepted: false }
      }
      // A notice steered into a running turn starts no turn of its own, so its
      // mark must not linger and swallow that session's next real task start.
      const startsTurn = !(accepted !== null && typeof accepted === 'object' && accepted.startsTurn === false)
      if (!startsTurn) dropSynthetic(targetSessionId, token)
      // dispose() may have run while this delivery was in flight: the mark must
      // not outlive the engine that made it.
      if (disposed) {
        dropSynthetic(targetSessionId, token)
        return { accepted: false }
      }
      return { accepted: true, startsTurn }
    } catch (error) {
      dropSynthetic(targetSessionId, token)
      logger('warn', 'work-sync delivery failed', { targetSessionId, syncRole, error: errorText(error) })
      return { accepted: false }
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

  /**
   * Forget every question one asker can no longer use.
   *
   * Called when the asker's turn ends: the answer would arrive after the work
   * it was meant to influence, so the pair is dropped instead of leaving a
   * timer that would later wake a finished session with a timeout note.
   */
  function dropAsks(askerSessionId) {
    for (const [key, entry] of pending) {
      if (entry.asker !== askerSessionId) continue
      clearEntryTimer(entry)
      pending.delete(key)
    }
  }

  /** Drop one pair's deadline without delivering anything. */
  function clearEntryTimer(entry) {
    if (entry.timer === undefined) return
    try {
      clearTimeout(entry.timer)
    } catch (error) {
      logger('debug', 'work-sync timer clear failed', { error: errorText(error) })
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
    if (disposed || waitMs <= 0) return
    const timer = setTimeout(() => {
      expireDeadline(key).catch((error) => {
        logger('debug', 'work-sync deadline note failed', { error: errorText(error) })
      })
    }, waitMs)
    if (typeof timer?.unref === 'function') timer.unref()
    entry.timer = timer
  }

  /** Deliver the one note a peer's silence earns, then forget the pair. */
  async function expireDeadline(key) {
    if (disposed) return
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
   * listing is unusable, the turn already asked, or every candidate is cooling
   * down, already pending, or currently asking this very session.
   *
   * @param asker - the session starting a task.
   * @param reason - the caller's short reason, when it gave one.
   * @param turn - the turn the event reported, when it reported one; a turn
   *   asks at most once.
   */
  async function round(asker, reason, turn) {
    if (!enabled) return { asked: [], skipped: 'disabled' }
    if (disposed) return { asked: [], skipped: 'disposed' }
    // The same turn asking twice is exactly the duplicate this engine refuses:
    // a replayed turn/start is not a new task start, even with no cooldown.
    if (Number.isFinite(turn) && askedTurns.get(asker) === turn) {
      return { asked: [], skipped: 'same-turn' }
    }
    // The Harness does not await event listeners, so two turns starting back to
    // back can run two rounds at once. One round per asker at a time.
    if (roundsInFlight.has(asker)) return { asked: [], skipped: 'in-flight' }
    roundsInFlight.add(asker)
    const gen = generation
    try {
      let rows
      try {
        rows = await listSessions()
      } catch (error) {
        logger('debug', 'work-sync listing failed', { sessionId: asker, error: errorText(error) })
        return { asked: [], skipped: 'listing-failed' }
      }
      if (!Array.isArray(rows)) return { asked: [], skipped: 'listing-failed' }
      if (disposed || gen !== generation) return { asked: [], skipped: 'disposed' }

      const byId = new Map()
      for (const row of rows) {
        if (row && typeof row.sessionId === 'string' && row.sessionId) byId.set(row.sessionId, row)
      }
      const at = now()
      const asked = []
      for (const peer of peerCandidates(asker, rootOf(asker, byId), byId)) {
        if (disposed || gen !== generation) break
        // The cap counts peers actually asked, so a cooling-down candidate never
        // spends the round's quota.
        if (asked.length >= maxPeers) break
        if (peer === asker) continue
        if (inCooldown(asker, peer, at)) continue
        const key = pairKey(asker, peer)
        const reverse = pairKey(peer, asker)
        // One question per pair at a time, in one direction: never stack a second
        // notice, and never question a peer that is asking this session right now.
        // A reservation covers the delivery's own await, before `pending` exists.
        if (pending.has(key) || pending.has(reverse)) continue
        if (reservedPairs.has(key) || reservedPairs.has(reverse)) continue
        reservedPairs.add(key)
        try {
          const delivery = await send(peer, noticeText(asker), 'notice', asker)
          if (!delivery.accepted) continue
          const entry = {
            asker,
            peer,
            at,
            turn: Number.isFinite(turn) ? turn : undefined,
            timer: undefined,
            startsTurn: delivery.startsTurn !== false,
            claimed: false,
            claimTurn: undefined,
          }
          pending.set(key, entry)
          lastAsked.set(key, at)
          history.push({ asker, peer, at, ...(Number.isFinite(turn) ? { turn } : {}) })
          if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
          armDeadline(key, entry)
          asked.push(peer)
        } finally {
          reservedPairs.delete(key)
        }
      }
      if (asked.length > 0) {
        if (Number.isFinite(turn)) askedTurns.set(asker, turn)
        logger('debug', 'work-sync asked peers for a progress report', {
          sessionId: asker,
          peers: asked,
          ...(Number.isFinite(turn) ? { turn } : {}),
          ...(reason ? { reason } : {}),
        })
      }
      return { asked, skipped: undefined }
    } finally {
      roundsInFlight.delete(asker)
    }
  }

  /** Hand every asker waiting on this peer the text of one assistant message. */
  async function forwardReport(peer, event) {
    // A peer's report only exists once the peer has actually claimed the notice
    // in its own log; before that, an assistant message belongs to whatever it
    // was already doing. Claiming is observed as a sourced `user/message`.
    const waiting = pendingFor(peer)
      .filter((entry) => entry.claimed === true && entry.closing !== true)
    if (waiting.length === 0) return
    let text
    try {
      text = readAssistant(event)
    } catch (error) {
      logger('debug', 'work-sync could not read an assistant message', {
        sessionId: peer,
        error: errorText(error),
      })
      return
    }
    // An assistant message can be a tool call with no text; the report is only
    // ever what the peer actually said, so an empty one leaves the pair waiting.
    if (typeof text !== 'string' || !text.trim()) return
    const report = reportText(peer, text.trim())
    for (const entry of waiting) {
      const key = pairKey(entry.asker, entry.peer)
      // The asker's turn may have ended between the round and this answer (or
      // the round may have lost the race against that turn/end). Its report is
      // useless now, and delivering it would wake a session that is done.
      if (turnOpen.get(entry.asker) !== true) {
        pending.delete(key)
        clearEntryTimer(entry)
        continue
      }
      // Claim the pair before awaiting the delivery: a `turn/end` racing this
      // send must not also emit the "ended without a report" line.
      entry.closing = true
      pending.delete(key)
      clearEntryTimer(entry)
      const delivery = await send(entry.asker, report, 'report', peer)
      if (!delivery.accepted) {
        // Put the question back: a refused report delivery must leave it open
        // for the next answer, or for the deadline.
        entry.closing = false
        pending.set(key, entry)
        armDeadline(key, entry)
        continue
      }
      reports += 1
    }
  }

  /** Tell every asker that one peer's turn ended without answering. */
  async function noteTurnEnded(peer, turn) {
    for (const entry of pendingFor(peer)) {
      // Only a question the peer has actually seen can end unanswered, and only
      // the turn that claimed it (or a later one) is that question's turn.
      if (entry.claimed !== true) continue
      if (Number.isFinite(turn) && Number.isFinite(entry.claimTurn) && turn < entry.claimTurn) continue
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
        const turn = turnOfEvent(event)
        if (turn !== undefined) lastTurn.set(sessionId, turn)
        turnOpen.set(sessionId, true)
        // The turn a delivery opened belongs to the delivery, not to a task.
        if (consumeSynthetic(sessionId)) return
        // A queued notice the peer has not claimed yet owns the next turn even
        // when its mark was already spent (for example by a real prompt ahead).
        for (const entry of pending.values()) {
          if (entry.peer !== sessionId || entry.claimed === true) continue
          return
        }
        await round(sessionId, undefined, turn)
        return
      }
      if (event.type === 'user/message') {
        claimPending(sessionId, event.data?.source)
        return
      }
      if (event.type === 'assistant/message') {
        await forwardReport(sessionId, event)
        return
      }
      if (event.type === 'turn/end') {
        turnOpen.set(sessionId, false)
        // A finished asker can no longer use an answer, and a deadline note
        // would wake it: forget its questions before telling peers anything.
        dropAsks(sessionId)
        await noteTurnEnded(sessionId, turnOfEvent(event))
      }
    } catch (error) {
      logger('warn', 'work-sync event handling failed', { error: errorText(error) })
    }
  }

  /** Subscribe to the Harness event stream; calling it twice is a no-op. */
  function start() {
    if (started) return
    disposed = false
    generation += 1
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
          handled.catch((error) => logger('warn', 'work-sync event failed', { error: errorText(error) }))
        }
        return handled
      })
      if (typeof off === 'function') unsubscribe = off
    } catch (error) {
      started = false
      logger('warn', 'work-sync could not subscribe to session events', { error: errorText(error) })
    }
  }

  /** Unsubscribe, drop every deadline, and forget all round state. */
  function dispose() {
    started = false
    disposed = true
    generation += 1
    const off = unsubscribe
    unsubscribe = undefined
    if (typeof off === 'function') {
      try {
        off()
      } catch (error) {
        logger('debug', 'work-sync unsubscribe failed', { error: errorText(error) })
      }
    }
    for (const entry of pending.values()) clearEntryTimer(entry)
    pending.clear()
    history.length = 0
    lastAsked.clear()
    syntheticTurns.clear()
    lastTurn.clear()
    turnOpen.clear()
    roundsInFlight.clear()
    reservedPairs.clear()
    askedTurns.clear()
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
      .map((entry) => ({
        // `sessionId` is the peer, kept for readers written against the old
        // shape; `peer` and `asker` say the same thing in the pair vocabulary.
        sessionId: entry.peer,
        peer: entry.peer,
        asker: entry.asker,
        at: entry.at,
        ...(Number.isFinite(entry.turn) ? { turn: entry.turn } : {}),
      }))
    const waiting = [...pending.values()]
      .filter((entry) => scope === undefined || entry.asker === scope || entry.peer === scope)
      .map((entry) => ({
        asker: entry.asker,
        peer: entry.peer,
        at: entry.at,
        claimed: entry.claimed === true,
        ...(Number.isFinite(entry.turn) ? { turn: entry.turn } : {}),
        ...(entry.startsTurn === false ? { steered: true } : {}),
      }))
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
      if (outcome.skipped === 'disposed') return 'work-sync is stopping; nothing was asked'
      if (outcome.skipped === 'in-flight') return `work-sync is already asking for ${target}`
      if (outcome.asked.length === 0) {
        return `no same-workspace peer needed asking for ${target}${reasonText(reason)}`
      }
      return `asked ${outcome.asked.length} peer(s) of ${target}: ${outcome.asked.join(', ')}${reasonText(reason)}`
    } catch (error) {
      logger('warn', 'work-sync manual ask failed', { sessionId: target, error: errorText(error) })
      return `work-sync could not ask for ${target}: ${errorText(error)}`
    }
  }

  return { start, dispose, status, ask }
}
