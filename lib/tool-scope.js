/**
 * Tool scope: which workspaces may see this plugin's DSH-facing tools.
 *
 * The document answers one question — is this agent's workspace selected — and
 * every path that cannot answer it lands on the strict side (`selected` with no
 * workspaces), never on `global`. That is the one rule the rest of this module
 * exists to keep: a broken file must not silently widen what the tools can touch.
 *
 * The live document is the in-memory copy, replaced in place by {@link save};
 * the file is only how it survives a restart. That is deliberate: a save must not
 * reload the plugin, because a reload swaps the tool registrations the running
 * step already snapshotted.
 *
 * See `docs/design/2026-11-12-tool-scope.md`.
 *
 * @module dsh-mcp-server/tool-scope
 */

import { randomUUID } from 'node:crypto'

import { withDeadline } from './deadline.js'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'

/** The machine this process is on, recorded in every lock it writes. */
const HOSTNAME = hostname()
import { dirname } from 'node:path'

/** The only `version` this build writes. */
export const SCOPE_FILE_VERSION = 1

/**
 * How long a compare-and-write may wait for another writer's lock.
 *
 * This must exceed the slowest *legitimate* hold, or ordinary concurrency reports
 * itself as a failure: the critical section reads a stamp (2s), may reload the
 * document (2s), and writes (2s).
 */
const LOCK_WAIT_MS = 8000

/**
 * A lock file older than this belongs to a writer that is no longer running.
 *
 * Deliberately far above the bounded hold above. Age alone cannot distinguish
 * "dead" from "slow", so the margin does the distinguishing; ownership still does
 * the protecting (see {@link createFileStore}).
 */
const LOCK_STALE_MS = 30_000

/**
 * Whether the lock's recorded owner is demonstrably not running.
 *
 * Only `ESRCH` counts: "no such process" is the one answer that is safe to act on.
 * A permission error, a foreign pid, or an unreadable file all mean "assume alive",
 * because reclaiming a live lock is the failure this whole mechanism exists to stop.
 */
async function ownerIsGone(lockPath) {
  // Asynchronous and bounded: this runs inside the lock-acquisition loop, and a
  // synchronous read on a wedged mount would freeze the whole event loop.
  let probed
  try {
    probed = await withDeadline(Promise.resolve(readFile(lockPath, 'utf8')), LOCK_IO_TIMEOUT_MS)
  } catch {
    // The lock vanished between the failed open and this read: it was released, so
    // there is nothing to reclaim and nothing to learn.
    return false
  }
  if (probed.timedOut) return false // cannot tell: assume alive
  let owner
  try {
    owner = JSON.parse(probed.value)
  } catch {
    return false
  }
  // A pid only means something on the machine that wrote it. Another host's live
  // lock would answer ESRCH here, so age is the only thing that may decide.
  if (owner?.host !== HOSTNAME) return false
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * How often the acquisition loop may spend a read on the owner's pid.
 *
 * Not a minimum age: a process that dies the instant after taking the lock is the
 * most common crash, and making it wait out the full stale window would turn a
 * one-line crash into half a minute of failed saves.
 */
const LOCK_PID_PROBE_EVERY_MS = 250

/** How long any single read or write inside the critical section may take. */
const LOCK_IO_TIMEOUT_MS = 2000

/** How long the write-time stamp read may take before the save reports it cannot verify. */
const STAMP_READ_TIMEOUT_MS = 2000

/** How long the first document read may take before the scope narrows to nobody. */
const SCOPE_LOAD_TIMEOUT_MS = STAMP_READ_TIMEOUT_MS

/** How long one workspace listing is reused before asking the registry again. */
const WORKSPACE_LIST_TTL_MS = 500

/** Upper bound on remembered unplaced sessions; only the count is reported. */
const UNMATCHED_CAP = 2000

/** How long one judgement is reused, so the 28 calls of one step agree. */
const VERDICT_TTL_MS = 10

/** A save that failed for a reason the caller can act on. */
export class ScopeError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ScopeError'
    this.status = status
    this.code = code
  }
}

const EMPTY = Object.freeze({ version: SCOPE_FILE_VERSION, mode: 'global', workspaceIds: Object.freeze([]) })

