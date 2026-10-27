/**
 * User decisions crossing the MCP boundary: the fold that reads pending
 * approvals and questions out of a session log, and the parking/answering
 * machinery that lets an MCP caller settle one.
 *
 * The fold itself is pure. Everything live — the session log, the owning
 * clients, and the Cordis context that carries the Harness request hooks — is
 * injected through `createRequestHelpers`, so this module never reaches for a
 * DSH service itself.
 *
 * @module dsh-mcp-server/capabilities/requests
 */

import { errorText } from '../dsh-contracts.js'

/** The Harness tool whose calls become user questions. */
const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/** Characters of an approval reason kept in a listing; the rest is elided. */
export const REQUEST_REASON_CHARS = 240

/** How long an approval or question waits for an MCP answer before failing closed. */
export const DEFAULT_REQUEST_ANSWER_TIMEOUT_MS = 10 * 60 * 1000

/** Elide a long approval reason so a listing stays readable. */
function truncateReason(reason, chars = REQUEST_REASON_CHARS) {
  if (typeof reason !== 'string') return undefined
  return reason.length > chars ? reason.slice(0, chars) + '…' : reason
}

/** Parse one recorded `ask_user_question` argument text into service-shaped questions. */
function questionsOf(argumentsValue) {
  let parsed
  try {
    parsed = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue
  } catch {
    return undefined
  }
  const list = Array.isArray(parsed?.questions) ? parsed.questions : undefined
  if (!list) return undefined
  const rows = []
  for (const question of list) {
    if (!question || typeof question.id !== 'string' || typeof question.question !== 'string') continue
    rows.push({
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(Array.isArray(question.options)
        ? {
          options: question.options
            .filter((option) => option && typeof option.label === 'string')
            .map((option) => ({
              label: option.label,
              ...(typeof option.description === 'string' ? { description: option.description } : {}),
            })),
        }
        : {}),
      ...(question.multi_select === true ? { multiSelect: true } : {}),
    })
  }
  return rows.length ? rows : undefined
}

/** First JSON text block of a recorded content array, parsed; `undefined` when unreadable. */
function parsedResult(content) {
  const blocks = Array.isArray(content) ? content : []
  const text = blocks.find((block) => block?.type === 'text')
  if (!text || typeof text.text !== 'string') return undefined
  try {
    return JSON.parse(text.text)
  } catch {
    return undefined
  }
}

/**
 * Fold a session log into the user decisions it is waiting on.
 *
 * Approvals come from the `approval/asked` / `approval/decided` audit pair; questions
 * from `ask_user_question` calls that no answer batch, error, or late reply has settled
 * yet. These are the same events the Harness GUI folds into its cards — and exactly the
 * ones the model never sees, which is why a delegated session can look stuck.
 *
 * @param events - session log events in append order.
 * @param options - `{ includeSettled, reasonChars }`.
 */
