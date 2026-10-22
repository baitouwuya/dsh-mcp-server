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
 * - Every `remindMs` the target is reminded about the same id. A reminder names
 *   only the id; the question is not repeated, which is why `get` exists.
 * - `answer` is the only way to settle a request, and only the addressed
 *   session may call it. That is what makes "must reply" mean something.
 * - A caller-side abort (a cancelled turn, a dropped HTTP request) or a
 *   timeout withdraws the request and tells the target to stop answering.
 *
 * Nothing here imports a DSH package: delivery, the running check and the clock
 * are injected, so the module is testable without a Harness process.
 *
 * @module dsh-mcp-server/questions
 */

import { randomUUID } from 'node:crypto'

import { errorText } from './dsh-contracts.js'
import { ERROR_CODES, McpError } from './protocol.js'

/** How often a target that is not running is reminded, unless a caller asks otherwise. */
export const DEFAULT_REMIND_MS = 60 * 1000

/** The shortest reminder interval a caller may pick. */
export const MIN_REMIND_MS = 5 * 1000

/** The longest reminder interval a caller may pick. */
export const MAX_REMIND_MS = 10 * 60 * 1000

/** The default wait: no deadline, matching "the turn cannot end without an answer". */
export const DEFAULT_TIMEOUT_MS = 0

/** The largest question accepted, in characters. */
export const MAX_QUESTION_CHARS = 32 * 1024

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

/** One line telling the target a request was withdrawn. */
function withdrawnText(entry) {
  return `【撤回 #${entry.id}】这个问题已经撤回，不需要再回答。`
}

/**
 * Build the must-reply request broker.
 *
 * @param options - the module's collaborators.
 * @param options.deliver - `async (sessionId, text, meta) => boolean | {accepted}`;
 *   hands one internal message to a session.
 * @param options.isRunning - `(sessionId) => boolean`; a running target is not
 *   reminded, so reminders never pile up behind a long turn.
 * @param options.canAnswer - `() => boolean`; whether the target has this
 *   endpoint's tools available at all (the answer path).
 * @param options.logger - `(level, message, detail?) => void`.
 * @param options.now - injectable clock, `() => number`.
 * @param options.minRemindMs - the shortest reminder interval (the capability
 *   layer keeps its own bound; tests pass a smaller one).
 * @param options.maxRemindMs - the longest reminder interval.
 * @returns `{ ask, answer, get, status, dispose }`.
 */
