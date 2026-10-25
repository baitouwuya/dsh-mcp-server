/**
 * Ask one DSH session a question that must be answered.
 *
 * The ordinary delivery path is one-way: this endpoint queues a message and the
 * target carries on. That is wrong for a question whose answer the caller needs
 * before it can continue, so this module keeps a small request table:
 *
 * - `ask` mints an id (`q-…`), hands the question to the target once, and stays
 *   pending until the target answers. The tool call that awaited it therefore
 *   never returns early: the asking turn cannot end before the answer.
 * - Reminders are not pushed. `onActivity` is called when the target is about
 *   to make a model call, and it injects the reminder into that call's context
 *   (the Harness's no-wake `inject` path). An idle or manually stopped session
 *   is never woken just to be reminded; the reminder rides whatever call the
 *   session makes next.
 * - A reminder names only the id; the question is not repeated, which is why
 *   `get` exists.
 * - `answer` is the only way to settle a request, and only the addressed
 *   session may call it. `onStopped` settles a request when a person stops the
 *   target, so a stop is never fought with another reminder or a new turn.
 *
 * Nothing here imports a DSH package: delivery, the stopped check and the clock
 * are injected, so the module is testable without a Harness process.
 *
 * @module dsh-mcp-server/questions
 */

import { randomUUID } from 'node:crypto'

import { errorText } from './dsh-contracts.js'
import { ERROR_CODES, McpError } from './protocol.js'

/** The default wait: no deadline, matching "the turn cannot end without an answer". */
export const DEFAULT_TIMEOUT_MS = 0

/** The largest question accepted, in characters. */
export const MAX_QUESTION_CHARS = 32 * 1024

/** How long two activity events count as the same call (turn/start and its first step). */
const ACTIVITY_DEDUPE_MS = 1000

/** How many settled requests stay readable through `get`. */
const RECENT_LIMIT = 200

/** How long a settled request stays readable, in milliseconds. */
const RECENT_TTL_MS = 60 * 60 * 1000

