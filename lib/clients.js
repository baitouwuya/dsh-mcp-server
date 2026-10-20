/**
 * Caller attribution and session ownership for the MCP endpoint.
 *
 * MCP gives a server no authenticated per-agent identity: every caller presents
 * the same endpoint token. This module therefore only *attributes* requests. It
 * reads the evidence a client actually sends — an explicit `x-dsh-mcp-client`
 * header, the `clientInfo` block of `initialize`, then `User-Agent` — and keeps a
 * small durable registry, so a caller can be named and shown (or, with
 * `restrictToOwner`, confined to) the sessions it created.
 *
 * @module dsh-mcp-server/clients
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Header a client sets to name itself; the only unambiguous signal an MCP client can add. */
export const CLIENT_HEADER = 'x-dsh-mcp-client'

/** Longest label kept from a client-supplied string. */
const MAX_LABEL_LENGTH = 64

/** Registry ceilings: enough history to be useful, small enough to stay cheap. */
const MAX_CLIENTS = 64
const MAX_SESSIONS = 1000

/** How many `initialize` identities one process remembers. */
const MAX_CLIENT_INFO_CACHE = 256

/** How long registry writes are coalesced before they hit disk. */
export const DEFAULT_CLIENT_FLUSH_MS = 5000

/** Drop control characters so a client-supplied label can never break a log line. */
function stripControl(value) {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)
    out += code < 32 || code === 127 ? ' ' : char
  }
  return out
}

/** Collapse a client-supplied label into one bounded line. */
export function normalizeLabel(value) {
  if (typeof value !== 'string') return undefined
  const cleaned = stripControl(value).replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, MAX_LABEL_LENGTH)
}

/**
 * Stable registry id for a client name.
 *
 * Derived from the name only, never the version, so a client that upgrades keeps
 * the sessions it was recorded as owning.
 */
export function clientId(name) {
  const label = normalizeLabel(name) ?? 'unknown'
  const slug = label.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, 48) || 'unknown'
}

/** Read one header value (Node lower-cases names; repeated headers arrive as arrays). */
function headerValue(headers, key) {
  const raw = headers?.[key]
  if (Array.isArray(raw)) return raw[0]
  return raw
}

/**
 * Split an explicit label into `{ name, version? }`.
 *
 * A caller that sets the header may state a version as `name@version`; that part is
 * optional, and the whole label stays the name when it is absent or malformed.
 */
export function splitLabelVersion(label) {
  const clean = normalizeLabel(label)
  if (clean === undefined) return undefined
  const at = clean.lastIndexOf('@')
  if (at <= 0 || at === clean.length - 1) return { name: clean }
  const name = normalizeLabel(clean.slice(0, at))
  const version = normalizeLabel(clean.slice(at + 1))
  if (!name || !version) return { name: clean }
  return { name, version }
}

/** Normalize an MCP `clientInfo` block into `{ name, version? }`. */
export function normalizeClientInfo(clientInfo) {
  const name = normalizeLabel(clientInfo?.name)
  if (!name) return undefined
  const version = normalizeLabel(clientInfo?.version)
  return { name, ...(version ? { version } : {}) }
}

/**
 * Resolve the calling agent from one request, remembering what `initialize` reported.
 *
 * This transport keeps no MCP session state, so `clientInfo` cannot be bound to an
 * id the client repeats later. It is cached against the transport fingerprint the
 * client does repeat on every request — its explicit label, else its User-Agent,
 * else the auth peer — which is what makes the name stick between calls.
 *
 * @param evidence - `{ headers, clientInfo, peer }` for this request.
 * @param cache - Map of transport fingerprint to `{ name, version }`, shared across requests.
 * @returns `{ id, name, version?, source, userAgent?, peer?, explicit }`.
 */
