/**
 * Dependency-free Model Context Protocol (MCP) JSON-RPC 2.0 core.
 *
 * This module knows the wire contract only: message shapes, protocol-version
 * negotiation, capability advertisement, and result/error projection. It never
 * imports a DSH package, so the plugin keeps working when it is installed into a
 * profile whose `node_modules` holds nothing but this bundle.
 *
 * @module dsh-mcp-server/protocol
 */

/** JSON-RPC version marker required on every message. */
export const JSONRPC_VERSION = '2.0'

/** Standard JSON-RPC error codes plus the MCP-specific ones we emit. */
export const ERROR_CODES = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** MCP: a requested resource URI does not exist. */
  resourceNotFound: -32002,
})

/**
 * Protocol revisions this server can speak. The newest revision in this list is
 * the one it advertises; a client asking for any listed revision gets its own
 * version echoed back, which is the negotiation the MCP specification prescribes.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
])

/** Revision advertised when a client asks for something unknown. */
export const PREFERRED_PROTOCOL_VERSION = '2025-06-18'

/** Server name reported in `initialize`; stable across releases. */
export const SERVER_NAME = 'dsh-mcp-server'

/** A JSON-RPC error carrying a code, message, and optional data. */
export class McpError extends Error {
  /**
   * @param code - numeric JSON-RPC error code.
   * @param message - short human-readable message.
   * @param data - optional structured detail safe to send to the client.
   */
  constructor(code, message, data) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.data = data
  }
}

/** Build a successful JSON-RPC response. */
export function success(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result }
}

/** Build a failed JSON-RPC response from an {@link McpError} or any thrown value. */
export function failure(id, error) {
  const code = error instanceof McpError ? error.code : ERROR_CODES.internalError
  const message = error instanceof Error ? error.message : String(error)
  const data = error instanceof McpError ? error.data : undefined
  return {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

/** True when a parsed value is a JSON-RPC request or notification object. */
export function isJsonRpcMessage(value) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.method === 'string'
  )
}

/** True when the message expects a response (it carries a non-null id). */
export function expectsResponse(message) {
  return message.id !== undefined && message.id !== null
}