export function createQuestionBroker({
  deliver,
  isRunning = () => false,
  canAnswer = () => true,
  logger = () => {},
  now = () => Date.now(),
  minRemindMs = MIN_REMIND_MS,
  maxRemindMs = MAX_REMIND_MS,
} = {}) {
  /** id -> the live request. */
  const pending = new Map()
  /** Settled requests, newest last, for `get`. */
  const recent = []
  /** Monotonic id suffix, so two requests in one millisecond never collide. */
  let sequence = 0
  let disposed = false

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
    const settled = {
      ...entry,
      state,
      settledAt: now(),
      deferred: undefined,
      reminderTimer: undefined,
      deadlineTimer: undefined,
      abortListener: undefined,
    }
    recent.push(settled)
    pruneRecent()
  }

  /** Clear every timer a request owns. */
  function clearTimers(entry) {
    if (entry.reminderTimer !== undefined) {
      clearInterval(entry.reminderTimer)
      entry.reminderTimer = undefined
    }
    if (entry.deadlineTimer !== undefined) {
      clearTimeout(entry.deadlineTimer)
      entry.deadlineTimer = undefined
    }
    if (entry.abortListener && entry.signal) {
      try {
        entry.signal.removeEventListener('abort', entry.abortListener)
      } catch (error) {
        logger('debug', 'question abort listener removal failed', { error: errorText(error) })
      }
      entry.abortListener = undefined
    }
  }

  /** Send one message, reporting acceptance without throwing. */
  async function send(entry, text) {
    try {
      const result = await deliver(entry.target, text, {
        from: entry.asker.sessionId,
        ...(entry.asker.agentId ? { fromAgent: entry.asker.agentId } : {}),
        questionId: entry.id,
        mustReply: true,
      })
      return accepted(result)
    } catch (error) {
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

  /** Settle a request once: timers, table, recent list, then its promise. */
  function settle(entry, state, { payload, error, withdraw = false } = {}) {
    if (entry.state !== 'pending') return
    entry.state = state
    clearTimers(entry)
    pending.delete(entry.id)
    remember(entry, state)
    if (withdraw) withdrawQuietly(entry)
    const deferred = entry.deferred
    entry.deferred = undefined
    if (!deferred) return
    if (error) deferred.reject(error)
    else deferred.resolve(payload)
  }

  /** Arm the reminder cycle. Reminders never stack: one at a time, and none while running. */
  function armReminders(entry) {
    if (entry.remindMs <= 0) return
    const tick = async () => {
      if (entry.state !== 'pending' || entry.reminding) return
      if (isRunning(entry.target)) return
      entry.reminding = true
      try {
        if (await send(entry, reminderText(entry))) {
          entry.reminders += 1
          entry.failedReminders = 0
        } else {
          // A target that has disappeared cannot answer, and an endless wait
          // would only hold the asking turn open with no way out.
          entry.failedReminders += 1
          if (entry.failedReminders >= 5) {
            settle(entry, 'unreachable', {
              error: new McpError(
                ERROR_CODES.internalError,
                `Question \"${entry.id}\" could not be delivered to session \"${entry.target}\" after ${entry.failedReminders} reminders; the target may have been archived or closed.`,
              ),
              withdraw: false,
            })
          }
        }
      } finally {
        entry.reminding = false
      }
    }
    const timer = setInterval(() => { void tick() }, entry.remindMs)
    // A pending question must never hold the Harness process open by itself.
    timer.unref?.()
    entry.reminderTimer = timer
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
   * Resolves with the answer (or a `timedOut` result), rejects when the caller
   * aborts or the plugin stops. The returned promise is what keeps the asking
   * tool call — and therefore the asking turn — open until the target answers.
   *
   * @param request - `{ targetSessionId, question, from, remindMs, timeoutMs, signal }`.
   */
  async function ask({ targetSessionId, question, from = {}, remindMs, timeoutMs, signal } = {}) {
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
      remindMs: whole(remindMs, DEFAULT_REMIND_MS, minRemindMs, maxRemindMs),
      timeoutMs: whole(timeoutMs, DEFAULT_TIMEOUT_MS, 0, 24 * 60 * 60 * 1000),
      reminders: 0,
      failedReminders: 0,
      state: 'pending',
      answer: undefined,
      answeredAt: undefined,
      answeredBy: undefined,
      reminderTimer: undefined,
      deadlineTimer: undefined,
      reminding: false,
      signal: undefined,
      abortListener: undefined,
      deferred: undefined,
    }
    let resolveWait
    let rejectWait
    entry.deferred = {
      resolve: (value) => resolveWait(value),
      reject: (error) => rejectWait(error),
      promise: undefined,
    }
    const promise = new Promise((resolve, reject) => {
      resolveWait = resolve
      rejectWait = reject
    })
    entry.deferred.promise = promise

    pending.set(entry.id, entry)
    // The deadline covers the initial delivery too, but reminders start only
    // after the question itself landed: a reminder must never arrive first.
    armDeadline(entry)

    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        settle(entry, 'cancelled', {
          error: new McpError(ERROR_CODES.internalError, 'The question was cancelled before it was delivered.'),
          withdraw: false,
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
        withdraw: false,
      })
    } else if (entry.state === 'pending') {
      // The caller may have aborted or the deadline may have passed while the
      // delivery was in flight; a settled request must not leave a timer behind.
      armReminders(entry)
    }
    return promise
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
        `No must-reply question "${questionId}" is waiting. It may have been answered, withdrawn, or expired.`,
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
      ...(entry.state === 'pending' ? { nextReminderMs: entry.remindMs } : {}),
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
    return { pending: pending.size, settled: recent.length }
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

  return { ask, answer, get, status, dispose }
}
