/**
 * The DSH-facing half of the MCP server: the same tools the endpoint publishes
 * over MCP, made callable from inside a DSH session.
 *
 * There are two surfaces, and the difference is what the model pays for:
 *
 *   - `full` registers every published tool natively at load. Simple, and the
 *     whole catalogue is in the prompt of every session, forever.
 *   - `lazy` (the default) registers a three-tool front door — catalogue, open,
 *     call — and nothing else. The published tools are registered into the
 *     *calling agent's* scope only when that agent asks for them, so a session
 *     pays ~4 KB of schemas only if it actually needs them.
 *
 * `lazy` is real progressive disclosure because DSH supports mid-session tool
 * addition: the agent loop diffs the tool set between requests, appends a
 * developer message carrying `tool-addition` blocks, and the provider adapter
 * turns that into the wire form its `toolUpdate` mode requires. Nothing here
 * has to announce anything — registering through the agent's own scope is the
 * whole contract.
 *
 * Nothing in this module imports a DSH package: the registry and the agent
 * scope are reached by property, so the bundle keeps installing with zero
 * dependencies.
 *
 * @module dsh-mcp-server/dsh-tools-bridge
 */

import { withDeadline } from './deadline.js'

/**
 * JSON Schema keywords the Harness tool registry enforces.
 *
 * The registry rejects any other keyword instead of ignoring it, and MCP
 * servers routinely send `minLength`, `maximum`, `pattern`, or `format`, so a
 * verbatim projection would fail to register at all. Everything dropped here is
 * a narrowing the MCP endpoint still enforces on its own surface.
 */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'title',
  'default',
  'examples',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'oneOf',
])

/** The front door's own names: never opened as tools, never called through `dsh_mcp_call`. */
export const META_TOOL_NAMES = ['dsh_mcp_tools', 'dsh_mcp_open', 'dsh_mcp_call']

/** Characters of a published tool's description kept in the catalogue. */
/** How long an `inject(['tools'])` may take before the call reports having opened nothing. */
const OPEN_INJECT_TIMEOUT_MS = 2000

const CATALOG_SUMMARY_CHARS = 150

/**
 * Project one MCP JSON Schema into the enforced subset the registry accepts.
 *
 * @param schema - MCP input schema (or a nested part of one).
 * @returns the same shape with unsupported keywords removed.
 */
export function toDshSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {}
  const projected = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const properties = {}
      for (const [name, spec] of Object.entries(value)) properties[name] = toDshSchema(spec)
      projected.properties = properties
      continue
    }
    if (key === 'items') {
      projected.items = toDshSchema(value)
      continue
    }
    if (key === 'oneOf' && Array.isArray(value)) {
      projected.oneOf = value.map((entry) => toDshSchema(entry))
      continue
    }
    projected[key] = value
  }
  return projected
}

/**
 * Snapshot one tool result as lossless JSON.
 *
 * The registry validates a tool's canonical value, and an internal (PTC) call
 * has no JSON round trip to hide a nested `undefined`, `NaN`, or class
 * instance — it fails the whole call with "value is not lossless JSON".
 * `JSON.parse(JSON.stringify(...))` is exactly that projection: undefined
 * members and functions disappear, non-finite numbers become null.
 *
 * @param value - the canonical value a tool body produced.
 * @returns a plain, lossless JSON value (or the text form of an unserializable one).
 */
export function lossless(value) {
  if (value === undefined) return ''
  try {
    const projected = JSON.parse(JSON.stringify(value))
    return projected === undefined ? '' : projected
  } catch {
    return String(value)
  }
}

/** Render one tool result as the text content a model reads. */
function renderResult(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** The first sentence of a description, elided so a catalogue row stays one line. */
function summaryOf(description, chars = CATALOG_SUMMARY_CHARS) {
  const text = String(description ?? '').replace(/\s+/gu, ' ').trim()
  const stop = text.search(/\.(\s|$)/u)
  const sentence = stop > 0 ? text.slice(0, stop + 1) : text
  return sentence.length > chars ? `${sentence.slice(0, chars - 1)}…` : sentence
}

/** The unconstrained, annotation-only output declaration every tool here uses. */
function jsonOutput(name) {
  return {
    schema: { description: `Result of ${name}: a JSON value, or text.` },
    render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
  }
}

/**
 * Turn the MCP tool table into natively registered Harness tool definitions.
 *
 * The canonical result is the MCP `structuredContent` when the tool produced
 * one and its text otherwise.
 *
 * @param tools - the MCP tool descriptors this server publishes.
 * @param call - `(name, args, context) => Promise<{ text, structuredContent? }>`.
 */
export function dshToolDefinitions(tools, call) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toDshSchema(tool.inputSchema),
    output: jsonOutput(tool.name),
    async execute(args, exec) {
      const result = await call(tool.name, args ?? {}, { agent: exec?.agent, signal: exec?.signal, surface: 'dsh' })
      return lossless(result?.structuredContent ?? result?.text ?? '')
    },
  }))
}