export function resolveCaller(evidence = {}, cache = new Map()) {
  const headers = evidence.headers ?? {}
  const explicitLabel = splitLabelVersion(headerValue(headers, CLIENT_HEADER))
  const explicit = explicitLabel?.name
  const userAgent = normalizeLabel(headerValue(headers, 'user-agent'))
  const peer = typeof evidence.peer === 'string' ? evidence.peer : undefined
  // Client info is cached only for an explicit label: a User-Agent or the shared
  // endpoint token is not an identity, and caching under it let unrelated
  // callers inherit the first caller's name.
  const fingerprint = explicit ? 'header:' + explicit : undefined
  const reported = normalizeClientInfo(evidence.clientInfo)
  const sameClient = reported !== undefined && (explicit === undefined || reported.name === explicit)
  if (sameClient && fingerprint !== undefined) {
    if (cache.size >= MAX_CLIENT_INFO_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(fingerprint, reported)
  }
  const remembered = fingerprint !== undefined ? cache.get(fingerprint) : undefined

  const name = explicit ?? remembered?.name ?? userAgent ?? (peer === 'connection' ? 'dsh-local' : 'unknown')
  // The cache key is the explicit label itself, and only a clientInfo naming
  // that same label is remembered, so this cannot borrow another client's version.
  const version = explicitLabel?.version ?? remembered?.version
  const source = explicit
    ? 'header'
    : reported
      ? 'initialize'
      : remembered
        ? 'initialize-cache'
        : userAgent
          ? 'user-agent'
          : 'peer'
  return {
    id: clientId(name),
    name,
    ...(version ? { version } : {}),
    source,
    ...(userAgent ? { userAgent } : {}),
    ...(peer ? { peer } : {}),
    explicit: explicit !== undefined,
  }
}

/**
 * Durable caller registry: who called, and which session each caller created.
 *
 * Writes are coalesced — a busy endpoint sees a request per tool call, and this is
 * a cache, not a ledger — then written atomically to a 0600 file.
 *
 * @param options - `{ file?, logger?, flushMs?, now? }`.
 */
export function createClientRegistry(options = {}) {
  const {
    file,
    logger = () => {},
    flushMs = DEFAULT_CLIENT_FLUSH_MS,
    now = () => Date.now(),
  } = options

  const clients = new Map()
  const sessions = new Map()
  let dirty = false
  let timer

  /** Read the registry, tolerating a missing or damaged file. */
  function load() {
    if (!file) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger('debug', 'client registry unreadable', { file, error: String(error?.message ?? error) })
      }
      return
    }
    for (const entry of Array.isArray(parsed?.clients) ? parsed.clients : []) {
      if (entry?.id) clients.set(entry.id, entry)
    }
    for (const [sessionId, entry] of Object.entries(parsed?.sessions ?? {})) {
      if (entry?.ownerId) sessions.set(sessionId, entry)
    }
  }

  /** Serialize the registry, dropping the least recently seen clients first. */
  function snapshot() {
    const ordered = [...clients.values()]
      .sort((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0))
      .slice(0, MAX_CLIENTS)
    // Ownership is stored per session, with its own owner id and name: evicting
    // a client row from the LRU must not orphan the sessions it owns, or a
    // restart would make them unowned and adoptable.
    const ownedSessions = [...sessions.entries()]
      .sort((left, right) => (left[1].createdAt ?? 0) - (right[1].createdAt ?? 0))
      .slice(-MAX_SESSIONS)
    return {
      version: 1,
      updatedAt: new Date(now()).toISOString(),
      clients: ordered,
      sessions: Object.fromEntries(ownedSessions),
    }
  }

  /** Write the registry now, if anything changed. */
  function flush() {
    if (!file || !dirty) return
    dirty = false
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = file + '.tmp'
      writeFileSync(temporary, JSON.stringify(snapshot(), null, 2) + '\n', { mode: 0o600 })
      renameSync(temporary, file)
    } catch (error) {
      logger('warn', 'could not write the client registry', { file, error: String(error?.message ?? error) })
    }
  }

  /** Coalesce a write; the timer never keeps the process alive on its own. */
  function schedule() {
    if (!file) return
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, Math.max(0, flushMs))
    timer.unref?.()
  }

  /**
   * Record one request from a caller and return its registry row.
   *
   * @param caller - result of {@link resolveCaller}.
   */
  function touch(caller) {
    if (!caller?.id) return caller
    const at = now()
    const existing = clients.get(caller.id)
    const record = {
      id: caller.id,
      name: caller.name,
      ...(caller.version ? { version: caller.version } : {}),
      source: caller.source,
      ...(caller.userAgent ? { userAgent: caller.userAgent } : {}),
      firstSeenAt: existing?.firstSeenAt ?? at,
      lastSeenAt: at,
      requests: (existing?.requests ?? 0) + 1,
    }
    clients.set(caller.id, record)
    schedule()
    return record
  }

  /**
   * Record that a caller created a session. An existing owner is never replaced.
   *
   * @param sessionId - the DSH session.
   * @param caller - the calling agent.
   * @param meta - optional `{ cwd, agentPreset, model, title }`.
   * @param options - `{ adopt }` marks a session this caller did not create.
   */
  function claim(sessionId, caller, meta = {}, { adopt = false } = {}) {
    if (!sessionId || !caller?.id) return undefined
    const existing = sessions.get(sessionId)
    if (existing && !(adopt && existing.ownerId === caller.id)) return existing
    const entry = {
      ownerId: caller.id,
      ownerName: caller.name,
      ...(caller.version ? { ownerVersion: caller.version } : {}),
      ...(meta.cwd ? { cwd: meta.cwd } : {}),
      ...(meta.agentPreset ? { agentPreset: meta.agentPreset } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.title ? { title: meta.title } : {}),
      createdAt: existing?.createdAt ?? now(),
      ...(adopt && !existing ? { adopted: true } : {}),
    }
    sessions.set(sessionId, entry)
    schedule()
    return entry
  }

  /** Adopt a session that has no recorded owner (a GUI- or legacy-created one). */
  function adopt(sessionId, caller, meta = {}) {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    return claim(sessionId, caller, meta, { adopt: true })
  }

  return {
    /** The registry row for one session, or `undefined`. */
    ownerOf: (sessionId) => sessions.get(sessionId),
    /** Sessions one caller created, newest first. */
    sessionsOf(ownerId) {
      return [...sessions.entries()]
        .filter(([, entry]) => entry.ownerId === ownerId)
        .map(([sessionId, entry]) => ({ sessionId, ...entry }))
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    },
    /** Every session the registry attributes to a caller, newest first. */
    ownedSessions() {
      return [...sessions.entries()]
        .map(([sessionId, entry]) => ({ sessionId, ...entry }))
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    },
    /** A caller row, or `undefined` when it has never been seen. */
    clientOf: (id) => clients.get(id),
    /** How many distinct callers the registry has seen. */
    get clientCount() { return clients.size },
    /** How many sessions are attributed to a caller. */
    get sessionCount() { return sessions.size },
    touch,
    claim,
    adopt,
    flush,
    snapshot,
    load,
  }
}