/** Normalize a tool/agent failure into text a calling model can act on. */
export function describeError(error) {
  if (error instanceof McpError) return error.message
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

/**
 * The MCP gateway: a method table plus the negotiation and projection rules.
 *
 * A gateway is transport-agnostic. The HTTP route and the stdio bridge both
 * funnel parsed JSON-RPC messages through {@link McpGateway#handle}.
 */
export class McpGateway {
  /**
   * @param options - server identity, instructions, and the capability providers.
   * @param options.serverInfo - `{ name, version, title? }` reported by `initialize`.
   * @param options.instructions - optional text handed to the calling model.
   * @param options.listTools - `() => Promise<Array<ToolDefinition>>` or sync equivalent.
   * @param options.callTool - `(name, args, signal) => Promise<ToolCallOutcome>`.
   * @param options.listResources - `() => Promise<Array<ResourceDefinition>>`.
   * @param options.readResource - `(uri, context?) => Promise<ResourceReadOutcome>`.
   * @param options.logger - optional `(level, message, detail?) => void` sink.
   */
  constructor(options) {
    const {
      serverInfo,
      instructions,
      listTools,
      callTool,
      listResources,
      readResource,
      listResourceTemplates,
      logger,
    } = options
    this.serverInfo = serverInfo
    this.instructions = instructions
    this.listTools = listTools ?? (() => [])
    this.callTool = callTool ?? (async () => { throw new McpError(ERROR_CODES.methodNotFound, 'No tools are available.') })
    this.listResources = listResources ?? (() => [])
    this.listResourceTemplates = listResourceTemplates ?? (() => [])
    this.readResource = readResource ?? (async () => { throw new McpError(ERROR_CODES.resourceNotFound, 'No resources are available.') })
    this.logger = logger ?? (() => {})
  }

  /** Advertised server capabilities, derived from the providers actually wired in. */
  capabilities() {
    return {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      logging: {},
    }
  }

  /**
   * Handle one parsed JSON-RPC message.
   *
   * @param message - parsed request or notification.
   * @param context - `{ signal?, peerId?, sessionId? }` transport context.
   * @returns the response object, or `undefined` for notifications.
   */
  async handle(message, context = {}) {
    if (!isJsonRpcMessage(message)) {
      return failure(message?.id ?? null, new McpError(ERROR_CODES.invalidRequest, 'Not a JSON-RPC request.'))
    }
    const id = expectsResponse(message) ? message.id : undefined
    const isNotification = id === undefined
    try {
      const result = await this.invoke(message.method, message.params ?? {}, context)
      return isNotification ? undefined : success(id, result ?? {})
    } catch (error) {
      if (error instanceof McpError && error.code === ERROR_CODES.methodNotFound) {
        this.logger('debug', 'unknown method', { method: message.method })
      } else {
        this.logger('warn', 'request failed', { method: message.method, error: describeError(error) })
      }
      if (isNotification) return undefined
      return failure(id, error)
    }
  }

  /**
   * Invoke one method from the MCP method table.
   *
   * @param method - exact MCP method name.
   * @param params - method parameters.
   * @param context - transport context forwarded to tool handlers.
   */
  async invoke(method, params, context) {
    switch (method) {
      case 'initialize':
        return this.initialize(params)
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: (await this.listTools()).map(projectTool) }
      case 'tools/call':
        return this.toolsCall(params, context)
      case 'resources/list':
        return { resources: (await this.listResources()).map(projectResource) }
      case 'resources/templates/list':
        return { resourceTemplates: (await this.listResourceTemplates()).map(projectResourceTemplate) }
      case 'resources/read':
        return this.resourcesRead(params, context)
      case 'logging/setLevel':
        return {}
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
      case 'notifications/roots/list_changed':
        return undefined
      default:
        throw new McpError(ERROR_CODES.methodNotFound, `Method not found: ${method}`)
    }
  }

  /** `initialize`: negotiate a protocol revision and report identity plus capabilities. */
  initialize(params) {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined
    const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : PREFERRED_PROTOCOL_VERSION
    const result = {
      protocolVersion,
      capabilities: this.capabilities(),
      serverInfo: this.serverInfo,
    }
    if (typeof this.instructions === 'string' && this.instructions.trim()) result.instructions = this.instructions
    this.logger('info', 'initialize', {
      client: params?.clientInfo?.name,
      clientVersion: params?.clientInfo?.version,
      requested,
      negotiated: protocolVersion,
    })
    return result
  }

  /** `tools/call`: project a tool outcome into MCP content blocks. */
  async toolsCall(params, context) {
    const name = params?.name
    if (typeof name !== 'string' || !name) {
      throw new McpError(ERROR_CODES.invalidParams, 'tools/call requires a string "name".')
    }
    const args = params.arguments ?? {}
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new McpError(ERROR_CODES.invalidParams, 'tools/call "arguments" must be an object.')
    }
    let outcome
    try {
      outcome = await this.callTool(name, args, context)
    } catch (error) {
      if (error instanceof McpError && error.code === ERROR_CODES.methodNotFound) throw error
      // An unknown tool name is a malformed request, not a transport failure.
      if (error instanceof McpError && error.data?.unknownTool === true) throw error
      // Tool execution failures are results with isError, not JSON-RPC errors.
      this.logger('warn', 'tool failed', { tool: name, error: describeError(error) })
      return {
        content: [{ type: 'text', text: `${name} failed: ${describeError(error)}` }],
        isError: true,
      }
    }
    return projectToolOutcome(outcome)
  }

  /** `resources/read`: project one resource document. */
  async resourcesRead(params, context) {
    const uri = params?.uri
    if (typeof uri !== 'string' || !uri) {
      throw new McpError(ERROR_CODES.invalidParams, 'resources/read requires a string "uri".')
    }
    const outcome = await this.readResource(uri, context)
    const text = typeof outcome === 'string' ? outcome : outcome?.text ?? ''
    const mimeType = typeof outcome === 'object' && outcome ? outcome.mimeType : undefined
    const contents = [{ uri, text: String(text), ...(mimeType ? { mimeType } : {}) }]
    return { contents }
  }
}

/** Project a tool definition into the `tools/list` entry shape. */
export function projectTool(tool) {
  const entry = {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
  }
  if (tool.title) entry.title = tool.title
  if (tool.annotations) entry.annotations = tool.annotations
  if (tool.outputSchema) entry.outputSchema = tool.outputSchema
  return entry
}

/** Project a handler return value into an MCP `tools/call` result. */
export function projectToolOutcome(outcome) {
  if (outcome === undefined || outcome === null) {
    return { content: [{ type: 'text', text: 'OK' }] }
  }
  if (typeof outcome === 'string') {
    return { content: [{ type: 'text', text: outcome }] }
  }
  if (outcome.isError) {
    return {
      content: [{ type: 'text', text: String(outcome.text ?? 'Tool reported an error.') }],
      isError: true,
    }
  }
  const text = typeof outcome.text === 'string' ? outcome.text : JSON.stringify(outcome.text ?? outcome.structuredContent ?? null, null, 2)
  const result = { content: [{ type: 'text', text }] }
  if (outcome.structuredContent !== undefined) result.structuredContent = outcome.structuredContent
  return result
}

/** Project a static resource descriptor. */
export function projectResource(resource) {
  const entry = {
    uri: resource.uri,
    name: resource.name ?? resource.uri,
  }
  if (resource.title) entry.title = resource.title
  if (resource.description) entry.description = resource.description
  if (resource.mimeType) entry.mimeType = resource.mimeType
  return entry
}

/** Project a resource template descriptor. */
export function projectResourceTemplate(template) {
  const entry = {
    uriTemplate: template.uriTemplate,
    name: template.name ?? template.uriTemplate,
  }
  if (template.title) entry.title = template.title
  if (template.description) entry.description = template.description
  if (template.mimeType) entry.mimeType = template.mimeType
  return entry
}