/**
 * Coerce whatever was on disk into a usable document.
 *
 * A document this build does not understand, or one whose fields are the wrong
 * shape, selects nobody. A *missing* document is different: it means the
 * deployment never opted in, so it stays `global` and every tool stays where it
 * was before this feature existed.
 *
 * @param raw - the parsed file contents, the raw text, or `undefined`.
 * @returns `{ doc, notes }` — `notes` carries `scope-degraded` when the input was unusable.
 */
export function normalizeDocument(raw) {
  if (raw === undefined || raw === null) return { doc: { ...EMPTY }, notes: [] }

  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  }
  // A document this build does not understand is not a document it may rewrite:
  // narrowing is the only safe reading of a newer format.
  if (value.version !== undefined && value.version !== SCOPE_FILE_VERSION) {
    return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  }

  const mode = value.mode
  if (mode !== 'global' && mode !== 'selected') {
    return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  }
  if (mode === 'global') {
    // The selection is kept while global, so switching back does not make the
    // operator pick everything again.
    const kept = Array.isArray(value.workspaceIds)
      ? [...new Set(value.workspaceIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))].sort()
      : []
    return { doc: { version: SCOPE_FILE_VERSION, mode: 'global', workspaceIds: kept }, notes: [] }
  }

  const ids = value.workspaceIds
  if (!Array.isArray(ids)) return { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
  const cleaned = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))].sort()
  // An empty selection is a legitimate "nobody", but a list whose every entry was
  // unusable is a broken document, and the two must not look the same.
  const notes = cleaned.length === 0 && ids.length > 0 ? ['scope-degraded'] : []
  return { doc: { version: SCOPE_FILE_VERSION, mode: 'selected', workspaceIds: cleaned }, notes }
}

/**
 * Whether one workspace id is inside the document's reach.
 *
 * `global` admits everything, including an id the registry has never heard of —
 * that is what "global" meant before this feature existed.
 *
 * @param doc - a normalized document.
 * @param workspaceId - the workspace this agent belongs to, or `undefined` when unknown.
 */
export function isVisible(doc, workspaceId) {
  if (doc.mode === 'global') return true
  return typeof workspaceId === 'string' && doc.workspaceIds.includes(workspaceId)
}

