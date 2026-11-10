/**
 * Progressive transcript reads for one DSH session.
 *
 * A long session's log is megabytes, so a read is a window, not a dump: the
 * caller picks the tail, the head or a compact outline, narrows by role or by
 * sequence, and every payload says how much was left out. This module owns that
 * arithmetic (windowing, per-message caps, the response budget) so the tool
 * handlers stay about intent instead of paging.
 *
 * It reads the durable event log through `ctx.get('sessionQuery')`; DSH owns
 * the log, this module only shapes a response from it.
 *
 * @module dsh-mcp-server/transcript
 */

import { errorText, messageOfEvent } from './dsh-contracts.js'
import { ERROR_CODES, McpError } from './protocol.js'

/** Default transcript window: a read is a window, not a dump. */
export const DEFAULT_TRANSCRIPT_WINDOW = 10

/** Default per-message character cap for a read; 0 disables it. */
export const DEFAULT_MESSAGE_CHARS = 2000

/** Total characters one transcript response may carry, whatever the per-message cap. */
export const MAX_TRANSCRIPT_CHARS = 512 * 1024

/** Most messages one `limit: 0` ("everything") read may return. */
export const MAX_ZERO_LIMIT = 1000

/** Most messages a windowed read may ask for. */
export const MAX_READ_LIMIT = 5000

/** Characters of a message kept in an outline row (its first line, normally). */
export const OUTLINE_PREVIEW_CHARS = 120

/**
 * Best-effort prose of one raw `session/event`, for a caller reading the log
 * itself. Message events yield their text; a tool row yields its output when it
 * has one, and anything else falls back to its JSON payload so nothing is lost.
 *
 * @param event - one `session/event` payload.
 */
