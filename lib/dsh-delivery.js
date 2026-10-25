/**
 * How this plugin family hands one internal message to a live DSH session.
 *
 * Two bundles need the same three pieces: an agent handle for a session (the
 * controller first, the live registry for a sub-agent the controller refuses),
 * the labelled user message DSH records, and the deployment's own busy-Enter
 * policy. Keeping them here means the MCP server's internal prompts and the
 * work-sync plugin's notices/reports cannot drift apart.
 *
 * @module dsh-mcp-server/dsh-delivery
 */

import { randomUUID } from 'node:crypto'

import { errorText } from './dsh-contracts.js'

/** The source kind this endpoint's own internal messages carry. */
export const MCP_MESSAGE_KIND = 'dsh-mcp-server'

/** The source kind the work-sync plugin's notices and reports carry. */
export const SYNC_MESSAGE_KIND = 'dsh-work-sync'

/**
 * Build one identified user-role message, exactly as the Harness does.
 *
 * Rebuilt here rather than imported: the bundle stays dependency-free, and the
 * shape is the published contract (`role`, `content`, `source`, fresh `id`).
 */
export function createUserMessage({ content, source }) {
  return { role: 'user', content, source, id: randomUUID() }
}

/**
 * The durable attribution an internal message carries.
 *
 * A message sent by another DSH session must not read as the user typing: the
 * source names its sender and the bundle that sent it.
 */
export function internalMessageSource(authority, kind = MCP_MESSAGE_KIND) {
  return {
    kind,
    ...(authority?.sessionId ? { sessionId: authority.sessionId } : {}),
    ...(authority?.agentId ? { agentId: authority.agentId } : {}),
  }
}

/**
 * The deployment's own Enter-key behaviour for a busy session.
 *
 * `ui-conversation.busyEnter` is the setting the Web composer obeys. A caller
 * that names no mode follows it rather than inventing a second policy, so
 * "send this session a message" behaves the way the user's own Enter does.
 */
export function busyEnterSetting(ctx) {
  const editor = ctx.get('configEditor')
  if (typeof editor?.entries !== 'function') return undefined
  try {
    const rows = [...(editor.entries() ?? [])]
    const row = rows.find((entry) => entry?.options?.id === 'ui-conversation')
      ?? rows.find((entry) => entry?.options?.name === '@deepseek-ai/dsh-client-ui-conversation')
    const value = row?.options?.config?.busyEnter
    return value === 'steer' || value === 'queue' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve one session's live Agent so a labelled message can be queued on it.
 *
 * The API controller refuses subagent-owned sessions ("use subagent delivery
 * for this child session"); the live Agents registry still holds that running
 * child's handle, which is what the subagent runtime itself uses.
 */
export function createAgentHandleResolver({ ctx, logger = () => {} }) {
  return async function resolveAgentHandle(sessionId) {
    const controller = ctx.get('sessionController')
    if (typeof controller?.resolveAgent === 'function') {
      try {
        const resolved = await controller.resolveAgent(sessionId)
        if (!resolved?.error) return resolved?.agent
      } catch (error) {
        logger('debug', 'agent resolution failed', { sessionId, error: errorText(error) })
      }
    }
    try {
      const live = ctx.get('agents')?.get?.(sessionId)
      if (live && (typeof live.steer === 'function' || typeof live.followup === 'function')) return live
    } catch (error) {
      logger('debug', 'live agent handle lookup failed', { sessionId, error: errorText(error) })
    }
    return undefined
  }
}

/**
 * Deliver one internal message into a live session, unattended.
 *
 * A steered message joins a running turn and starts none (`startsTurn: false`);
 * anything else opens the next turn. A refused delivery returns `false` rather
 * than throwing, so a caller can decide whether to retry.
 */
export function createInternalDelivery({ ctx, logger = () => {}, busyMode = 'setting', kind = MCP_MESSAGE_KIND }) {
  const resolveAgentHandle = createAgentHandleResolver({ ctx, logger })
  return {
    resolveAgentHandle,
    async deliver(sessionId, text, meta = {}) {
      const content = typeof text === 'string' ? text.trim() : ''
      if (!content) return false
      const message = createUserMessage({
        content: [{ type: 'text', text: content }],
        source: internalMessageSource({
          sessionId: typeof meta.from === 'string' ? meta.from : undefined,
          agentId: typeof meta.fromAgent === 'string' ? meta.fromAgent : undefined,
        }, kind),
      })
      // Injection is the no-wake path: it adds model-facing context that lands
      // in the target's next admitted step instead of opening a turn. A cold
      // session is deliberately not resumed for it — injecting must never be a
      // way to wake something the person stopped.
      if (meta.inject === true) {
        // A live session is required; a cold one is never resumed for an
        // injection, because that is precisely the wake this path must not do.
        let live = ctx.get('agents')?.get?.(sessionId)
        if (!live && ctx.get('sessions')?.get?.(sessionId)) {
          try {
            live = await resolveAgentHandle(sessionId)
          } catch (error) {
            logger('debug', 'injected message: agent lookup failed', { sessionId, error: errorText(error) })
          }
        }
        if (!live) return { accepted: false, reason: 'not-live' }
        if (typeof live.inject === 'function') {
          try {
            live.inject(message)
            return { accepted: true, startsTurn: false, injected: true }
          } catch (error) {
            logger('debug', 'injected message refused', { sessionId, error: errorText(error) })
            return { accepted: false, reason: 'inject-threw', error: errorText(error) }
          }
        }
        // Older Harness handles expose steer but not inject. Steering a RUNNING
        // agent adds to the next step without opening a turn; an idle one is
        // left alone rather than woken.
        if (live.status === 'running' && typeof live.steer === 'function') {
          try {
            live.steer(message)
            return { accepted: true, startsTurn: false, injected: false, steered: true }
          } catch (error) {
            logger('debug', 'steered reminder refused', { sessionId, error: errorText(error) })
            return { accepted: false, reason: 'steer-threw', error: errorText(error) }
          }
        }
        return { accepted: false, reason: 'no-inject' }
      }
      const handle = await resolveAgentHandle(sessionId)
      if (!handle) return false
      const agents = ctx.get('agents')
      const busy = typeof agents?.get === 'function' && agents.get(sessionId)?.status === 'running'
      const delivery = busy
        ? (busyMode === 'steer' || busyMode === 'queue' ? busyMode : (busyEnterSetting(ctx) ?? 'queue'))
        : 'queue'
      try {
        if (delivery === 'steer') handle.steer(message)
        else handle.followup(message)
        return { accepted: true, startsTurn: delivery !== 'steer' }
      } catch (error) {
        logger('debug', 'internal message refused', { sessionId, error: errorText(error) })
        return false
      }
    },
  }
}
