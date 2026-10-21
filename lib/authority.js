/**
 * The authority vocabulary the DSH-facing tools are clamped against.
 *
 * DSH owns the sandbox: a session's `cwd` is its `workspace-write` root, and
 * the permission preset is the per-session rung. This plugin never widens that
 * boundary — it only refuses calls that would leave it. Everything here is the
 * pure arithmetic of that refusal (the ladder, path containment, and the
 * `cwd` clamp for a session an internal caller starts); the parts that need
 * live services stay in `dsh-capabilities.js`.
 *
 * @module dsh-mcp-server/authority
 */

import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

import { ERROR_CODES, McpError } from './protocol.js'

/**
 * Sandbox modes ordered from narrowest to widest.
 *
 * This ladder is the authority vocabulary for the tools DSH itself calls: an
 * internal caller may grant at most the rung it already stands on.
 */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * Rank of one sandbox mode on {@link SANDBOX_MODES}.
 *
 * @param mode - a mode name from a session header or preset.
 * @returns its index, or `undefined` when this Host uses an unknown spelling.
 */
export function sandboxRank(mode) {
  const index = SANDBOX_MODES.indexOf(mode)
  return index < 0 ? undefined : index
}

/** Resolve symlinks when possible; an unreadable path stays as the caller spelled it. */
export function realpathOrSelf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Whether `target` is `root` or lies under it, after resolving symlinks.
 *
 * Containment is checked on resolved paths so a symlink cannot smuggle a
 * writable session outside the caller's workspace, and the separator is
 * appended before comparing so `/work` does not contain `/workspace`.
 */
export function isInsideWorkspace(root, target) {
  const realRoot = realpathOrSelf(root)
  const realTarget = realpathOrSelf(target)
  if (realTarget === realRoot) return true
  return realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
}

/**
 * Clamp the working directory an internal caller may start a session in.
 *
 * DSH resolves a session's `workspace-write` root from its own `cwd`, so
 * letting an internal caller name any directory would hand it a session wider
 * than the authority it holds. A named directory must stay inside the caller's
 * own root; an unnamed one defaults to that root.
 *
 * @param authority - the caller's authority, from `authorityOf` in capabilities.
 * @param requested - the `cwd` the call asked for, already validated absolute.
 * @returns the requested spelling when it resolves inside the root (project
 *   lookups compare spellings), or the caller's root when none was named.
 * @throws {McpError} `invalidParams` when the caller has no recorded root, or
 *   the requested directory resolves outside it.
 */
export function clampInternalCwd(authority, requested) {
  const root = authority?.workspaceRoot
  if (typeof root !== 'string' || !root) {
    throw new McpError(
      ERROR_CODES.invalidParams,
      'This DSH caller has no recorded workspace root, so a session it starts could exceed its own authority; refusing to start one.',
    )
  }
  if (!requested) return root
  // Validate on resolved paths (a symlink must not escape), but hand the Host
  // the path the caller spelled: project lookups compare spellings, and DSH
  // resolves the workspace root itself.
  if (!isInsideWorkspace(root, requested)) {
    throw new McpError(
      ERROR_CODES.invalidParams,
      `"cwd" must stay inside this caller's workspace (${realpathOrSelf(root)}); an internal caller may start a session only inside its own workspace root.`,
    )
  }
  return requested
}
