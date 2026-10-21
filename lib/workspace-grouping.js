/**
 * Put a session this endpoint started into the Harness project sidebar.
 *
 * The Web sidebar groups sessions by the Workspace registry's **recorded
 * membership** — `workspace.sessionIds` — not by comparing directories while it
 * renders, and the registry's one-time bootstrap only covers sessions that
 * already existed when it first ran. A session created later, by this endpoint,
 * therefore trails in "Ungrouped" even when its directory is exactly a
 * project's own path.
 *
 * Attaching it — creating the project when that directory has none yet — is the
 * whole fix. Attaching is validated by the registry against the session's own
 * recorded `cwd`, so a session can never land in the wrong project, and every
 * failure here is swallowed: a sidebar group is never worth a failed turn.
 *
 * @module dsh-mcp-server/workspace-grouping
 */

import { errorText } from './dsh-contracts.js'

/**
 * Read one session's recorded working directory.
 *
 * The caller passes the session it already resolved for this call — the same
 * one its permission pin used — so a cold session is never resumed twice; the
 * live store is only a fallback for a session the caller did not resolve.
 */
function sessionCwd(ctx, sessionId, provided) {
  const fromProvided = provided?.header?.cwd
  if (typeof fromProvided === 'string' && fromProvided) return fromProvided
  const store = ctx.get('sessions')
  const live = typeof store?.get === 'function' ? store.get(sessionId) : undefined
  const cwd = live?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

/**
 * Attach one session to the project that owns its directory.
 *
 * @param ctx - the plugin's Cordis context (`workspaceRegistry`, `sessions`).
 * @param sessionId - the session to group.
 * @param options - `{ create, session, logger }`.
 * @param options.session - the target session the caller already resolved.
 * @param options.create - create the project when the directory has none. Off
 *   unless a deployment asks for it: inventing sidebar entries is a side effect
 *   automation should not take on its own, so a session whose directory has no
 *   project simply stays in Ungrouped.
 * @param options.logger - debug sink.
 * @returns a compact summary of the project, or `undefined` when nothing was grouped.
 */
export async function groupSession(ctx, sessionId, { create = false, session = undefined, logger = () => {} } = {}) {
  const registry = ctx.get('workspaceRegistry')
  if (typeof registry?.resolveByPath !== 'function' || typeof registry?.create !== 'function') return undefined
  const cwd = sessionCwd(ctx, sessionId, session)
  if (!cwd) return undefined

  let workspace
  let created = false
  try {
    workspace = await registry.resolveByPath(cwd)
    if (!workspace) {
      if (!create) return undefined
      workspace = await registry.create(cwd)
      created = workspace !== undefined
    }
  } catch (error) {
    // A directory that vanished, or a registry that is still opening, is not a
    // reason to fail the call: the session simply stays in Ungrouped.
    logger('debug', 'workspace lookup failed', { sessionId, cwd, error: errorText(error) })
    return undefined
  }
  if (!workspace) return undefined

  try {
    await workspace.attachSession(sessionId)
  } catch (error) {
    logger('debug', 'workspace attach failed', { sessionId, cwd, error: errorText(error) })
    return { id: workspace.id, path: workspace.path, title: workspace.title, created, attached: false }
  }
  return { id: workspace.id, path: workspace.path, title: workspace.title, created, attached: true }
}

/**
 * Attach the sessions this endpoint already owns to their directory's project.
 *
 * The registry's grouping is recorded membership, and its one-time bootstrap
 * only covered the sessions that existed when it first ran — so every session
 * an earlier build of this endpoint created is still in "Ungrouped". This is the
 * one-shot repair: only sessions this endpoint's own registry attributes to a
 * caller, and only those whose directory it recorded.
 *
 * @param ctx - the plugin's Cordis context.
 * @param sessionOwners - the caller registry (`ownedSessions()`).
 * @param options - `{ limit, create, logger }`.
 * @param options.create - invent a project for a directory that has none. Off by
 *   default: the repair only restores sessions to projects that already exist.
 * @returns `{ considered, attached, created }`, or `undefined` when unsupported.
 */
export async function groupOwnedSessions(ctx, sessionOwners, { limit = 200, create = false, logger = () => {} } = {}) {
  const registry = ctx.get('workspaceRegistry')
  if (typeof registry?.resolveByPath !== 'function' || typeof registry?.create !== 'function') return undefined
  if (typeof sessionOwners?.ownedSessions !== 'function') return undefined
  const rows = sessionOwners.ownedSessions().filter((row) => typeof row.cwd === 'string' && row.cwd)
  const considered = rows.slice(0, limit)
  let attached = 0
  let created = 0
  for (const row of considered) {
    try {
      const workspace = await registry.resolveByPath(row.cwd)
      if (!workspace) {
        // Only a deployment that opted in gets a project invented for it.
        if (!create) continue
        const made = await registry.create(row.cwd)
        if (made) created += 1
        if (made) await made.attachSession(row.sessionId)
        continue
      }
      const before = workspace.sessionIds.length
      await workspace.attachSession(row.sessionId)
      if (workspace.sessionIds.length > before) attached += 1
    } catch (error) {
      logger('debug', 'could not regroup a session', { sessionId: row.sessionId, error: errorText(error) })
    }
  }
  return { considered: considered.length, attached, created }
}
