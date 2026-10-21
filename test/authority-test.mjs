/**
 * The authority vocabulary, in isolation.
 *
 * The DSH-facing tools are clamped by a ladder and by path containment. Both
 * are pure arithmetic, so they are tested here directly instead of only through
 * a full plugin fixture: a containment bug is a sandbox escape, and it should
 * fail on the first assert rather than inside a 123-check integration run.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SANDBOX_MODES,
  clampInternalCwd,
  isInsideWorkspace,
  realpathOrSelf,
  sandboxRank,
} from '../lib/authority.js'

const checks = []

// --- the ladder --------------------------------------------------------------
assert.deepEqual(SANDBOX_MODES, ['read-only', 'workspace-write', 'danger-full-access'])
assert.equal(sandboxRank('read-only'), 0)
assert.equal(sandboxRank('workspace-write'), 1)
assert.equal(sandboxRank('danger-full-access'), 2)
assert.equal(sandboxRank('custom'), undefined, 'an unknown mode has no rung')
assert.equal(sandboxRank(undefined), undefined)
checks.push('the sandbox ladder ranks every known mode and no unknown one')

// --- path arithmetic ---------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-authority-'))
const inside = join(root, 'inside')
const sibling = root + '-sibling'
mkdirSync(inside)
mkdirSync(sibling)
const outside = mkdtempSync(join(tmpdir(), 'dsh-mcp-outside-'))
assert.equal(realpathOrSelf(join(root, 'missing')), join(root, 'missing'), 'an unreadable path keeps its spelling')
assert.equal(isInsideWorkspace(root, root), true)
assert.equal(isInsideWorkspace(root, inside), true)
assert.equal(isInsideWorkspace(root, sibling), false, 'a shared prefix is not containment')
assert.equal(isInsideWorkspace(root, outside), false)
checks.push('workspace containment compares resolved paths, not string prefixes')

// --- the cwd clamp -----------------------------------------------------------
assert.equal(clampInternalCwd({ workspaceRoot: root }, undefined), root, 'an unnamed cwd defaults to the caller root')
assert.equal(clampInternalCwd({ workspaceRoot: root }, inside), inside, 'the caller spelling survives the check')
assert.equal(clampInternalCwd({ workspaceRoot: root }, root), root)
const refusedOutside = (() => { try { clampInternalCwd({ workspaceRoot: root }, outside) } catch (error) { return error } })()
assert.equal(refusedOutside?.code, -32602, 'a cwd outside the root is invalid params')
assert.match(String(refusedOutside?.message), /inside this caller's workspace/)
assert.equal(clampInternalCwd({ workspaceRoot: realpathSync(root) }, inside), inside, 'a resolved root still contains the child')
checks.push('the cwd clamp defaults inside, keeps the caller spelling, and refuses an escape')

// A symlink must not smuggle a writable session out of the workspace: the
// check resolves the target, so a link inside the root that points outside is
// refused even though its spelling looks contained.
const escapeLink = join(root, 'escape-link')
symlinkSync(outside, escapeLink)
const refusedLink = (() => { try { clampInternalCwd({ workspaceRoot: root }, escapeLink) } catch (error) { return error } })()
assert.equal(refusedLink?.code, -32602, 'a symlink that resolves outside is refused')
checks.push('a symlink inside the root cannot point a session outside it')

const noRoot = (() => { try { clampInternalCwd({}, inside) } catch (error) { return error } })()
assert.equal(noRoot?.code, -32602, 'a caller with no recorded root cannot start a session')
assert.match(String(noRoot?.message), /no recorded workspace root/)
checks.push('a caller without a recorded workspace root cannot start a session')

console.log(`${checks.length} authority checks passed`)
for (const check of checks) console.log(`ok - ${check}`)
