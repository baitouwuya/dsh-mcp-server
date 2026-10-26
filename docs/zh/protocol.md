# 协议支持

> 属于 [DSH MCP Server](../../README.md) · [文档索引](../README.md)

这个端点在线上协议里回答什么，以及它刻意不做什么。网关实现在 `lib/protocol.js`，HTTP 绑定在
`lib/http-route.js`。自带的 stdio 桥（`bin/dsh-mcp-stdio.mjs`）把同样的消息转发到同一个 HTTP
端点，所以下面对两种传输都成立。

## MCP 版本

| 版本 | 行为 |
|---|---|
| `2026-07-28` | 客户端请求时原样回显。 |
| `2025-11-25` | 客户端请求时原样回显。 |
| `2025-06-18` | 请求时原样回显；也是未知或缺失版本时的回退值。 |
| `2025-03-26` | 客户端请求时原样回显。 |
| `2024-11-05` | 客户端请求时原样回显。 |
| `2024-10-07` | 客户端请求时原样回显。 |

这就是 `SUPPORTED_PROTOCOL_VERSIONS` 里的列表。`initialize` 会回显列表中的任意版本；其他值返回
`PREFERRED_PROTOCOL_VERSION`，即 `2025-06-18`。列在表里不等于默认值：除非客户端指定自己支持的
版本，服务端宣告的都是 `2025-06-18`。

## 方法

| 方法 | 类型 | 结果 |
|---|---|---|
| `initialize` | 请求 | `protocolVersion`、`capabilities`、`serverInfo`（`name`、`title`、`version`）以及部署的 `instructions`。 |
| `notifications/initialized` | 通知 | 接受，无结果。 |
| `ping` | 请求 | 空对象。 |
| `tools/list` | 请求 | 全部 21 个工具，每个带 `name`、`description` 和 `inputSchema`（声明了 `title`、`annotations` 或 `outputSchema` 时也一并返回）。 |
| `tools/call` | 请求 | `content` 块，处理器返回时还有 `structuredContent`。执行失败是带 `isError: true` 的结果；工具名未知是 `-32602` 错误。 |
| `resources/list` | 请求 | `resources`：`dsh://status` 与 `dsh://sessions`。 |
| `resources/templates/list` | 请求 | `resourceTemplates`：唯一的 `dsh://session/{sessionId}` 模板。 |
| `resources/read` | 请求 | 一条 `contents` 记录。未知 URI 是 `-32002`。 |
| `logging/setLevel` | 请求 | 空对象；级别被接受，但不会向客户端发送任何日志。 |
| `notifications/cancelled` | 通知 | 接受；服务端没有可取消的在途状态（stdio 桥会中止自己的转发）。 |
| `notifications/progress` | 通知 | 接受。 |
| `notifications/roots/list_changed` | 通知 | 接受。 |
| 其他任何方法 | 两者皆可 | 请求返回 `-32601`；作为通知到达时直接丢弃。 |

通知类方法同样走方法表，所以带 `id` 发送时仍返回状态 200 和 `{}`；不带 `id` 时才是通知，HTTP
传输回答 202。

## 能力声明

```json
{
  "tools": { "listChanged": false },
  "resources": { "subscribe": false, "listChanged": false },
  "logging": {}
}
```

能力声明是静态的，不随实际挂载的服务变化。没有 `prompts`、`sampling`、`completions` 或
`experimental` 能力，也没有资源订阅。`serverInfo` 给出构建身份（`dsh-mcp-server`、"DeepSeek
Harness MCP Server"、本次构建上报的版本），`instructions` 是部署给模型看的说明，本插件始终提供。

## 通知

服务端接受 `notifications/initialized`、`notifications/cancelled`、`notifications/progress` 和
`notifications/roots/list_changed`。它不发送通知，也不发起服务端到客户端的请求：没有
`notifications/message`，没有 `notifications/tools/list_changed`，没有
`notifications/resources/list_changed`，没有 sampling、elicitation，也没有 roots 请求。HTTP
传输在分发完通知后以状态 202 和空响应体确认。

## 错误码

| 错误码 | 名称 | 触发条件 |
|---|---|---|
| `-32700` | 解析错误 | 请求体不是 JSON，或超过请求体上限（同时返回 HTTP 413）。 |
| `-32600` | 无效请求 | JSON-RPC 批处理、非对象请求体，或信封里没有字符串 `method`。 |
| `-32601` | 方法不存在 | 方法不在上表中。 |
| `-32602` | 参数无效 | `tools/call` 缺少名字、参数不是对象，或工具名未知；`resources/read` 缺少字符串 URI，或会话 id 格式错误。 |
| `-32603` | 内部错误 | 处理器抛出了非 MCP 错误；需要 DSH 服务却不可用的 `resources/read` 是其中一种。 |
| `-32002` | 资源不存在 | `resources/read` 请求了本端点不提供的 URI。 |

工具真的执行并失败不算协议错误：结果带 `isError: true` 和一段可操作的文本，让调用方模型能反应。
协议错误保持 JSON-RPC 响应形状：`{ "jsonrpc": "2.0", "id": ..., "error": { "code", "message", "data"? } }`。

## 鉴权

每个 HTTP 请求都先通过准入，再读取请求体：

```http
POST /mcp HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
```

令牌来自 `dsh-mcp-endpoint.json`；比较时对两边做哈希，是常量时间的。`x-dsh-mcp-token` 是可选的
替代请求头。查询字符串里的令牌一律不接受；缺失或错误的令牌返回 401，并带
`WWW-Authenticate: Bearer realm="dsh-mcp"`。当宿主暴露 `connection` 服务且 `allowConnectionAuth`
不为 false 时，通过 Harness 连接栅栏的调用方可以不带头。`x-dsh-mcp-client` 只用于归因，从不用于
鉴权：任何持有令牌的调用方都可以自报身份。

## 会话与传输

端点是**无状态**的：从不返回 `Mcp-Session-Id`，从不要求它，客户端自带的会话头会被接受但忽略。
`initialize` 之前的请求照常服务，也没有服务端发起的 SSE 流——`GET` 与 `DELETE` 返回 405 和
`allow: POST, OPTIONS`，`OPTIONS` 返回 204。一个 POST 携带一条 JSON-RPC 消息（批处理以
`-32600` 拒绝），回复是 `application/json`。请求体默认上限 8 MiB，`maxBodyBytes` 把它夹在
1 KiB–64 MiB；超限返回 413 和 `-32700`。

信封校验是结构性的：对象里必须有一个字符串 `method`。`jsonrpc` 成员不会被再次校验，所以省略它、
或写成 `1.0` 的消息仍会被分发——但每个响应都声明 `2.0`。协议层不会拒绝未知的 `params` 成员；各方法只校验
自己用到的字段。

stdio 桥还会自己产生一个错误码：连不上 HTTP 端点时的 `-32000`。它来自桥，不来自这个网关。

## 不支持

- `prompts/list` 与 `prompts/get`：没有 prompts 能力，也没有提示词注册表。
- `sampling/createMessage`、`elicitation/create` 与 `roots/list`：服务端从不调用客户端。
- `completion/complete`：未实现参数补全。
- `resources/subscribe` 与 `resources/unsubscribe`：`subscribe` 声明为 false。
- `notifications/tools/list_changed` 与 `notifications/resources/list_changed`：从不发送。
- 基于 `GET` 的 SSE 续传与基于 `DELETE` 的显式会话终止：未实现，两者都是 405。
- JSON-RPC 批处理与查询字符串令牌：拒绝。
