/**
 * The DSH-facing half of the MCP server: the same tools the endpoint publishes
 * over MCP, registered into the local Harness tool registry so a DSH agent can
 * call them directly instead of going through an MCP client.
 *
 * The bridge owns three things the MCP wire never had to:
 *
 *   - a schema projection, because the tool registry enforces a smaller JSON
 *     Schema subset than MCP tolerates and rejects unknown keywords outright;
 *   - a calling-agent context, so an internal call is attributed and clamped
 *     exactly like any other DSH tool call;
 *   - a lifetime tied to the `tools` service, so the surface disappears with
 *     the service or the plugin rather than dangling.
 *
 * Nothing here imports a DSH package: the registry is reached through the
 * Cordis service by name, so the bundle keeps installing with no dependencies.
 *
 * @module dsh-mcp-server/dsh-tools-bridge
 */

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

/**
 * Turn the MCP tool table into Harness tool definitions.
 *
 * The canonical result is the MCP `structuredContent` when the tool produced
 * one and its text otherwise; the schema is deliberately unconstrained, because
 * the endpoint's own tools return several shapes and the registry enforces
 * whatever is declared.
 *
 * @param tools - the MCP tool descriptors this server publishes.
 * @param call - `(name, args, context) => Promise<{ text, structuredContent? }>`.
 */
export function dshToolDefinitions(tools, call) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toDshSchema(tool.inputSchema),
    output: {
      schema: { description: `Result of ${tool.name}, as the MCP tool returned it: a JSON value, or text.` },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      const result = await call(tool.name, args ?? {}, { agent: exec?.agent, signal: exec?.signal })
      return result?.structuredContent ?? result?.text ?? ''
    },
  }))
}

/**
 * Register every MCP tool into the Harness tool registry.
 *
 * The registry is a service, so it may not exist yet when this plugin applies;
 * `ctx.inject` waits for it and ties the registrations to its lifetime. A Host
 * without the service (a headless composition serving only MCP) keeps working.
 *
 * @param options - `{ ctx, capabilities, logger }`.
 * @returns `{ names, via }`: the tool names registered, and how.
 */
export function registerDshTools({ ctx, capabilities, logger = () => {} }) {
  const definitions = dshToolDefinitions(capabilities?.tools, (name, args, context) => capabilities.callTool(name, args, context))
  const names = definitions.map((definition) => definition.name)

  /** Register into one scope; `undefined` when that scope cannot register. */
  function install(scope) {
    const tools = scope?.tools ?? (typeof scope?.get === 'function' ? scope.get('tools') : undefined)
    if (typeof tools?.register !== 'function') return undefined
    const disposers = []
    for (const definition of definitions) {
      try {
        const dispose = tools.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        // One failure must not cost the other tools: a duplicate name from a
        // second instance of this plugin is the realistic cause here.
        logger('warn', 'could not register a DSH tool', {
          tool: definition.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (!disposers.length) return undefined
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          logger('debug', 'tool disposal failed', { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope) => {
      const dispose = install(scope)
      if (!dispose) {
        logger('warn', 'the DSH tool registry is unavailable; the tools stay MCP-only.')
        return
      }
      if (typeof scope.effect === 'function') scope.effect(() => dispose, 'dsh-mcp-server: model tools')
      logger('info', 'DSH-facing tools registered', { count: names.length })
    })
    return { names, via: 'inject' }
  }

  const dispose = install(ctx)
  if (!dispose) logger('warn', 'the DSH tool registry is unavailable; the tools stay MCP-only.')
  return { names, via: 'context', ...(dispose ? { dispose } : {}) }
}
