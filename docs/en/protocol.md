# Protocol support

> Part of [DSH MCP Server](../../README.en.md) · [Docs index](../README.md)

What this endpoint answers on the wire, and what it deliberately does not. The gateway is
`lib/protocol.js`; the HTTP binding is `lib/http-route.js`. The bundled stdio bridge
(`bin/dsh-mcp-stdio.mjs`) forwards the same messages to the same HTTP endpoint, so the matrix below
applies to both transports.

## MCP revisions

| Revision | Behavior |
|---|---|
| `2026-07-28` | Echoed when a client asks for it. |
| `2025-11-25` | Echoed when a client asks for it. |
| `2025-06-18` | Echoed when requested, and the fallback for an unknown or absent version. |
| `2025-03-26` | Echoed when a client asks for it. |
| `2024-11-05` | Echoed when a client asks for it. |
| `2024-10-07` | Echoed when a client asks for it. |

This is the list in `SUPPORTED_PROTOCOL_VERSIONS`. `initialize` echoes any listed revision; anything
else returns `PREFERRED_PROTOCOL_VERSION`, which is `2025-06-18`. Being listed does not make a
revision the default: the server advertises `2025-06-18` unless the client names a revision it
supports.

## Methods

| Method | Kind | Result |
|---|---|---|
| `initialize` | request | `protocolVersion`, `capabilities`, `serverInfo` (`name`, `title`, `version`) and the deployment's `instructions`. |
| `notifications/initialized` | notification | Accepted with no result. |
| `ping` | request | An empty object. |
| `tools/list` | request | All 21 tools, each with `name`, `description` and `inputSchema` (plus `title`, `annotations` or `outputSchema` when declared). |
| `tools/call` | request | `content` blocks and, when the handler returns one, `structuredContent`. An execution failure is a result with `isError: true`; an unknown tool name is a `-32602` error. |
| `resources/list` | request | `resources`: `dsh://status` and `dsh://sessions`. |
| `resources/templates/list` | request | `resourceTemplates`: the single `dsh://session/{sessionId}` template. |
| `resources/read` | request | One `contents` entry. An unknown URI is `-32002`. |
| `logging/setLevel` | request | An empty object; the level is accepted but nothing is sent to the client. |
| `notifications/cancelled` | notification | Accepted; there is no server-side in-flight state to cancel (the stdio bridge aborts its own forward). |
| `notifications/progress` | notification | Accepted. |
| `notifications/roots/list_changed` | notification | Accepted. |
| Any other method | either | `-32601` for a request; discarded when it arrives as a notification. |

Notification methods are handled from the method table, so sending one with an `id` still produces
`{}` with status 200; without an `id` it is a notification and the HTTP transport answers 202.

## Capabilities

```json
{
  "tools": { "listChanged": false },
  "resources": { "subscribe": false, "listChanged": false },
  "logging": {}
}
```

The advertisement is static, not derived from what happens to be mounted. There is no `prompts`,
`sampling`, `completions` or `experimental` capability, and no resource subscription. `serverInfo`
names the build (`dsh-mcp-server`, "DeepSeek Harness MCP Server", the version this build reports), and
`instructions` is the deployment's model-facing guidance, always present for this plugin.

## Notifications

The server accepts `notifications/initialized`, `notifications/cancelled`,
`notifications/progress` and `notifications/roots/list_changed`. It sends no notifications and makes
no server-to-client requests: there is no `notifications/message`, no
`notifications/tools/list_changed`, no `notifications/resources/list_changed`, no sampling, no
elicitation and no roots request. Over HTTP a notification is acknowledged once dispatched, with
status 202 and an empty body.

## Error codes

| Code | Name | Emitted when |
|---|---|---|
| `-32700` | Parse error | The body is not JSON, or it exceeds the body ceiling (with HTTP 413). |
| `-32600` | Invalid request | A JSON-RPC batch, a non-object body, or an envelope without a string `method`. |
| `-32601` | Method not found | The method is outside the table above. |
| `-32602` | Invalid params | `tools/call` without a name, with non-object arguments, or with an unknown tool; `resources/read` without a string URI or with a malformed session id. |
| `-32603` | Internal error | A handler threw a non-MCP error; a `resources/read` that needs an unavailable DSH service is one case. |
| `-32002` | Resource not found | `resources/read` asked for a URI this endpoint does not serve. |

A tool that runs and fails is not a protocol error: its result carries `isError: true` and an
actionable text block, so the calling model can react. Protocol errors keep the JSON-RPC response
shape: `{ "jsonrpc": "2.0", "id": ..., "error": { "code", "message", "data"? } }`.

## Authentication

Every HTTP request must be admitted before its body is read:

```http
POST /mcp HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
```

The token is the one in `dsh-mcp-endpoint.json`; comparison hashes both sides and is constant-time.
`x-dsh-mcp-token` is accepted as an alternative header. A token in the query string is never
accepted, and a missing or wrong token gets 401 with `WWW-Authenticate: Bearer realm="dsh-mcp"`.
When the Host exposes its `connection` service and `allowConnectionAuth` is not false, callers that
the Harness connection fence admits may omit the token. The `x-dsh-mcp-client` header is attribution
only, never authentication: every token holder may name itself.

## Sessions and transport

This endpoint is stateless: it never returns `Mcp-Session-Id`, never requires one, and accepts a
client-chosen session header while ignoring it. A request before `initialize` is served normally, and
there is no server-initiated SSE stream — `GET` and `DELETE` answer 405 with
`allow: POST, OPTIONS`, while `OPTIONS` answers 204. One POST carries one JSON-RPC message (batches are refused
with `-32600`), and the reply is `application/json`. The body ceiling is 8 MiB by default and
`maxBodyBytes` clamps it to 1 KiB–64 MiB; an oversized body is 413 with `-32700`.

Envelope validation is structural: an object with a string `method`. The `jsonrpc` member is not
re-validated, so a message that omits it, or spells `1.0`, is still dispatched — while every response
declares `2.0`. The protocol layer does not reject unknown `params` members; each method validates the
fields it uses.

The stdio bridge adds one code of its own: `-32000` when it cannot reach the HTTP endpoint. That error
comes from the bridge, not from this gateway.

## Not supported

- `prompts/list` and `prompts/get`: no prompts capability, no prompt registry.
- `sampling/createMessage`, `elicitation/create` and `roots/list`: the server never calls the client.
- `completion/complete`: argument completion is not implemented.
- `resources/subscribe` and `resources/unsubscribe`: `subscribe` is advertised as false.
- `notifications/tools/list_changed` and `notifications/resources/list_changed`: never emitted.
- SSE resumption over `GET` and explicit session termination over `DELETE`: not implemented; both are 405.
- JSON-RPC batches and query-string bearer tokens: refused.
