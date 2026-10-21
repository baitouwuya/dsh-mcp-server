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
      const handle = await resolveAgentHandle(sessionId)
      if (!handle) return false
      const message = createUserMessage({
        content: [{ type: 'text', text: content }],
        source: internalMessageSource({
          sessionId: typeof meta.from === 'string' ? meta.from : undefined,
          agentId: typeof meta.fromAgent === 'string' ? meta.fromAgent : undefined,
        }, kind),
      })
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