/** The atomic sidecar store used in production: 0600, write-then-rename. */
export function createFileStore(path) {
  /** When this store last spent a read on the lock owner's pid. */
  let lastOwnerProbe = 0
  return {
    path,
    async read() {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined
        throw error
      }
    },
    async write(text, { shouldCommit } = {}) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      // Checked as late as possible: once `rename` is called the write has landed,
      // and a caller that already reported "nothing changed" would be lying.
      if (typeof shouldCommit === 'function' && !shouldCommit()) {
        await unlink(temporary).catch(() => {})
        throw new Error('the write was abandoned before it committed')
      }
      await rename(temporary, path)
    },
    /**
     * Run `work` while holding an exclusive lock file.
     *
     * Without it, two instances can each read the same stamp, both decide they are
     * current, and both write — the compare is not atomic with the write by itself.
     * A lock older than {@link LOCK_STALE_MS} is assumed to belong to a dead process.
     */
    async withLock(work) {
      const lockPath = `${path}.lock`
      const giveUpAt = Date.now() + LOCK_WAIT_MS
      const token = randomUUID()

      for (;;) {
        let handle
        try {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          // The lock's own filesystem calls are bounded too: a wedged mount would
          // otherwise park the save chain here, where no deadline is watching.
          const opened = await withDeadline(Promise.resolve(open(lockPath, 'wx', 0o600)), LOCK_IO_TIMEOUT_MS)
          if (opened.timedOut) throw new ScopeError(409, 'scope-lock-timeout', 'scope-lock-timeout: the scope lock could not be taken in time; try again.')
          handle = opened.value
        } catch (error) {
          if (error instanceof ScopeError) throw error
          if (error?.code !== 'EEXIST') throw error
          // Check the deadline before anything that can loop: a stale lock that
          // cannot be removed used to `continue` past this and spin forever.
          if (Date.now() > giveUpAt) {
            throw new ScopeError(409, 'scope-lock-timeout', 'scope-lock-timeout: another writer is holding the scope document; try again.')
          }
          await this.reclaimIfStale(lockPath)
          await new Promise((resolve) => setTimeout(resolve, 10))
          continue
        }

        // Name the owner inside the file: without it, releasing means "unlink the
        // path", which deletes whoever holds it now rather than whoever held it when
        // this writer arrived.
        try {
          await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: HOSTNAME, at: new Date().toISOString() }))
        } catch {
          // A lock we cannot label is a lock we cannot safely release.
          await handle.close().catch(() => {})
          await unlink(lockPath).catch(() => {})
          throw new ScopeError(500, 'scope-lock-failed', 'scope-lock-failed: the scope lock could not be taken.')
        }

        try {
          return await work()
        } finally {
          await handle.close().catch(() => {})
          await this.releaseIfOwned(lockPath, token)
        }
      }
    },

    /**
     * Remove a lock only when it is old enough to be dead, and only after claiming
     * it by rename — the rename succeeds for exactly one reclaimer, so two writers
     * cannot both decide the lock is theirs to delete.
     */
    async reclaimIfStale(lockPath) {
      // Shared across callers on this store: the probe is a property of the lock,
      // not of whoever happens to be waiting on it.

      let info
      try {
        const probed = await withDeadline(Promise.resolve(stat(lockPath)), LOCK_IO_TIMEOUT_MS)
        if (probed.timedOut) return
        info = probed.value
      } catch {
        return // It vanished between the failed open and the stat: just retry.
      }
      const age = Date.now() - info.mtimeMs
      // Age alone cannot tell "dead" from "slow", and waiting out the full stale
      // window for a process that is already gone costs every save a failure. The
      // pid settles it on this host; an unreadable or foreign owner is left alone,
      // which is the safe direction.
      // Age alone decides once the window is up. Below it, only a demonstrably dead
      // local owner may reclaim early — probed at most a few times a second, so a
      // normal short hold never pays for a lock-file read.
      if (age <= LOCK_STALE_MS) {
        const now = Date.now()
        if (now - lastOwnerProbe < LOCK_PID_PROBE_EVERY_MS) return
        lastOwnerProbe = now
        if (!(await ownerIsGone(lockPath))) return
      }
      const ino = info.ino
      const claimed = `${lockPath}.stale.${randomUUID()}`
      try {
        await rename(lockPath, claimed)
      } catch {
        return // Someone else claimed it first, or it disappeared.
      }
      // Between the stat and the rename the path may have been released and taken
      // again by a live writer. Renaming their fresh lock away would hand the
      // critical section to a second writer, so put it back untouched.
      try {
        if ((await stat(claimed)).ino !== ino) {
          await rename(claimed, lockPath).catch(() => {})
          return
        }
      } catch {
        return
      }
      await unlink(claimed).catch(() => {})
    },

    /** Release only the lock this writer created, never one that replaced it. */
    async releaseIfOwned(lockPath, token) {
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'))
        if (owner?.token !== token) return
      } catch {
        return // Gone, or unreadable: either way it is not ours to delete.
      }
      await unlink(lockPath).catch(() => {})
    },
  }
}

/**
 * Build the scope: read once, judge cheaply, save in place.
 *
 * @param options - `{ registry, store, logger }`.
 * @param options.registry - the Harness `workspaceRegistry` (`list`, `resolveByPath`).
 * @param options.store - `{ read, write }`; see {@link createFileStore}.
 * @param options.logger - debug sink.
 */