export function foldUserRequests(events, { includeSettled = false, reasonChars = REQUEST_REASON_CHARS } = {}) {
  const approvals = new Map()
  const questions = new Map()
  const settledApprovals = []
  const settledQuestions = []
  for (const event of events ?? []) {
    const data = event?.data ?? {}
    if (event?.type === 'approval/asked') {
      if (typeof data.id !== 'string') continue
      approvals.set(data.id, {
        id: data.id,
        ...(typeof data.toolName === 'string' ? { toolName: data.toolName } : {}),
        ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
        ...(typeof data.reason === 'string' ? { reason: truncateReason(data.reason, reasonChars) } : {}),
        seq: Number(event.seq),
      })
      continue
    }
    if (event?.type === 'approval/decided') {
      if (typeof data.id !== 'string') continue
      const asked = approvals.get(data.id)
      approvals.delete(data.id)
      if (includeSettled) {
        settledApprovals.push({
          id: data.id,
          ...(typeof data.outcome === 'string' ? { outcome: data.outcome } : {}),
          ...(asked?.toolName ? { toolName: asked.toolName } : {}),
          seq: Number(event.seq),
        })
      }
      continue
    }
    if (event?.type === 'tool/call' && data.name === ASK_USER_QUESTION_TOOL) {
      const questionsOfCall = questionsOf(data.arguments)
      if (!questionsOfCall || typeof data.callId !== 'string') continue
      questions.set(data.callId, {
        callId: data.callId,
        state: 'open',
        questions: questionsOfCall,
        seq: Number(event.seq),
      })
      continue
    }
    // PTC agents reach the tool through their own dispatcher, which logs a *start*
    // before any answer exists: that start is the only durable trace of a question
    // still blocking the turn, so it has to open the entry.
    if (event?.type === 'tool/ptc-dispatch-start' && data.name === ASK_USER_QUESTION_TOOL) {
      const callId = typeof data.subCallId === 'string' ? data.subCallId : undefined
      const questionsOfCall = questionsOf(data.arguments)
      if (!callId || !questionsOfCall) continue
      questions.set(callId, { callId, state: 'open', questions: questionsOfCall, seq: Number(event.seq) })
      continue
    }
    if (event?.type === 'tool/ptc-dispatch' && data.name === ASK_USER_QUESTION_TOOL) {
      const callId = typeof data.subCallId === 'string' ? data.subCallId : undefined
      const open = callId ? questions.get(callId) : undefined
      const parsed = parsedResult(data.content)
      const questionsOfCall = open?.questions ?? questionsOf(data.arguments)
      if (parsed?.pending === true) {
        if (callId && questionsOfCall) {
          questions.set(callId, { callId, state: 'continued', questions: questionsOfCall, seq: Number(event.seq) })
        }
        continue
      }
      if (!callId || !open) continue
      const answers = data.isError !== true && Array.isArray(parsed?.answers) ? parsed.answers : undefined
      questions.delete(callId)
      if (includeSettled && answers) settledQuestions.push({ callId, answers, seq: Number(event.seq) })
      continue
    }
    if (event?.type === 'tool/result') {
      const callId = data.message?.toolCallId
      const open = typeof callId === 'string' ? questions.get(callId) : undefined
      if (!open) continue
      const parsed = parsedResult(data.message?.content)
      if (parsed?.pending === true || data.error?.code === 'TOOL_OUTCOME_UNKNOWN') {
        questions.set(callId, { ...open, state: 'continued' })
        continue
      }
      const answers = data.error === undefined && data.message?.isError !== true && Array.isArray(parsed?.answers)
        ? parsed.answers
        : undefined
      questions.delete(callId)
      if (includeSettled && answers) settledQuestions.push({ callId, answers, seq: Number(event.seq) })
      continue
    }
    if (event?.type === 'user/message' && data.source?.kind === 'user-question-reply') {
      const callId = data.source?.callId
      if (typeof callId !== 'string' || !questions.has(callId)) continue
      const parsed = parsedResult(data.content)
      const answers = Array.isArray(parsed?.answers) ? parsed.answers : []
      questions.delete(callId)
      if (includeSettled) settledQuestions.push({ callId, answers, seq: Number(event.seq) })
    }
  }
  return {
    approvals: [...approvals.values()],
    questions: [...questions.values()],
    ...(includeSettled ? { settled: { approvals: settledApprovals, questions: settledQuestions } } : {}),
  }
}

/** Compact pending-decision summary for read/wait payloads. */
export function pendingSummary(requests) {
  return {
    count: requests.approvals.length + requests.questions.length,
    ...(requests.approvals.length ? { approvals: requests.approvals } : {}),
    ...(requests.questions.length ? { questions: requests.questions } : {}),
  }
}