/**
 * The lazy surface: catalogue, open, call.
 *
 * @param options - `{ capabilities, visibleTo, openFor }`.
 * @param options.capabilities - the MCP capability table (`tools`, `callTool`).
 * @param options.visibleTo - `(agent, name) => boolean`: is it native for that agent already?
 * @param options.openFor - `(agent, names) => { opened, alreadyOpen }`.
 */
export function metaToolDefinitions({ capabilities, visibleTo, openFor }) {
  const published = (Array.isArray(capabilities?.tools) ? capabilities.tools : []).map((tool) => ({
    name: tool.name,
    summary: summaryOf(tool.description),
    parameters: tool.inputSchema,
    // A tool may state its own signature when `required` would mislead.
    signature: typeof tool.signature === 'string' && tool.signature.trim() ? tool.signature.trim() : undefined,
  }))
  const byName = new Map(published.map((tool) => [tool.name, tool]))
  const names = published.map((tool) => tool.name)
  const catalog = published.map((tool) => ({ name: tool.name, purpose: tool.summary }))

  /**
   * One tool's call signature: `name(required, arguments)`.
   *
   * This is what removes the discovery step from the lazy surface. A model
   * reads tool descriptions directly, so a front door that also states every
   * published name and what it minimally needs lets a session call the right
   * tool in its first step instead of spending one asking what exists.
   */
  const signatureOf = (tool) => {
    if (tool.signature) return tool.signature
    const schema = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : {}
    const required = (Array.isArray(schema.required) ? schema.required : []).filter((key) => typeof key === 'string')
    return `${tool.name}(${required.join(', ')})`
  }
  const signatures = published.map(signatureOf).join(', ')

  /**
   * Resolve a name a model may have written by hand: exact, case-folded, a
   * bare name without the `dsh_` prefix, or a near miss worth suggesting.
   */
  function resolveName(raw) {
    const asked = String(raw ?? '').trim()
    if (!asked) return { message: 'a tool name is required; call dsh_mcp_tools for the catalogue.' }
    const exact = names.find((name) => name === asked) ?? names.find((name) => name.toLowerCase() === asked.toLowerCase())
    if (exact) return { name: exact }
    const suffixed = names.filter((name) => name.endsWith(`_${asked}`))
    if (suffixed.length === 1) return { name: suffixed[0] }
    const parts = asked.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)
    const guessed = names.filter((name) => parts.length > 0 && parts.every((part) => name.toLowerCase().includes(part)))
    const near = suffixed.length > 1 ? suffixed : guessed
    if (near.length) {
      return {
        message: `"${asked}" is not a published name; did you mean ${near.map((name) => `"${name}"`).join(' or ')}? Call dsh_mcp_tools for the whole list.`,
      }
    }
    return { message: `"${asked}" is not a tool this DSH deployment publishes. Call dsh_mcp_tools for the catalogue.` }
  }

  /** Resolve or refuse — a model-readable error that names the close matches. */
  function named(raw) {
    const resolved = resolveName(raw)
    if (resolved.name) return resolved.name
    throw new Error(resolved.message)
  }

  /** `arguments` as an object; a JSON object string is accepted because models send one. */
  function argumentsOf(value) {
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch {
        // fall through to the shape refusal
      }
      throw new Error('"arguments" must be an object (or a JSON object string), not free text.')
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }

  return [
    {
      name: 'dsh_mcp_tools',
      description: [
        'List the DSH session tools this deployment publishes (start and continue sessions, read transcripts,',
        'wait for turns, inspect and answer approvals and questions, manage archives) — with the call signature',
        'of every one of them, so the tool you need can be called in this step instead of discovered:',
        `Publishes ${published.length}: ${signatures}.`,
        'Run one straight away with `dsh_mcp_call({ tool, arguments })`, or `dsh_mcp_open` the ones you will keep',
        'calling so they become native from the next step. `name` returns one tool\'s parameter schema (projected',
        'for the DSH registry, so narrowing keywords like minLength are dropped),',
        '`query` filters the list, and each row is marked `native` once it is already callable directly.',
      ].join(' '),
      parameters: toDshSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Return this one tool\u2019s purpose and its parameter schema.' },
          query: { type: 'string', description: 'Filter rows by name or purpose.' },
          limit: { type: 'integer', description: 'Cap the rows; default 40.' },
        },
        additionalProperties: false,
      }),
      output: jsonOutput('dsh_mcp_tools'),
      async execute(args, exec) {
        const agent = exec?.agent
        const single = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined
        if (single) {
          const tool = byName.get(named(single))
          return lossless({
            name: tool.name,
            purpose: tool.summary,
            native: await visibleTo(agent, tool.name),
            parameters: toDshSchema(tool.parameters),
          })
        }
        const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined
        const needle = query?.toLowerCase()
        const matched = needle
          ? catalog.filter((row) => `${row.name} ${row.purpose}`.toLowerCase().includes(needle))
          : catalog
        const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Math.trunc(Number(args.limit)))) : 40
        const shown = matched.slice(0, limit)
        const natives = new Set()
        for (const row of shown) if (await visibleTo(agent, row.name)) natives.add(row.name)
        return lossless({
          total: catalog.length,
          count: shown.length,
          ...(shown.length < matched.length ? { truncated: true } : {}),
          ...(query ? { query } : {}),
          tools: shown.map((row) => ({ name: row.name, purpose: row.purpose, native: natives.has(row.name) })),
          note: 'native tools are already callable; dsh_mcp_open registers the rest for this session, and dsh_mcp_call runs one without opening it.',
        })
      },
    },
    {
      name: 'dsh_mcp_open',
      description: [
        'Register published DSH tools into THIS session so you can call them from the next step on: the next',
        'request carries them, as a native tool addition or in the regenerated SDK. Pass the names you need as',
        '`tools` (a bare name such as "continue_session" resolves too), or `all: true` for the whole set; an',
        'empty or missing target is refused rather than quietly opening all eighteen.',
        'They stay available for the rest of the session. Opening is visibility, not privilege: the authority',
        'ceiling of the calling session still applies to every call.',
      ].join(' '),
      parameters: toDshSchema({
        type: 'object',
        properties: {
          tools: { type: 'array', items: { type: 'string' }, description: 'Published tool names to open; a bare name such as "continue_session" resolves too.' },
          all: { type: 'boolean', description: 'Open the whole published toolset.' },
        },
        additionalProperties: false,
      }),
      output: jsonOutput('dsh_mcp_open'),
      async execute(args, exec) {
        const raw = args.tools
        if (raw !== undefined && !Array.isArray(raw)) {
          throw new Error('"tools" must be an array of published names; use `all: true` for the whole set.')
        }
        const requested = (raw ?? []).map((value) => (typeof value === 'string' ? value.trim() : ''))
        if (raw === undefined && args.all !== true) {
          throw new Error('Opening needs an explicit target: pass `tools: [names]`, or `all: true` for the whole set.')
        }
        if (raw !== undefined && (requested.length === 0 || requested.some((name) => !name))) {
          throw new Error('"tools" needs at least one published name; use `all: true` to open the whole set.')
        }
        const chosen = args.all === true ? names : [...new Set(requested.map(named))]
        const result = await openFor(exec?.agent, chosen)
        // An injection callback may land on a microtask; report what is visible
        // after it rather than what we hoped for.
        await Promise.resolve()
        return lossless({
          opened: result.opened,
          alreadyOpen: result.alreadyOpen,
          native: await (async () => {
            const reachable = []
            for (const name of chosen) if (await visibleTo(exec?.agent, name)) reachable.push(name)
            return reachable
          })(),
          note: 'Opened tools reach the model on the next step: a native tool addition, or the regenerated SDK.',
        })
      },
    },
    {
      name: 'dsh_mcp_call',
      description: [
        'Call one published DSH tool directly, without opening it — for a single call that does not deserve a',
        'permanent schema in the session. `tool` is a published name (a bare name such as "continue_session"',
        'resolves too) and `arguments` matches that tool\'s own schema — dsh_mcp_tools states every signature,',
        'and returns a full schema on request when a call is refused.',
      ].join(' '),
      parameters: toDshSchema({
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Published tool name, from dsh_mcp_tools.' },
          arguments: { type: 'object', additionalProperties: true, description: 'Arguments for that tool, exactly as its schema describes them.' },
        },
        required: ['tool'],
        additionalProperties: false,
      }),
      output: jsonOutput('dsh_mcp_call'),
      async execute(args, exec) {
        const asked = typeof args.tool === 'string' ? args.tool.trim() : ''
        if (!asked) {
          throw new Error(args.tool === undefined || args.tool === null
            ? '"tool" is required; call dsh_mcp_tools for the catalogue.'
            : `"tool" must be a published tool name as a string (got ${typeof args.tool}).`)
        }
        // The front door is not one of the published names, so this has to run
        // before name resolution — otherwise the refusal below would claim the
        // front door itself is unknown.
        const frontDoor = META_TOOL_NAMES.find((name) => name === asked.toLowerCase())
        if (frontDoor) throw new Error(`dsh_mcp_call cannot call the front door itself: "${frontDoor}" is already callable directly.`)
        const tool = named(asked)
        const payload = argumentsOf(args.arguments)
        try {
          const result = await capabilities.callTool(tool, payload, { agent: exec?.agent, signal: exec?.signal, surface: 'dsh' })
          return lossless(result?.structuredContent ?? result?.text ?? '')
        } catch (error) {
          // A refused call is exactly where a model needs the schema, so name it.
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`${tool} refused the call: ${message} Call dsh_mcp_tools({ name: "${tool}" }) for its parameters.`)
        }
      },
    },
  ]
}