function textOfEvent(event) {
  const message = messageOfEvent(event)
  if (message) return message.text
  const data = event?.data
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    if (typeof data.output === 'string') return data.output
    if (typeof data.text === 'string') return data.text
    try {
      return JSON.stringify(data)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * One event payload as text, for budget accounting: the response carries the
 * payload verbatim, so its serialized size is what a caller actually pays.
 *
 * @param value - the event's `data`.
 * @returns its JSON text, or `undefined` when it is absent or unrepresentable.
 */
function serializedSize(value) {
  if (value === undefined) return undefined
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the transcript reader over one Cordis context.
 *
 * @param options.ctx - the plugin's Cordis context (`sessionQuery` is read live).
 * @param options.pendingOf - `(events) => pendingSummary`: the unanswered user
 *   decisions to fold into a read (the capabilities module owns that folding).
 * @param options.ownerOf - `(sessionId) => owner | undefined`: the client that
 *   owns a session, when this deployment attributes ownership.
 * @returns `{ sessionMessages, readTranscript }`.
 */
export function createTranscriptReader({ ctx, pendingOf = () => undefined, ownerOf = () => undefined }) {
  /**
   * Raw transcript of one session: message rows plus the last durable preset.
   *
   * @throws McpError `invalidParams` when the session cannot be read.
   */
  async function sessionMessages(sessionId) {
    const sessionQuery = ctx.get('sessionQuery')
    if (!sessionQuery) {
      throw new McpError(
        ERROR_CODES.internalError,
        'The DeepSeek Harness service "sessionQuery" is unavailable in this deployment, so this transcript cannot be read.',
      )
    }
    let snapshot
    try {
      snapshot = await sessionQuery.readSession(sessionId)
    } catch (error) {
      throw new McpError(ERROR_CODES.invalidParams, `Session "${sessionId}" could not be read: ${errorText(error)}`)
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const messages = []
    let permissionPreset
    for (const event of events) {
      const message = messageOfEvent(event)
      if (message) messages.push({ role: message.role, text: message.text, seq: Number(event.seq) })
      // The last durable permission selection; the same event the GUI's
      // `/permission` command appends, so a reader can verify what was applied.
      if (event?.type === 'permission/preset' && typeof event.data?.preset === 'string') {
        permissionPreset = event.data.preset
      }
    }
    return { snapshot, events, messages, permissionPreset }
  }

  /**
   * Progressive transcript read for one session.
   *
   * The log of a long session is megabytes, so a read is a window, not a dump:
   * `mode` picks the tail, the head, or an outline of every turn; `roles` and
   * `afterSeq` narrow it; `maxChars` caps each message so one huge answer cannot
   * flood the caller. The payload always reports how much was left out.
   *
   * @param sessionId - the DSH session.
   * @param options - `{ mode, limit, afterSeq, roles, maxChars, maxTotalChars }`.
   */
  async function readTranscript(sessionId, options = {}) {
    const {
      mode = 'tail',
      limit = DEFAULT_TRANSCRIPT_WINDOW,
      afterSeq,
      roles,
      maxChars = DEFAULT_MESSAGE_CHARS,
    } = options
    const { snapshot, events, messages: all, permissionPreset } = await sessionMessages(sessionId)
    const pending = pendingOf(events)

    // `events` mode reads the durable log itself. The folded message view keeps
    // only user and assistant prose, so a caller auditing what a run actually did
    // (tool calls, tool results, permission changes) asks for the raw events.
    if (mode === 'events') {
      const cursor = Number.isFinite(afterSeq) ? Number(afterSeq) : undefined
      // `types` narrows the raw log by event type *before* the window is cut, so
      // `matchedEvents` counts what the filter matched — not what happened to land
      // inside the last N rows.
      const wantedTypes = Array.isArray(options.types) && options.types.length
        ? new Set(options.types.map((type) => String(type)))
        : undefined
      const typed = wantedTypes ? events.filter((event) => wantedTypes.has(String(event?.type))) : events
      const matchedEvents = cursor === undefined
        ? typed
        : typed.filter((event) => Number(event?.seq) > cursor)
      const windowed = matchedEvents.slice(-limit)
      const budget = Number.isFinite(options.maxTotalChars) ? options.maxTotalChars : MAX_TRANSCRIPT_CHARS
      // One row may carry a bounded slice of prose, exactly like a message read;
      // the payload travels verbatim, so its serialized size is what the budget
      // has to charge — otherwise one inline image escapes the ceiling.
      const perRowCap = Number.isFinite(maxChars) ? Math.max(0, maxChars) : DEFAULT_MESSAGE_CHARS
      const rows = []
      let used = 0
      let truncatedByBudget = false
      for (const event of windowed) {
        const fullText = textOfEvent(event)
        let text = fullText.length > perRowCap ? fullText.slice(0, perRowCap) : fullText
        let textTruncated = text.length < fullText.length
        const dataText = serializedSize(event?.data)
        let rowData = dataText === undefined ? undefined : event.data
        let dataOmitted = false
        const cost = text.length + (dataText === undefined ? 0 : dataText.length)
        const remaining = budget - used
        if (cost > remaining) {
          if (rows.length > 0) {
            truncatedByBudget = true
            break
          }
          // The window's first row always comes back: dropping it would leave
          // `nextAfterSeq` where it was, and a caller paging by the reported
          // cursor would read the same empty page forever. Its payload goes
          // first; its prose is cut to what still fits.
          truncatedByBudget = true
          if (text.length > remaining) {
            text = text.slice(0, Math.max(0, remaining))
            textTruncated = true
          }
          if (rowData !== undefined && text.length + dataText.length > remaining) {
            rowData = undefined
            dataOmitted = true
          }
        }
        used += text.length + (rowData === undefined ? 0 : dataText.length)
        rows.push({
          type: String(event?.type ?? 'unknown'),
          seq: Number(event?.seq),
          ...(Number.isFinite(event?.time) ? { time: Number(event.time) } : {}),
          text,
          ...(textTruncated ? { truncated: true, chars: fullText.length } : {}),
          ...(rowData === undefined ? {} : { data: rowData }),
          ...(dataOmitted ? { dataOmitted: true, dataChars: dataText.length } : {}),
        })
        if (truncatedByBudget) break
      }
      const firstSeq = rows.length ? rows[0].seq : undefined
      const lastSeq = rows.length ? rows[rows.length - 1].seq : undefined
      const endSeq = matchedEvents.length ? Number(matchedEvents[matchedEvents.length - 1].seq) : undefined
      const owner = ownerOf(sessionId)
      return {
        sessionId,
        cwd: snapshot?.session?.cwd,
        agentPreset: snapshot?.session?.agentPreset,
        ...(owner ? { owner } : {}),
        ...(permissionPreset === undefined ? {} : { permissionPreset }),
        createdAt: snapshot?.session?.createdAt
          ? new Date(Number(snapshot.session.createdAt)).toISOString()
          : undefined,
        mode,
        ...(wantedTypes ? { types: [...wantedTypes] } : {}),
        totalEvents: events.length,
        matchedEvents: matchedEvents.length,
        returned: rows.length,
        window: {
          ...(cursor === undefined ? {} : { afterSeq: cursor }),
          ...(firstSeq === undefined ? {} : { firstSeq, lastSeq }),
          nextAfterSeq: lastSeq ?? cursor ?? null,
          reachedEnd: endSeq === undefined || lastSeq === endSeq,
        },
        ...(pending?.count ? { pending } : {}),
        ...(truncatedByBudget
          ? {
            truncatedByBudget,
            note: `Stopped at ${budget} characters for this response; narrow with afterSeq/limit, or read a smaller window.`,
          }
          : {}),
        events: rows,
      }
    }

    const wantedRoles = Array.isArray(roles) && roles.length ? new Set(roles) : undefined
    let matched = wantedRoles ? all.filter((row) => wantedRoles.has(row.role)) : all
    if (Number.isFinite(afterSeq)) matched = matched.filter((row) => row.seq > afterSeq)
    const cursor = Number.isFinite(afterSeq) ? Number(afterSeq) : undefined

    const windowed = mode === 'head' || mode === 'outline'
      ? matched.slice(0, limit)
      : matched.slice(-limit)

    // One response carries at most `maxTotalChars`: a huge session must not turn
    // one read into hundreds of megabytes, whatever the per-message cap allows.
    const budget = Number.isFinite(options.maxTotalChars) ? options.maxTotalChars : MAX_TRANSCRIPT_CHARS
    let truncatedMessages = 0
    let truncatedByBudget = false
    let used = 0
    // An outline row is a table-of-contents line: the first line of the message,
    // shortened by `maxChars` when the caller asks for a smaller index.
    const outlinePreview = maxChars > 0 ? Math.min(OUTLINE_PREVIEW_CHARS, maxChars) : OUTLINE_PREVIEW_CHARS
    const rows = []
    for (const row of windowed) {
      if (mode === 'outline') {
        const preview = row.text.split('\n', 1)[0].slice(0, outlinePreview)
        if (used + preview.length > budget) {
          truncatedByBudget = true
          break
        }
        used += preview.length
        rows.push({ role: row.role, seq: row.seq, chars: row.text.length, preview })
        continue
      }
      const tooLong = maxChars > 0 && row.text.length > maxChars
      const text = tooLong ? row.text.slice(0, maxChars) : row.text
      if (used + text.length > budget) {
        truncatedByBudget = true
        break
      }
      used += text.length
      if (tooLong) truncatedMessages += 1
      rows.push({
        role: row.role,
        text,
        seq: row.seq,
        ...(tooLong ? { truncated: true, chars: row.text.length } : {}),
      })
    }

    const firstSeq = rows.length ? rows[0].seq : undefined
    const lastSeq = rows.length ? rows[rows.length - 1].seq : undefined
    const endSeq = matched.length ? matched[matched.length - 1].seq : undefined
    const owner = ownerOf(sessionId)
    return {
      sessionId,
      cwd: snapshot?.session?.cwd,
      agentPreset: snapshot?.session?.agentPreset,
      ...(owner ? { owner } : {}),
      ...(permissionPreset === undefined ? {} : { permissionPreset }),
      createdAt: snapshot?.session?.createdAt
        ? new Date(Number(snapshot.session.createdAt)).toISOString()
        : undefined,
      mode,
      totalMessages: all.length,
      matchedMessages: matched.length,
      returned: rows.length,
      ...(wantedRoles ? { roles: [...wantedRoles] } : {}),
      window: {
        ...(cursor === undefined ? {} : { afterSeq: cursor }),
        ...(firstSeq === undefined ? {} : { firstSeq, lastSeq }),
        nextAfterSeq: lastSeq ?? cursor ?? null,
        reachedEnd: endSeq === undefined || lastSeq === endSeq,
      },
      ...(pending?.count ? { pending } : {}),
      ...(truncatedMessages || truncatedByBudget
        ? {
          ...(truncatedMessages ? { truncatedMessages } : {}),
          ...(truncatedByBudget ? { truncatedByBudget } : {}),
          note: truncatedByBudget
            ? `Stopped at ${budget} characters for this response; narrow with roles/afterSeq/limit, or read a smaller window.`
            : `${truncatedMessages} message(s) were cut at ${maxChars} characters; pass maxChars: 0 for the full text or read the message by seq.`,
        }
        : {}),
      messages: rows,
    }
  }

  return { sessionMessages, readTranscript }
}
