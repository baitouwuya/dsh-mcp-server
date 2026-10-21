/**
 * The DeepSeek Harness wire shapes this plugin reads and writes.
 *
 * The plugin imports no DSH package, on purpose: a profile row has to survive a
 * Harness upgrade that keeps the service contracts, and a zero-dependency
 * bundle cannot be held to another package's release cadence. The price of that
 * choice is that every wire shape it touches — a session event, a message's
 * content blocks, an agent handle's answer — is spelled by hand. This module is
 * the one place that happens: one definition, one test, one fix when a shape
 * moves, instead of the copy that used to live in each caller.
 *
 * @module dsh-mcp-server/dsh-contracts
 */

/**
 * The durable id of the session a `session/event` hook was handed.
 *
 * The Harness has answered to all three spellings across releases, so the
 * contracts module reads them in one place rather than guessing per caller.
 *
 * @param session - the session object a `session/event` listener receives.
 * @returns the id, or `undefined` when the session carries none.
 */
export function sessionIdOf(session) {
  const id = session?.id ?? session?.header?.id ?? session?.sessionId
  return typeof id === 'string' && id ? id : undefined
}

/**
 * Join the text blocks of one durable message content array.
 *
 * A message may carry reasoning, tool calls and text side by side; only text is
 * prose the model or a human actually wrote.
 *
 * @param content - `message.content`, when it is an array.
 * @returns the joined text, trimmed; empty when there is none.
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * The prose of one `assistant/message` event, or `undefined` when it has none.
 *
 * A step that only calls tools carries no text; callers use `undefined` to mean
 * "this step said nothing" rather than sending an empty report.
 *
 * @param event - a `session/event` payload of type `assistant/message`.
 */
export function assistantTextOf(event) {
  const text = (Array.isArray(event?.data?.message?.content) ? event.data.message.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text ? text : undefined
}

/**
 * `{ role, text }` for one durable transcript event, or `undefined`.
 *
 * Only a real user-authored prompt is a transcript row: the Harness also
 * records injected context (this plugin's own sync notices among it) as user
 * messages, and those carry a different `source.kind`.
 *
 * @param event - one `session/event` payload.
 */
export function messageOfEvent(event) {
  if (!event || typeof event !== 'object') return undefined
  if (event.type === 'user/message') {
    if (event.data?.source?.kind !== 'user') return undefined
    const text = textOfContent(event.data?.content)
    return text ? { role: 'user', text } : undefined
  }
  if (event.type === 'assistant/message') {
    const text = textOfContent(event.data?.message?.content)
    return text ? { role: 'assistant', text } : undefined
  }
  return undefined
}

/**
 * The numeric turn one session event belongs to, or `undefined`.
 *
 * @param event - one `session/event` payload.
 */
export function turnOfEvent(event) {
  const turn = Number(event?.data?.turn)
  return Number.isFinite(turn) ? turn : undefined
}

/**
 * One-line failure text, with the error's code when it adds information.
 *
 * @param error - anything thrown.
 */
export function errorText(error) {
  if (error instanceof Error) {
    const code = error.code ?? error.name
    // A numeric code is the MCP error number and is worth keeping; a string
    // code names the failure kind. The generic class name "Error" adds nothing,
    // and neither does a code that merely repeats the message.
    const spelled = typeof code === 'number' ? String(code) : typeof code === 'string' ? code : ''
    const suffix = spelled && spelled !== 'Error' && spelled !== error.message ? ` (${spelled})` : ''
    return error.message ? `${error.message}${suffix}` : spelled
  }
  return String(error)
}