/**
 * Register the DSH-facing surface.
 *
 * @param options - `{ ctx, capabilities, logger, mode }`.
 * @param options.ctx - the plugin's Cordis context.
 * @param options.capabilities - the MCP capability table.
 * @param options.logger - logging sink.
 * @param options.mode - `'lazy'` (front door only) or `'full'` (everything at load).
 * @returns `{ names, via, mode, published }`.
 */
export function registerDshTools({ ctx, capabilities, logger = () => {}, mode = 'lazy', scope = undefined }) {
  const published = Array.isArray(capabilities?.tools) ? capabilities.tools : []
  const full = dshToolDefinitions(published, (name, args, context) => capabilities.callTool(name, args, context))
  const byName = new Map(full.map((definition) => [definition.name, definition]))
  const opened = new WeakMap()

  const registry = () => (typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools)

  /**
   * Whether one published tool would already be callable by that agent.
   *
   * `tools.get()` answers "is a definition registered for this agent" and knows
   * nothing about `when`, so a scoped-out tool would read as visible here and
   * `dsh_mcp_open` would skip registering it. The scope has to be asked first.
   */
  async function visibleTo(agent, name) {
    if (!agent || !name) return false
    if (scope && !(await visibleNow(agent))) return false
    const service = registry()
    if (typeof service?.get !== 'function') return false
    try {
      return service.get(name, agent) !== undefined
    } catch {
      return false
    }
  }

  /**
   * The registration-time predicate: may this agent see the DSH tools at all?
   *
   * It must never throw. A throwing `when` aborts the whole turn upstream, so an
   * unlucky scope read would take the session down with it.
   */
  async function visibleNow(agent) {
    try {
      return scope ? (await scope.visibleFor(agent)) === true : true
    } catch (error) {
      logger('debug', 'tool scope check failed; treating the tool as hidden', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /** The `when` option every registration carries, so a hidden workspace sees none of them. */
  const when = scope ? (context) => visibleNow(context?.agent) : undefined

  /**
   * Register published tools into one agent's own scope.
   *
   * The agent context owns the registrations, so they unwind with the agent,
   * and the loop's next request picks the new names up as tool additions.
   */
  async function openFor(agent, requested) {
    if (scope && !(await visibleNow(agent))) {
      throw new Error('This workspace does not expose the DSH tools. Ask the operator to include it in the tool scope, or call dsh_mcp_call directly.')
    }
    const agentScope = agent?.ctx
    if (!agentScope) {
      throw new Error('Opening DSH tools needs a calling agent. Call these tools from inside a DSH session, or use dsh_mcp_call directly.')
    }
    const already = []
    for (const name of requested) {
      if (opened.get(agent)?.has(name) === true || (await visibleTo(agent, name))) already.push(name)
    }
    const alreadyOpen = already
    const toOpen = requested.filter((name) => !alreadyOpen.includes(name))
    if (!toOpen.length) return { opened: [], alreadyOpen }

    /**
     * Register the pending tools into one scope.
     *
     * @returns `{ dispose, done }` — `done` lists the names that really registered.
     *   Reporting the request instead would make a failed registration look like a
     *   success, and `alreadyOpen` would then refuse to retry it forever.
     */
    const register = (target) => {
      const disposers = []
      const done = []
      for (const name of toOpen) {
        try {
          const dispose = target?.tools?.register?.(byName.get(name), when ? { when } : undefined)
          if (typeof dispose === 'function') {
            disposers.push(dispose)
            done.push(name)
          }
        } catch (error) {
          logger('warn', 'could not open a DSH tool', {
            tool: name,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return {
        done,
        dispose: () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch (error) {
              logger('debug', 'opened-tool disposal failed', { error: error instanceof Error ? error.message : String(error) })
            }
          }
        },
      }
    }

    // `inject` is how a DSH plugin reaches a service from another scope; a
    // context that already carries the registry is registered into directly.
    let registered = { done: [], dispose: () => {} }
    if (typeof agentScope.inject === 'function') {
      // A service that never appears must not make this call claim success: wait
      // for the child scope, but not forever.
      const outcome = await withDeadline(new Promise((resolve) => {
        try {
          agentScope.inject(['tools'], resolve)
        } catch (error) {
          logger('warn', 'could not reach the tools registry', { error: error instanceof Error ? error.message : String(error) })
          resolve(null)
        }
      }), OPEN_INJECT_TIMEOUT_MS)
      const child = outcome.timedOut ? null : outcome.value
      if (outcome.timedOut) logger('warn', 'the tools registry did not appear in time; nothing was opened')
      if (child) {
        registered = register(child)
        if (typeof child.effect === 'function') child.effect(() => registered.dispose, 'dsh-mcp-server: opened tools')
      }
    } else {
      registered = register(agentScope)
      if (typeof agentScope.effect === 'function') agentScope.effect(() => registered.dispose, 'dsh-mcp-server: opened tools')
    }

    const set = opened.get(agent) ?? new Set()
    for (const name of registered.done) set.add(name)
    opened.set(agent, set)
    return { opened: registered.done, alreadyOpen }
  }

  const definitions = mode === 'full'
    ? full
    : metaToolDefinitions({ capabilities, visibleTo, openFor })

  /**
   * Register into one Cordis scope.
   *
   * @returns `{ dispose, done }` — `done` lists what really registered, so callers
   *   never report a tool that the registry refused.
   */
  function install(cordisScope) {
    const tools = cordisScope?.tools ?? (typeof cordisScope?.get === 'function' ? cordisScope.get('tools') : undefined)
    if (typeof tools?.register !== 'function') return { dispose: undefined, done: [] }
    const disposers = []
    const done = []
    for (const definition of definitions) {
      try {
        const dispose = tools.register(definition, when ? { when } : undefined)
        if (typeof dispose === 'function') {
          disposers.push(dispose)
          done.push(definition.name)
        }
      } catch (error) {
        // One failure must not cost the other tools: a duplicate name from a
        // second instance of this plugin is the realistic cause here.
        logger('warn', 'could not register a DSH tool', {
          tool: definition.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (!disposers.length) return { dispose: undefined, done }
    return {
      done,
      dispose: () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error) {
            logger('debug', 'tool disposal failed', { error: error instanceof Error ? error.message : String(error) })
          }
        }
      },
    }
  }

  const names = definitions.map((definition) => definition.name)

  // Until the registry answers, the honest answer is "asked for", not "registered":
  // the inject callback may never arrive, and a registry may refuse every name.
  const requested = definitions.map((definition) => definition.name)

  if (typeof ctx.inject === 'function') {
    const settled = { names: [] }
    ctx.inject(['tools'], (child) => {
      const installed = install(child)
      if (!installed.dispose) {
        logger('warn', 'the DSH tool registry is unavailable; the tools stay MCP-only.')
        return
      }
      if (typeof child.effect === 'function') child.effect(() => installed.dispose, 'dsh-mcp-server: model tools')
      // Mutate in place: callers already hold this array, and replacing the
      // property would leave them looking at the empty one forever.
      settled.names.push(...installed.done)
      logger('info', 'DSH-facing tools registered', { mode, count: installed.done.length })
    })
    return { names: settled.names, requested, via: 'inject', mode, published: requested, settled }
  }

  const installed = install(ctx)
  if (!installed.dispose) logger('warn', 'the DSH tool registry is unavailable; the tools stay MCP-only.')
  return {
    names: installed.done,
    requested,
    via: 'context',
    mode,
    published: requested,
    ...(installed.dispose ? { dispose: installed.dispose } : {}),
  }
}