export function createToolScope({ registry, getRegistry, store, logger = () => {} } = {}) {
  // The registry may not exist at apply time and appear a moment later; holding a
  // fixed reference would then mean "unsupported" for the life of the process.
  const registryOf = () => (typeof getRegistry === 'function' ? getRegistry() : registry)
  const supported = () => {
    const current = registryOf()
    return typeof current?.list === 'function' && typeof current?.resolveByPath === 'function'
  }

  /** Bumped by every save, so a late read can tell "stale" from "superseded". */
  let docRevision = 0

  /** Bumped by every read, so an abandoned one cannot commit after a newer read. */
  let loadSeq = 0

  /** The `updatedAt` this instance believes is on disk, for the write-time compare. */
  let stampSeen
  let disposed = false
  /**
   * Set when a save lost to another writer, cleared when the caller reads the
   * document again. A blind retry of the same request would otherwise overwrite the
   * winner with the value we just adopted.
   */
  let conflictPending = false

  let doc = { ...EMPTY }
  let notes = supported() ? [] : ['scope-unsupported']
  /** sessionId → workspace id, positive hits only. Identity cannot move, so no cwd. */
  const placements = new Map()
    /** Sessions a lookup could not place, so "configured but nobody matches" is visible. */
  const unmatched = new Set()

  /**
   * (Re)read the file. A broken file narrows the scope; it never widens it.
   *
   * Returns whether this read actually produced a document the caller may trust.
   * A read that was superseded by a newer one returns `false` and changes nothing:
   * without that, an abandoned read answering minutes later would rewrite both the
   * document and the baseline behind whatever the page is showing.
   */
  async function load() {
    const seq = ++loadSeq
    const at = docRevision
    let parsed
    let raw
    let readable = true
    try {
      raw = await store?.read?.()
      parsed = normalizeDocument(raw)
    } catch (error) {
      logger('warn', 'tool scope: the document could not be read; selecting nobody', { error: String(error) })
      parsed = { doc: { ...EMPTY, mode: 'selected' }, notes: ['scope-degraded'] }
      readable = false
    }
    // Superseded by a newer read, or by a save: this answer is no longer the truth.
    if (seq !== loadSeq) return false
    if (at !== docRevision) return false

    if (!readable) {
      // Fail closed, but leave the baseline alone: we did not learn what is on disk,
      // so a save must not compare against a value we never read.
      doc = parsed.doc
      notes = [...parsed.notes, ...(supported() ? [] : ['scope-unsupported'])]
      placements.clear()
      return false
    }

    if (raw === undefined) {
      // No file. That means "never configured" only the first time; once a document
      // has been read, its disappearance is a change like any other, and widening the
      // scope back to everyone would be the one direction this module never takes.
      const first = stampSeen === undefined
      stampSeen = null
      doc = first ? { ...EMPTY } : { ...EMPTY, mode: 'selected' }
      notes = first ? (supported() ? [] : ['scope-unsupported']) : ['scope-degraded']
      placements.clear()
      return true
    }

    stampSeen = stampOf(raw)
    doc = parsed.doc
    notes = [...parsed.notes, ...(supported() ? [] : ['scope-unsupported'])]
    placements.clear()
    return true
  }

  /**
   * The first read, bounded.
   *
   * A read that never settles must not hold every step's tool resolution, so the
   * deadline narrows the scope to nobody. The timer is cleared the moment the
   * read lands: leaving it armed would re-narrow a healthy deployment two seconds
   * after startup, which is a deployment-wide outage.
   */
  const ready = withDeadline(load(), SCOPE_LOAD_TIMEOUT_MS, {
    onTimeout: () => {
      logger('warn', 'tool scope: the document did not load in time; selecting nobody')
      doc = { ...EMPTY, mode: 'selected' }
      notes = ['scope-degraded']
    },
  }).then(() => {})

  /**
   * One workspace list snapshot, briefly cached.
   *
   * `when` runs once per tool per step, so an uncached `list()` would be called
   * 28 times in `full` mode every step. The window is short enough that a
   * workspace created seconds ago is still noticed.
   */
  let listCache
  /**
   * The workspace list, briefly cached.
   *
   * A registry that throws is *not* an empty registry: judging with `[]` would hide
   * every tool, and saving against it would report "unknown workspace" for every
   * id. The failure is carried out to the caller instead.
   */
  function workspaces({ fresh = false } = {}) {
    const at = Date.now()
    if (!fresh && listCache && at - listCache.at < WORKSPACE_LIST_TTL_MS) return listCache.value
    let list
    try {
      list = registryOf()?.list?.()
    } catch (error) {
      throw new ScopeError(500, 'scope-registry-unavailable', `scope-registry-unavailable: the Harness workspace registry failed (${String(error?.message ?? error)}).`)
    }
    if (!Array.isArray(list)) throw new ScopeError(500, 'scope-registry-unavailable', 'scope-registry-unavailable: the Harness workspace registry returned no list.')
    listCache = { at, value: list }
    return list
  }

  /**
   * A value that changes on every write.
   *
   * `updatedAt` alone is not enough: two writes inside the same millisecond carry
   * the same timestamp, and the compare would call them equal. `writeId` breaks
   * that tie, and documents written before it existed fall back to the timestamp.
   */
  function stampOf(raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (typeof parsed?.updatedAt !== 'string') return null
      return typeof parsed?.writeId === 'string' ? `${parsed.updatedAt}|${parsed.writeId}` : parsed.updatedAt
    } catch {
      return null
    }
  }

  /**
   * The stamp currently on disk, read fresh for the write-time compare.
   *
   * `null` means "no document" (a first write is safe); `undefined` means the read
   * itself failed, which is not the same thing and must not be read as "empty".
   */
  async function stampOfStore() {
    try {
      // Bounded: a store that hangs must not hang the save behind it.
      const read = await withDeadline(Promise.resolve(store?.read?.()), STAMP_READ_TIMEOUT_MS)
      if (read.timedOut) return undefined
      const raw = read.value
      return raw === undefined || raw === null ? null : stampOf(raw)
    } catch (error) {
      logger('debug', 'tool scope: could not read the document before writing', { error: String(error) })
      return undefined
    }
  }

  /**
   * Where this session was opened.
   *
   * Deliberately the *recorded* directory, not the live working directory: a session
   * may change directory at any point, so a live lookup would let any session
   * `cd` into a selected workspace and grant itself the tools. Identity is where
   * the session started; the live directory is only a fallback for a session the
   * header does not carry.
   */
  function cwdOf(agent) {
    const recorded = agent?.session?.header?.cwd
    return typeof recorded === 'string' && recorded ? recorded : undefined
  }

  /** Which workspace this agent belongs to, or `undefined` when the registry cannot say. */
  async function workspaceIdOf(agent) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !sessionId) return undefined

    const cwd = cwdOf(agent)
    // Identity cannot change mid-session (`session.header.cwd` is immutable), so a
    // remembered workspace needs no cwd check: it is good while the registry still
    // lists it.
    const remembered = placements.get(sessionId)
    if (remembered !== undefined) {
      const stillListed = workspaces().some((workspace) => workspace?.id === remembered)
      if (stillListed) return remembered
      placements.delete(sessionId)
      if (!notes.includes('scope-stale')) notes.push('scope-stale')
    }

    const listed = workspaces()
    const recorded = listed.find((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId))
    if (recorded?.id) {
      placements.set(sessionId, recorded.id)
      unmatched.delete(sessionId)
      return recorded.id
    }

    if (cwd) {
      try {
        const byPath = await registryOf().resolveByPath(cwd)
        if (byPath?.id) {
          placements.set(sessionId, byPath.id)
          unmatched.delete(sessionId)
          return byPath.id
        }
      } catch (error) {
        logger('debug', 'tool scope: workspace lookup by path failed', { error: String(error) })
      }
    }
    unmatched.add(sessionId)
    return undefined
  }

  /**
   * Judgements for the document that was current a moment ago.
   *
   * `when` is asked once per tool, so one step asks up to 28 times. Without this
   * a save landing mid-step could answer some of them with the old document and
   * the rest with the new one, leaving a half-visible tool surface. The window is
   * deliberately tiny: it bounds that skew without hiding a save for long.
   */
  const verdicts = new Map()

  /** The judgement every enforcement point asks for. Never throws. */
  async function visibleFor(agent) {
    try {
      await ready
      if (doc.mode === 'global') return true
      // A Harness with no workspace registry cannot narrow anything, so a
      // `selected` document has nothing to select: nobody sees the tools. `global`
      // still means what it always meant (see D9 in the design note).
      if (!supported()) return false
      const sessionId = agent?.session?.id
      if (typeof sessionId === 'string') {
        const hit = verdicts.get(sessionId)
        if (hit !== undefined && hit.at === docRevision && Date.now() - hit.ms < VERDICT_TTL_MS) return hit.visible
        const visible = isVisible(doc, await workspaceIdOf(agent))
        verdicts.set(sessionId, { at: docRevision, ms: Date.now(), visible })
        return visible
      }
      return isVisible(doc, await workspaceIdOf(agent))
    } catch (error) {
      // A predicate that throws aborts the whole turn upstream, so a scope failure
      // has to look like "not visible" instead.
      logger('debug', 'tool scope: judgement failed; treating as not visible', { error: String(error) })
      return false
    }
  }

  /**
   * What the page and `dsh_status` show. Doc-level only: per-agent sight is a
   * runtime fact.
   *
   * It waits for the first read, so a status call during startup reports the
   * document that is about to govern the deployment rather than the placeholder.
   */
  async function state() {
    await ready
    // A registry that throws is reported here too, so `dsh_status` and the page tell
    // the same story instead of one of them quietly showing an empty world.
    let registryBroken = false
    try {
      workspaces({ fresh: true })
    } catch {
      registryBroken = true
    }
    // `scope-unsupported` is a statement about *now*, not about what was on disk when
    // the document was read: the registry can arrive late, and a note captured at load
    // time would keep claiming the feature is unavailable after it started working.
    const allNotes = notes.filter((note) => note !== 'scope-unsupported')
    if (!supported()) allNotes.push('scope-unsupported')
    if (registryBroken && !allNotes.includes('scope-registry-degraded')) allNotes.push('scope-registry-degraded')
    return {
      supported: supported(),
      mode: doc.mode,
      workspaceIds: [...doc.workspaceIds],
      notes: allNotes,
      unmatchedAgents: unmatched.size,
    }
  }

  /** Saves are serialized: two overlapping writes would race on the same file. */
  let saving = Promise.resolve()

  /**
   * Persist a new document, then adopt it.
   *
   * Memory changes only after the write succeeded: a failed save must leave the
   * running deployment exactly as it was.
   */
  async function save(input) { return saving = saving.then(() => saveNow(input), () => saveNow(input)) }

  /** The write-then-adopt half of `save`, never called directly. */

  async function saveNow(input) {
    await ready
    if (disposed) throw new ScopeError(409, 'scope-disposed', 'scope-disposed: this plugin instance is no longer running; reload the page and save again.')
    if (conflictPending) {
      throw new ScopeError(409, 'scope-conflict', 'scope-conflict: another writer won; the page must be reloaded before saving again.')
    }
    const mode = input?.mode
    if (mode !== 'global' && mode !== 'selected') {
      throw new ScopeError(400, 'invalid-mode', 'invalid-mode: "mode" must be "global" or "selected".')
    }
    // An explicit `null` is a client bug, not "no workspaces": folding it into `[]`
    // would silently save "selected, nobody" instead of refusing.
    const rawIds = input?.workspaceIds === undefined ? [] : input.workspaceIds
    if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string')) {
      throw new ScopeError(400, 'invalid-workspace-ids', 'invalid-workspace-ids: "workspaceIds" must be an array of workspace ids.')
    }
    const wanted = [...new Set(rawIds.map((id) => id.trim()).filter(Boolean))].sort()

    // The listing is cached for a few hundred milliseconds; a workspace created
    // seconds ago must still be savable, so validation reads through.
    const known = new Set(workspaces({ fresh: true }).map((workspace) => workspace?.id))
    const unknown = wanted.filter((id) => !known.has(id))
    if (unknown.length) {
      throw new ScopeError(400, 'unknown-workspace', `unknown-workspace: no such workspace ${unknown.join(', ')}`)
    }

    // The selection travels with `global` too: switching back to `selected` should
    // not force the operator to pick everything again.
    const next = { version: SCOPE_FILE_VERSION, mode, workspaceIds: wanted }
    // Another instance may have written since this one last read: a late save from a
    // replaced plugin would otherwise silently overwrite a newer, narrower selection.
    const commit = async () => {
      const onDisk = await stampOfStore()
    if (onDisk === undefined) {
      throw new ScopeError(500, 'scope-write-unverified', 'scope-write-unverified: the scope document could not be read before writing; nothing changed.')
    }
    // No baseline and nothing on disk: this is a first write, not a conflict. A
    // baseline that was never established *because the read failed* is still a
    // conflict when a document is there, which is what `onDisk !== null` separates.
    const neverReadButOccupied = stampSeen === undefined && onDisk !== null
    const movedOn = stampSeen !== undefined && onDisk !== stampSeen
    if (neverReadButOccupied || movedOn) {
      // One refusal path for both cases. They used to be two, and only one of them
      // reloaded — so the other advanced the baseline without adopting the document,
      // and the next save wrote the stale value straight over the winner.
      // The abandoned read must not commit later: bumping the sequence is what
      // makes it "superseded" even though nothing newer replaced it.
      const reread = await withDeadline(load(), LOCK_IO_TIMEOUT_MS, { onTimeout: () => { loadSeq += 1 } })
      const adopted = !reread.timedOut && reread.value === true
      conflictPending = true
      if (!adopted) {
        // Do not advance the baseline: it would let the next save compare equal
        // against a document this instance never actually read.
        throw new ScopeError(409, 'scope-conflict', 'scope-conflict: the scope document changed elsewhere and could not be reloaded; reload the page, or call acknowledge() if you are driving this without a page.')
      }
      // `load()` has already adopted the document and its stamp; re-assigning here
      // would hide a future change where it stops doing so.
      if (stampSeen !== onDisk) logger('warn', 'tool scope: the reload did not adopt the stamp it was given', { onDisk, stampSeen })
      verdicts.clear()
      throw new ScopeError(409, 'scope-conflict', 'scope-conflict: the scope document changed elsewhere; it has been reloaded, review and save again.')
    }
    // The instance can be replaced while this save waited on the disk; writing then
    // would publish a value the replacement already superseded.
    if (disposed) throw new ScopeError(409, 'scope-disposed', 'scope-disposed: this plugin instance was replaced while saving; reload the page.')
    const updatedAt = new Date().toISOString()
    const writeId = randomUUID()
    const text = `${JSON.stringify({ ...next, updatedAt, writeId }, null, 2)}\n`
    let abandoned = false
    let written
    try {
      written = await withDeadline(
        Promise.resolve(store.write(text, { shouldCommit: () => !abandoned && !disposed })),
        LOCK_IO_TIMEOUT_MS,
      )
    } catch (error) {
      logger('warn', 'tool scope: the document could not be written; keeping the running one', { error: String(error) })
      throw new ScopeError(500, 'scope-write-failed', 'scope-write-failed: the scope document could not be written; nothing changed.')
    }
    if (written.timedOut) {
      // Give up on the write, but do not claim it did not happen: the rename may
      // already be in flight, and it lands *after* the lock is released — on top of
      // whatever another writer committed meanwhile.
      abandoned = true
      // The baseline is now unknown, so the next save must treat this as a conflict
      // rather than compare against a value that may no longer be on disk.
      stampSeen = undefined
      logger('warn', 'tool scope: the write did not finish in time; the document state is uncertain')
      throw new ScopeError(500, 'scope-write-unverified', 'scope-write-unverified: the scope document write did not finish in time and may have landed; reload before saving again.')
    }

    stampSeen = `${updatedAt}|${writeId}`
    // Bumped here so a read that started before this save cannot adopt its stale
    // answer over the value just published.
    docRevision += 1
    doc = next
    notes = supported() ? [] : ['scope-unsupported']
    verdicts.clear()
    // Placements stay: a save changes which workspaces are selected, never where a
    // session lives, and dropping them would cost 28 lookups on the next step.
    if (unmatched.size > UNMATCHED_CAP) unmatched.clear()
    return state()
    }

    // Compare-then-write has to be one critical section: two instances that each
    // read the same stamp would otherwise both pass and both write.
    return typeof store?.withLock === 'function' ? store.withLock(commit) : commit()
  }

  /**
   * Stop this instance.
   *
   * A replaced plugin keeps its own memory, timers and in-flight writes unless it
   * is told: without this, a save that lands after the swap overwrites whatever the
   * new instance published.
   */
  function dispose() {
    disposed = true
    placements.clear()
    verdicts.clear()
    listCache = undefined
  }

  /** The caller has read the document, so the next save is based on current state. */
  async function acknowledge() {
    if (!conflictPending) return
    // The page is about to render what this instance believes. If the last reload
    // failed, that belief is stale, so read once more before letting the latch go —
    // and keep it shut if the read fails again.
    const reread = await withDeadline(load(), LOCK_IO_TIMEOUT_MS, { onTimeout: () => { loadSeq += 1 } })
    if (!reread.timedOut && reread.value === true) conflictPending = false
  }

  return {
    get supported() {
      return supported()
    },
    visibleFor,
    state,
    save,
    acknowledge,
    ready,
    dispose,
  }
}