/**
 * Build the helpers that read and settle user decisions for one capability
 * instance.
 *
 * @param ctx - Cordis context of the plugin fiber.
 * @param logger - plugin logger (`(level, message, detail)`).
 * @param sessionMessages - `(sessionId) => Promise<{ events }>`, the session log.
 * @param sessionOwners - client/ownership registry, when the deployment keeps one.
 * @param answerUserRequests - the legacy umbrella switch.
 * @param answerApprovals - whether this endpoint may settle approvals.
 * @param answerQuestions - whether this endpoint may answer user questions.
 * @param requestAnswerTimeoutMs - answer ceiling for one parked request.
 * @param answerOwnedSessionsOnly - answer only sessions an MCP caller owns.
 * @returns the parked registry plus the helpers `dsh_answer_request` relies on.
 */
export function createRequestHelpers({
  ctx,
  logger = () => {},
  sessionMessages,
  sessionOwners,
  answerUserRequests = false,
  answerApprovals = answerUserRequests,
  answerQuestions = answerUserRequests,
  requestAnswerTimeoutMs = DEFAULT_REQUEST_ANSWER_TIMEOUT_MS,
  answerOwnedSessionsOnly = true,
}) {
  /** Requests parked for an MCP caller to answer, keyed by the id `dsh_list_requests` reports. */
  const parkedRequests = new Map()

  /** Close out one parked request; resolves its promise and clears the timer. */
  function releaseParked(entry, value) {
    if (!entry || entry.settled) return
    entry.settled = true
    if (entry.timer) clearTimeout(entry.timer)
    parkedRequests.delete(entry.id)
    entry.resolve(value)
  }

  /**
   * Park one live user request until an MCP caller answers it.
   *
   * The entry stays visible to `dsh_list_requests` (which marks it `answerable`) for
   * as long as the turn is blocked on it, and is released by `dsh_answer_request`, by
   * the request's own abort signal, or by the answer ceiling.
   */
  function parkRequest(entry, { signal } = {}) {
    const parked = { ...entry, settled: false, createdAt: Date.now() }
    parked.promise = new Promise((resolve) => { parked.resolve = resolve })
    parked.timer = setTimeout(() => releaseParked(parked, undefined), Math.max(1000, requestAnswerTimeoutMs))
    parked.timer.unref?.()
    if (signal) {
      const onAbort = () => releaseParked(parked, undefined)
      signal.addEventListener('abort', onAbort, { once: true })
      parked.cleanup = () => signal.removeEventListener('abort', onAbort)
    }
    parkedRequests.set(entry.id, parked)
    return parked
  }

  /** Pending parked requests, newest first, for listings. */
  function parkedList() {
    return [...parkedRequests.values()].sort((left, right) => right.createdAt - left.createdAt)
  }

  /** The audit id of the newest undecided `approval/asked` for one tool call. */
  async function approvalIdFor(sessionId, callId) {
    if (!callId) return undefined
    try {
      const { events } = await sessionMessages(sessionId)
      const folded = foldUserRequests(events)
      return folded.approvals.find((row) => row.callId === callId)?.id
    } catch (error) {
      logger('debug', 'could not resolve the approval id', { sessionId, error: errorText(error) })
      return undefined
    }
  }

  /** The durable id of the newest unanswered user question in one session. */
  async function questionIdFor(sessionId) {
    try {
      const { events } = await sessionMessages(sessionId)
      const folded = foldUserRequests(events)
      return folded.questions[folded.questions.length - 1]?.callId
    } catch (error) {
      logger('debug', 'could not resolve the question id', { sessionId, error: errorText(error) })
      return undefined
    }
  }

  /**
   * Whether this endpoint answers a request for that session.
   *
   * By default only sessions an MCP caller created (or adopted) are answered, so the
   * GUI keeps every other card; `answerOwnedSessionsOnly: false` takes them all.
   */
  function answersSession(sessionId) {
    if (!answerOwnedSessionsOnly) return true
    return Boolean(sessionId && sessionOwners?.ownerOf(sessionId))
  }

  /** Park an approval request and race it against the deployment's other answerers. */
  async function answerApproval(request, next) {
    const sessionId = request?.agent?.session?.id
    if (!answerApprovals || !answersSession(sessionId)) return next()
    const callId = typeof request.callId === 'string' ? request.callId : undefined
    const id = (await approvalIdFor(sessionId, callId)) ?? (callId ? `approval:${callId}` : `approval:${sessionId}:${Date.now()}`)
    const parked = parkRequest({
      id,
      kind: 'approval',
      sessionId,
      ...(callId ? { callId } : {}),
      ...(typeof request.toolName === 'string' ? { toolName: request.toolName } : {}),
      ...(typeof request.reason === 'string' ? { reason: truncateReason(request.reason) } : {}),
    }, { signal: request.signal })
    // Let every other answerer (the GUI card, a composed terminal answerer) work in
    // parallel: whoever decides first wins, and the caller keeps the rest of the race.
    const downstream = Promise.resolve().then(() => next()).then(
      (value) => ({ value }),
      () => ({ value: 'unavailable' }),
    )
    const first = await Promise.race([
      parked.promise.then((value) => ({ from: 'caller', value })),
      downstream.then((settled) => ({ from: 'downstream', value: settled.value })),
    ])
    parked.cleanup?.()
    if (first.from === 'caller' && first.value !== undefined) return first.value
    if (first.from === 'downstream' && first.value !== 'unavailable') {
      releaseParked(parked, undefined)
      return first.value
    }
    // Nothing downstream could decide: keep waiting for the MCP caller, then fail closed.
    const late = await parked.promise
    return late ?? first.value ?? 'unavailable'
  }

  /** Park a user question and race it against the deployment's other answerers. */
  async function answerQuestion(request, next) {
    const sessionId = request?.agent?.session?.id
    if (!answerQuestions || !answersSession(sessionId)) return next()
    // A timed question carries its call id on the request; a plain blocking one does
    // not, so the durable sub-call id is resolved from the log — that is the id
    // dsh_list_requests reports and the one dsh_answer_request has to accept.
    const waitCallId = typeof request?.wait?.callId === 'string' ? request.wait.callId : undefined
    const callId = waitCallId ?? (await questionIdFor(sessionId))
    const id = callId ?? `question:${sessionId}:${Date.now()}`
    const questions = Array.isArray(request.questions)
      ? request.questions.map((question) => ({
        id: question?.id,
        question: question?.question,
        ...(typeof question?.header === 'string' ? { header: question.header } : {}),
        ...(Array.isArray(question?.options)
          ? { options: question.options.map((option) => ({ label: option?.label })) }
          : {}),
      }))
      : []
    const parked = parkRequest({ id, kind: 'question', sessionId, ...(callId ? { callId } : {}), questions }, { signal: request.signal })
    const downstream = Promise.resolve().then(() => next()).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    const first = await Promise.race([
      parked.promise.then((value) => ({ from: 'caller', value })),
      downstream,
    ])
    parked.cleanup?.()
    if (first.from === 'caller' && first.value !== undefined) return first.value
    if (first.error === undefined) {
      releaseParked(parked, undefined)
      return first.value
    }
    // No answerer accepted it: hold the question for the MCP caller, else report it.
    const late = await parked.promise
    if (late !== undefined) return late
    throw first.error
  }

  // Composed only when asked for: answering a request is a permission decision, so the
  // endpoint stays a reporter unless the profile opts in.
  const answerers = []
  if (answerApprovals) answerers.push(['approval/request', (request, next) => answerApproval(request, next)])
  if (answerQuestions) answerers.push(['user-questions/request', (request, next) => answerQuestion(request, next)])
  if (answerers.length) {
    try {
      for (const [event, handler] of answerers) ctx.on(event, handler, { prepend: true })
      logger('info', 'answering user decisions over MCP', {
        approvals: answerApprovals,
        questions: answerQuestions,
        timeoutMs: requestAnswerTimeoutMs,
        ownedSessionsOnly: answerOwnedSessionsOnly,
      })
    } catch (error) {
      logger('warn', 'could not register the user-request answerers', { error: errorText(error) })
    }
  }

  return { parkedRequests, parkedList, releaseParked, answerApproval, answerQuestion }
}
