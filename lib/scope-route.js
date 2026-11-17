/**
 * The loopback-only JSON route behind the tool-scope section of this plugin's
 * configuration page.
 *
 * It is separate from `/mcp-config` on purpose: that route saves through the
 * profile configuration editor, which reloads the plugin — exactly what a scope
 * change must not do, because a reload swaps the registrations a running step
 * already snapshotted. This route writes the sidecar document and updates the
 * live scope in place.
 *
 * Methods are `GET` and `POST` (not `PUT`) to match the sibling route the page
 * already talks to.
 *
 * @module dsh-mcp-server/scope-route
 */

import { admittedByTrust, clampBodyLimit, isJsonContentType, isLoopback, readBody, sendJson } from './route-http.js'

/** Decode a JSON body, translating a syntax error into the route's own 400. */
function parseJson(text) {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('invalid-body: the request body is not JSON.')
    error.status = 400
    error.code = 'invalid-body'
    throw error
  }
}

/** One workspace row, with its path only when the caller is trusted to see it. */
function workspaceRows(registry) {
  let listed = []
  let failed = false
  try {
    listed = registry?.list?.() ?? []
  } catch {
    // A registry that throws is reported, not rendered as an empty list: the page
    // would otherwise claim the Harness has no workspaces at all.
    failed = true
    listed = []
  }
  const rows = (Array.isArray(listed) ? listed : []).map((workspace) => ({
    id: String(workspace?.id ?? ''),
    title: String(workspace?.title ?? workspace?.path ?? workspace?.id ?? ''),
    // Every caller that reaches this point already passed loopback + trust, so the
    // path is theirs to see; the earlier split was a second, dead gate.
    ...(typeof workspace?.path === 'string' ? { path: workspace.path } : {}),
  }))
  return { rows, failed }
}

/**
 * Build the handler.
 *
 * @param options - `{ scope, registry, trust, allowedOrigins, maxBodyBytes, logger }`.
 * @param options.scope - the live tool scope (`state`, `save`).
 * @param options.registry - the Harness `workspaceRegistry`, for the picker.
 * @param options.getRegistry - read the registry at request time instead.
 * @param options.trust - `(req) => boolean`: may this peer see workspace paths?
 */
export function createScopeHandler({
  scope,
  registry,
  getRegistry,
  trust = () => false,
  allowedOrigins = [],
  maxBodyBytes = 4096,
  logger = () => {},
}) {
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : []

  async function snapshot() {
    // Reading the document is what clears a pending conflict: a retry after that is
    // a decision made against current state, not a blind repeat. It must happen
    // before `state()` is read, or the page renders the value the conflict replaced.
    await scope.acknowledge?.()
    const state = await scope.state()
    // Resolved per request: the registry can arrive after this handler is built, and
    // a picker frozen at apply time stays empty forever.
    const live = typeof getRegistry === 'function' ? getRegistry() : registry
    const { rows, failed } = workspaceRows(live)
    return {
      supported: state.supported,
      mode: state.mode,
      workspaceIds: state.workspaceIds,
      notes: state.notes,
      // Same shape as `dsh_status.scope`, so the page and the status tool cannot
      // disagree about whether anything is waiting to be registered.
      unmatchedAgents: state.unmatchedAgents,
      workspaces: rows,
      ...(failed && !state.notes.includes('scope-registry-degraded')
        ? { notes: [...state.notes, 'scope-registry-degraded'] }
        : {}),
    }
  }

  return async function handleScopeRequest(req, res) {
    try {
      await route(req, res)
    } catch (error) {
      // Without this the request simply hangs and Node sees an unhandled rejection
      // (which terminates the process on 24.x). The sibling route has the same net.
      logger('warn', 'tool scope: request failed', { error: String(error?.message ?? error) })
      if (!res.headersSent) sendJson(res, 500, { error: 'the tool scope request failed', code: 'scope-failed' })
      else res.end()
    }
  }

  async function route(req, res) {
    const peer = req.socket?.remoteAddress
    if (!isLoopback(peer)) {
      sendJson(res, 403, { error: 'the tool scope is served to the local machine only' })
      return
    }
    // Every method goes through trust, exactly like the settings route: reading
    // the workspace list is as much a local-only operation as changing the scope.
    const trusted = admittedByTrust(req, trust, origins)
    if (!trusted) {
      sendJson(res, 403, { error: 'the tool scope is served to the local machine only' })
      return
    }

    const method = String(req.method ?? 'GET').toUpperCase()

    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, 200, await snapshot())
      return
    }
    if (method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' })
      res.end('Method Not Allowed')
      return
    }
    if (scope.supported === false) {
      sendJson(res, 501, { error: 'scope-unsupported: this Harness exposes no workspace registry.', code: 'scope-unsupported' })
      return
    }
    if (!isJsonContentType(req.headers?.['content-type'])) {
      sendJson(res, 415, { error: 'the tool scope accepts application/json only', code: 'unsupported-media-type' })
      return
    }

    let body
    try {
      body = parseJson(await readBody(req, clampBodyLimit(maxBodyBytes)))
    } catch (error) {
      // `readBody` reports a ceiling breach by code, not by status: mapping it here
      // is what makes the difference between a 413 and a generic 400.
      const status = error?.code === 'BODY_TOO_LARGE' ? 413 : (error?.status ?? 400)
      sendJson(res, status, { error: error.message, ...(error.code ? { code: error.code } : {}) })
      return
    }
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: 'invalid-body: expected a JSON object.', code: 'invalid-body' })
      return
    }

    try {
      await scope.save({ mode: body.mode, workspaceIds: body.workspaceIds })
    } catch (error) {
      const status = Number.isFinite(error?.status) ? error.status : 500
      const code = typeof error?.code === 'string' ? error.code : 'scope-save-failed'
      logger('warn', 'tool scope: save refused', { status, code, error: error?.message })
      sendJson(res, status, { error: error?.message ?? 'the tool scope could not be saved', code })
      return
    }

    sendJson(res, 200, await snapshot())
  }
}