/** A whole number in range, or the fallback. */
function whole(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** Whether a delivery result means "accepted". */
function accepted(result) {
  if (result === false) return false
  if (result && typeof result === 'object' && result.accepted === false) return false
  return true
}

/** How a request's asker is named in the target's transcript. */
function askerLabel(entry) {
  const session = entry.asker.sessionId
  if (session) return `会话 ${session}`
  const name = entry.asker.name || 'MCP'
  return `外部调用方 ${name}`
}

/** The one message that carries the question itself. */
function initialText(entry) {
  return [
    `【必须回复 #${entry.id}】${askerLabel(entry)} 请你回答一个问题：`,
    entry.question,
    '',
    `回答方式：调用 dsh_answer_question，参数 {"id":"${entry.id}","answer":"..."}；工具还没打开时，用 dsh_mcp_call({"tool":"dsh_answer_question","arguments":{"id":"${entry.id}","answer":"..."}}) 调用它。`,
    `查看原问题：调用 dsh_get_question（或 dsh_mcp_call({"tool":"dsh_get_question","arguments":{"id":"${entry.id}"}})）。提醒消息只带编号，不会重复问题。`,
    '在你回答之前，这个请求不会结束。',
  ].join('\n')
}

/** A reminder: the id and the two ways to act on it, never the question again. */
function reminderText(entry) {
  return [
    `【提醒 #${entry.id}】${askerLabel(entry)} 的问题仍未回答。`,
    `请调用 dsh_answer_question 回答（{"id":"${entry.id}","answer":"..."}），或用 dsh_get_question 查看原问题；工具未打开时通过 dsh_mcp_call 调用。`,
  ].join('\n')
}

/** One line telling the target a request was withdrawn by its asker. */
function withdrawnText(entry) {
  return `【撤回 #${entry.id}】这个问题已经撤回，不需要再回答。`
}

/**
 * Build the must-reply request broker.
 *
 * @param options - the module's collaborators.
 * @param options.deliver - `async (sessionId, text, meta) => boolean | {accepted}`;
 *   `meta.inject === true` asks for the no-wake injection path.
 * @param options.isStopped - `(sessionId) => boolean`; a session a person stopped.
 * @param options.canAnswer - `() => boolean`; whether the target has this
 *   endpoint's tools available at all (the answer path).
 * @param options.logger - `(level, message, detail?) => void`.
 * @param options.now - injectable clock, `() => number`.
 * @param options.activityDedupeMs - one reminder per this window of activity.
 * @returns `{ ask, answer, get, onActivity, onStopped, status, dispose }`.
 */
export function createQuestionBroker({
  deliver,
  isStopped = () => false,
  canAnswer = () => true,
  logger = () => {},
  now = () => Date.now(),
  activityDedupeMs = ACTIVITY_DEDUPE_MS,
} = {}) {
  /** id -> the live request. */
  const pending = new Map()
  /** Settled requests, newest last, for `get`. */
  const recent = []
  /** Monotonic id suffix, so two requests in one millisecond never collide. */
  let sequence = 0
  let disposed = false
  /** How often activity events arrive and what happens to them, for dsh_status. */
  const activity = { calls: 0, injections: 0, failures: 0, lastFailure: undefined, byKind: {} }

  /** One fresh id; random plus a sequence makes a collision practically impossible. */
  function mintId() {
    sequence += 1
    return `q-${randomUUID().replace(/-/g, '').slice(0, 8)}-${sequence.toString(36)}`
  }

  /** Drop settled requests that are too old to keep. */
  function pruneRecent() {
    const cutoff = now() - RECENT_TTL_MS
    while (recent.length > 0 && recent[0].settledAt < cutoff) recent.shift()
    if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT)
  }

  /** Keep a settled request readable through `get`. */
  function remember(entry, state) {
    recent.push({
      ...entry,
      state,
      settledAt: now(),
      deferred: undefined,
      abortListener: undefined,
    })
    pruneRecent()
  }

  /** Remove the abort listener a live request owns. */
  function clearAbort(entry) {
    if (!entry.abortListener || !entry.signal) return
    try {
      entry.signal.removeEventListener('abort', entry.abortListener)
    } catch (error) {
      logger('debug', 'question abort listener removal failed', { error: errorText(error) })
    }
    entry.abortListener = undefined
  }

  /** Send one message, reporting acceptance without throwing. */
  async function send(entry, text, { inject = false } = {}) {
    // A session/event listener runs inside the session's commit, where a
    // nested append (the inbox splice an inject performs) is rejected. One
    // microtask later the commit has closed and the same call is legal.
    await Promise.resolve()
    const failed = (reason, detail) => {
      if (!inject) return false
      activity.failures += 1
      activity.lastFailure = reason
      if (typeof detail === 'string' && detail) activity.lastError = detail.slice(0, 240)
      logger('debug', 'question reminder was not injected', { id: entry.id, target: entry.target, reason, detail })
      return false
    }
    try {
      const result = await deliver(entry.target, text, {
        from: entry.asker.sessionId,
        ...(entry.asker.agentId ? { fromAgent: entry.asker.agentId } : {}),
        questionId: entry.id,
        mustReply: true,
        ...(inject ? { inject: true } : {}),
      })
      if (result === false) return failed('refused')
      if (result && typeof result === 'object' && result.accepted === false) {
        return failed(
          typeof result.reason === 'string' ? result.reason : 'refused',
          typeof result.error === 'string' ? result.error : undefined,
        )
      }
      return true
    } catch (error) {
      if (inject) {
        activity.failures += 1
        activity.lastFailure = 'threw'
      }
      logger('warn', 'question delivery failed', {
        id: entry.id,
        target: entry.target,
        error: errorText(error),
      })
      return false
    }
  }

  /** A best-effort note that a request will not need an answer. */
  function withdrawQuietly(entry) {
    if (disposed) return
    void send(entry, withdrawnText(entry)).catch(() => {})
  }

  /** Settle a request once: the table, the recent list, then its promise. */
  function settle(entry, state, { payload, error, withdraw = false } = {}) {
    if (entry.state !== 'pending') return
    entry.state = state
    clearAbort(entry)
    if (entry.deadlineTimer !== undefined) {
      clearTimeout(entry.deadlineTimer)
      entry.deadlineTimer = undefined
    }
    pending.delete(entry.id)
    remember(entry, state)
    if (withdraw) withdrawQuietly(entry)
    const deferred = entry.deferred
    entry.deferred = undefined
    if (!deferred) return
    if (error) deferred.reject(error)
    else deferred.resolve(payload)
  }

  /** Arm an optional deadline. Zero means "wait until cancelled or answered". */
  function armDeadline(entry) {
    if (entry.timeoutMs <= 0) return
    const timer = setTimeout(() => {
      settle(entry, 'timedOut', {
        payload: {
          id: entry.id,
          status: 'timedOut',
          sessionId: entry.target,
          question: entry.question,
          reminders: entry.reminders,
          waitedMs: now() - entry.askedAt,
          note: 'The target did not answer before the timeout; the request was withdrawn.',
        },
        withdraw: true,
      })
    }, entry.timeoutMs)
    timer.unref?.()
    entry.deadlineTimer = timer
  }

  /** Whether answering `target` would close a cycle back to `asker`. */
  function wouldDeadlock(askerSessionId, target) {
    if (!askerSessionId) return false
    let current = target
    const seen = new Set()
    while (typeof current === 'string' && current && !seen.has(current)) {
      if (current === askerSessionId) return true
      seen.add(current)
      const next = [...pending.values()].find((entry) => entry.asker.sessionId === current)
      current = next?.target
    }
    return false
  }

  /**
   * Ask one session a question and wait for its answer.
   *
   * Resolves with the answer (or a `timedOut` / `stopped` result), rejects when
   * the caller aborts or the plugin stops. The returned promise is what keeps
   * the asking tool call — and therefore the asking turn — open until the
   * target answers.
   *
   * @param request - `{ targetSessionId, question, from, timeoutMs, signal }`.
   */
  async function ask({ targetSessionId, question, from = {}, timeoutMs, signal } = {}) {
    if (disposed) throw new McpError(ERROR_CODES.internalError, 'The question service is stopping; nothing was asked.')
    const target = typeof targetSessionId === 'string' ? targetSessionId.trim() : ''
    if (!target) throw new McpError(ERROR_CODES.invalidParams, '"sessionId" is required.')
    const text = typeof question === 'string' ? question.trim() : ''
    if (!text) throw new McpError(ERROR_CODES.invalidParams, '"question" must not be empty.')
    if (text.length > MAX_QUESTION_CHARS) {
      throw new McpError(ERROR_CODES.invalidParams, `"question" is longer than ${MAX_QUESTION_CHARS} characters.`)
    }
    if (from && typeof from.sessionId === 'string' && from.sessionId === target) {
      throw new McpError(ERROR_CODES.invalidParams, 'A session cannot ask itself a must-reply question; just answer directly.')
    }
    if (!(canAnswer() === true)) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        'A must-reply question needs the target session to have this endpoint\'s tools, but the local DSH tool surface is off. Turn on "Let DSH use these tools itself" (exposeToDsh), or use dsh_continue_session instead.',
      )
    }
    if (isStopped(target)) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        `Session "${target}" was stopped by a human, so it will not be woken by a question. Resume it first, then ask again.`,
      )
    }
    if (wouldDeadlock(from?.sessionId, target)) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        `Asking "${target}" would deadlock: that session is already waiting on a must-reply question from you (directly or through other sessions).`,
      )
    }

    const entry = {
      id: mintId(),
      question: text,
      target,
      asker: {
        ...(typeof from?.sessionId === 'string' && from.sessionId ? { sessionId: from.sessionId } : {}),
        ...(typeof from?.agentId === 'string' && from.agentId ? { agentId: from.agentId } : {}),
        ...(typeof from?.name === 'string' && from.name ? { name: from.name } : {}),
      },
      askedAt: now(),
      timeoutMs: whole(timeoutMs, DEFAULT_TIMEOUT_MS, 0, 24 * 60 * 60 * 1000),
      reminders: 0,
      lastRemindedAt: Number.NEGATIVE_INFINITY,
      delivered: false,
      reminding: false,
      wantReminder: false,
      state: 'pending',
      answer: undefined,
      answeredAt: undefined,
      answeredBy: undefined,
      deadlineTimer: undefined,
      signal: undefined,
      abortListener: undefined,
      deferred: undefined,
    }
    let resolveWait
    let rejectWait
    entry.deferred = {
      resolve: (value) => resolveWait(value),
      reject: (error) => rejectWait(error),
    }
    const promise = new Promise((resolve, reject) => {
      resolveWait = resolve
      rejectWait = reject
    })

    pending.set(entry.id, entry)
    armDeadline(entry)

    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        settle(entry, 'cancelled', {
          error: new McpError(ERROR_CODES.internalError, 'The question was cancelled before it was delivered.'),
        })
        return promise
      }
      entry.signal = signal
      entry.abortListener = () => {
        settle(entry, 'cancelled', {
          error: new McpError(ERROR_CODES.internalError, 'The question was cancelled before the target answered.'),
          withdraw: true,
        })
      }
      signal.addEventListener('abort', entry.abortListener, { once: true })
    }

    const delivered = await send(entry, initialText(entry))
    if (!delivered) {
      settle(entry, 'undelivered', {
        error: new McpError(
          ERROR_CODES.internalError,
          `The question could not be delivered to session "${target}". Check that the session exists and is not archived.`,
        ),
      })
    } else if (entry.state === 'pending') {
      // A reminder may only ride a call after the question itself reached the
      // inbox; otherwise a busy target could be reminded about a question it
      // has not been handed yet.
      entry.delivered = true
      if (entry.wantReminder === true) {
        void injectReminder(entry).catch((error) => {
          logger('debug', 'deferred reminder failed', { id: entry.id, error: errorText(error) })
        })
      }
    }
    return promise
  }

  /**
   * Inject one reminder for one open request.
   *
   * The reminder is injected, not delivered as a turn-opening message, so an
   * idle or stopped session is never woken by it. Events closer together than
   * the dedupe window (a turn start and its first step, or a message and the
   * tool result after it) produce one reminder, not two.
   *
   * @param entry - the open request.
   * @param at - the activity timestamp.
   * @returns whether the target accepted the reminder.
   */
  async function injectReminder(entry, at = now()) {
    if (disposed || entry.state !== 'pending' || entry.delivered !== true || entry.reminding) return false
    if (isStopped(entry.target)) return false
    if (at - entry.lastRemindedAt < activityDedupeMs) return false
    entry.reminding = true
    try {
      if (!(await send(entry, reminderText(entry), { inject: true }))) return false
      if (entry.state !== 'pending') return false
      entry.reminders += 1
      entry.lastRemindedAt = at
      entry.wantReminder = false
      activity.injections += 1
      return true
    } finally {
      entry.reminding = false
    }
  }

  /**
   * A call the target is about to make: ride it with a reminder.
   *
   * Called for turn, step, assistant-message and tool-result events. If the
   * question has not landed yet, the request is remembered and the reminder is
   * sent right after delivery instead of being lost.
   *
   * @param sessionId - the session that is about to work.
   * @param kind - the event that asked, for diagnostics.
   */
  async function onActivity(sessionId, kind = 'step') {
    if (disposed || typeof sessionId !== 'string' || !sessionId) return
    activity.calls += 1
    activity.byKind[kind] = (activity.byKind[kind] ?? 0) + 1
    // Leave the session commit before injecting; see send().
    await Promise.resolve()
    if (isStopped(sessionId)) return
    const at = now()
    for (const entry of [...pending.values()]) {
      if (entry.target !== sessionId || entry.state !== 'pending') continue
      if (entry.delivered !== true) {
        entry.wantReminder = true
        continue
      }
      await injectReminder(entry, at)
    }
  }

  /**
   * End every open question addressed to a session a person stopped.
   *
   * Nothing is delivered to the stopped session: waking it is exactly what this
   * path exists to prevent. The asker gets a settled result instead of waiting
   * forever for an answer that will not come while the session is stopped.
   *
   * @param sessionId - the session that was stopped.
   */
  function onStopped(sessionId) {
    if (disposed || typeof sessionId !== 'string' || !sessionId) return
    for (const entry of [...pending.values()]) {
      if (entry.target !== sessionId) continue
      settle(entry, 'stopped', {
        payload: {
          id: entry.id,
          status: 'stopped',
          sessionId,
          question: entry.question,
          reminders: entry.reminders,
          waitedMs: now() - entry.askedAt,
          note: 'The target session was stopped by a human, so the question was withdrawn instead of waking it. Ask again after it is resumed.',
        },
      })
    }
  }

  /**
   * Record the addressed session's answer and release the asker.
   *
   * @param request - `{ id, answer, from }`; `from.sessionId` must equal the
   *   request's target.
   */
  function answer({ id, answer: text, from = {} } = {}) {
    if (disposed) throw new McpError(ERROR_CODES.internalError, 'The question service is stopping; the answer was not recorded.')
    const questionId = typeof id === 'string' ? id.trim() : ''
    if (!questionId) throw new McpError(ERROR_CODES.invalidParams, '"id" is required.')
    const body = typeof text === 'string' ? text.trim() : ''
    if (!body) throw new McpError(ERROR_CODES.invalidParams, '"answer" must not be empty.')
    const entry = pending.get(questionId)
    if (!entry) {
      pruneRecent()
      const settled = recent.find((item) => item.id === questionId)
      if (settled?.state === 'answered') {
        return {
          id: settled.id,
          status: 'answered',
          alreadyAnswered: true,
          asker: settled.asker.sessionId ?? settled.asker.name ?? null,
          answeredAt: new Date(settled.answeredAt ?? settled.settledAt).toISOString(),
          note: 'This question was already answered; the first answer stands.',
        }
      }
      throw new McpError(
        ERROR_CODES.invalidParams,
        `No must-reply question "${questionId}" is waiting. It may have been answered, withdrawn, stopped, or expired.`,
      )
    }
    const sessionId = typeof from?.sessionId === 'string' ? from.sessionId : ''
    if (!sessionId || sessionId !== entry.target) {
      throw new McpError(
        ERROR_CODES.invalidParams,
        `Only the addressed session ("${entry.target}") may answer question "${questionId}".`,
      )
    }
    entry.answer = body
    entry.answeredAt = now()
    entry.answeredBy = sessionId
    const payload = {
      id: entry.id,
      status: 'answered',
      sessionId: entry.target,
      question: entry.question,
      answer: body,
      answeredBy: sessionId,
      reminders: entry.reminders,
      waitedMs: entry.answeredAt - entry.askedAt,
    }
    settle(entry, 'answered', { payload })
    return payload
  }

  /** One request as the readable snapshot `dsh_get_question` returns. */
  function snapshot(entry) {
    return {
      id: entry.id,
      state: entry.state,
      sessionId: entry.target,
      question: entry.question,
      asker: entry.asker.sessionId ?? entry.asker.name ?? null,
      askedAt: new Date(entry.askedAt).toISOString(),
      reminders: entry.reminders,
      ...(entry.answer !== undefined ? { answer: entry.answer, answeredAt: new Date(entry.answeredAt).toISOString() } : {}),
    }
  }

  /** Read one request by id, pending or recently settled. */
  function get({ id } = {}) {
    const questionId = typeof id === 'string' ? id.trim() : ''
    if (!questionId) throw new McpError(ERROR_CODES.invalidParams, '"id" is required.')
    const entry = pending.get(questionId)
    if (entry) return snapshot(entry)
    pruneRecent()
    const settled = recent.find((item) => item.id === questionId)
    if (settled) return snapshot(settled)
    throw new McpError(ERROR_CODES.invalidParams, `No must-reply question "${questionId}" is known to this endpoint.`)
  }

  /** What `dsh_status.questions` reports. */
  function status() {
    return {
      pending: pending.size,
      settled: recent.length,
      activity: {
        calls: activity.calls,
        injections: activity.injections,
        failures: activity.failures,
        ...(activity.lastFailure === undefined ? {} : { lastFailure: activity.lastFailure }),
        ...(activity.lastError === undefined ? {} : { lastError: activity.lastError }),
        byKind: { ...activity.byKind },
      },
    }
  }

  /** Refuse every waiting caller and forget all state. */
  function dispose() {
    disposed = true
    for (const entry of [...pending.values()]) {
      settle(entry, 'cancelled', {
        error: new McpError(ERROR_CODES.internalError, 'The MCP endpoint stopped before the target answered.'),
      })
    }
    pending.clear()
    recent.length = 0
  }

  return { ask, answer, get, onActivity, onStopped, status, dispose }
}
