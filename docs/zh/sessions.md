# 会话与投递

> 属于 [DSH MCP Server](../../README.md) · [文档索引](../README.md)

调用方如何被识别、会话如何归属、如何等待一个回合，以及会话会出现在哪里。

## 调用方身份与会话归属

每个请求都会被归属到某个调用方智能体，`dsh_run_prompt` 创建的每个会话也都记录在该智能体名下，因此共享端点可以回答“*这个*智能体启动了哪些会话？”：

| 层级 | 信号 | 示例 |
|---|---|---|
| 1 | `x-dsh-mcp-client` 请求头（stdio 桥上则是 `--client` / `DSH_MCP_CLIENT`）；后面可跟版本，形式为 `name@version` | `codex`、`claude-code@2.1.295` |
| 2 | MCP 客户端在 `initialize` 时发送的 `clientInfo` 块，按显式客户端标签缓存 | `claude-code 2.0.1` |
| 3 | `User-Agent` | `cursor/1.2` |
| 4 | 认证对端（持有者令牌，或 DSH 连接信任） | `token` |

某一层级绝不会借用更低层级的信息：设置了请求头的调用方仅以该标签命名，即使另一个客户端的 `clientInfo` 共享同一个 User-Agent。`dsh_whoami` 返回解析出的身份、其 `source` 层级，以及该智能体创建的会话；`dsh_list_sessions` 为每一行标注 `owner` 和 `mine`，并接受 `mine: true`。注册表位于 `$DSH_HOME/mcp/dsh-mcp-clients.json`（0600），因此归属关系能在 Harness 重启后保留。

这是**归属认定，不是身份认证**：每个调用方出示的都是同一个端点令牌，客户端可以用请求头把自己命名成任意名称。因此 `restrictToOwner: true` 约束的是诚实的调用方，而不是持有令牌的攻击者：它是防误操作的护栏，不是凭据边界。开启后，调用方只能对自己创建的会话（或接管的会话：没有记录所有者的会话，例如 GUI 启动的会话，会被第一个驱动它的调用方接管）执行列出、读取、等待、继续、取消、归档或运行命令。`owner` 过滤器无法扩大该范围——指定其他所有者会被拒绝——属于他人的会话也会被拒绝，并在诊断信息中指明所有者。

## 等待回合

`dsh_run_prompt` 和 `dsh_continue_session` 默认等待自己的回合。当一次调用不能阻塞整个回合时，用 `wait: false` 启动，再用 `dsh_wait_session` 跟进：

| 结果 | 含义 |
|---|---|
| `status: "completed"` / `"error"` | 回合已结束；`text` 是它产生的内容，`turnEndReason` 是 宿主给出的原因。 |
| `status: "timedOut"` | 到达 `timeoutMs`，回合**仍在运行**——再次调用 `dsh_wait_session`。 |
| `status: "idle"` | 没有回合在运行，因此调用立即返回。 |

任何等待路径都不会取消会话或向会话插话：达到上限和调用方断开都只是停止等待。因此，自带调用超时的客户端可以把 `timeoutMs` 设得比它更短，然后重新等待，而不是循环轮询 `dsh_read_session`。只有 `dsh_cancel_session` 会停止回合。

## 会话、项目与消息投递

### 端点启动的会话会加入其目录所属的项目

Web 侧边栏按 Workspace 注册表中**记录在案的成员关系**（`workspace.sessionIds`）对会话分组，而不是在渲染时比较目录；而注册表的一次性引导只把首次运行时已存在的会话分了组。因此，本端点后来创建的会话会滞留在**未分组（Ungrouped）**中，即使它所在目录已经是一个项目。

`dsh_run_prompt` 会把它刚创建的会话附加到其目录**已经**拥有的项目上，并以 `workspace: { id, path, title, created, attached }` 返回。它从不凭空创建项目：没有项目的目录，其会话仍留在未分组中，这也正是 Harness 自己会放置它们的地方。`createGroups: true` 选择凭空创建一个；`groupSessions: false` 关闭整套行为。

继续调用只会加入已有项目，绝不创建项目。插件在激活时还会在后台按同一规则修复一次积压：凡是它自己的调用方注册表归属于某个调用方、且目录已是项目的会话，都会被附加——正是这一步把更早版本创建的会话移出未分组。本端点确实创建过的项目可以用 `POST /mcp-config { "removeGroups": ["/abs/path"] }` 再次移除，也可以从侧边栏自己的删除操作移除；无论哪种方式，会话都会保留，只是回到未分组。

### 排队或插话，遵循部署自身的设置

`dsh_continue_session` 接受 `mode: "queue" | "steer"`。省略时，它遵循本部署的 `ui-conversation.busyEnter`——即 Web 输入框回车键所遵循的设置——因此向忙碌会话发送内容时的行为与用户自己输入时一致。`busyMode` 为所有调用固定一种行为（`"queue"` 或 `"steer"`），其默认值 `"setting"` 则继续跟随实时设置。结果会回显实际使用的模式（`mode: "steer" | "queue"`）。

### 来自 DSH 的消息会标明发送它的会话

从 DSH 内部发送的提示词在投递时会带上一个持久来源——`{ kind: "dsh-mcp-server", sessionId: "<the sending session>", agentId }`——因此目标会话的对话记录会说明消息来自哪里，而不会读起来像是用户在输入，结果中则携带 `from: "<sending session>"`。外部 MCP 调用方保留会话控制器自身的 `user` 来源：它们不是 DSH 会话，因此没有可标明的会话 id。

### 规范结果是无损 JSON

Harness 会校验工具的规范值，而内部（PTC）调用没有 JSON 序列化往返来藏住嵌套的 `undefined`：负载中任何一处未设置的字段都会让整个调用失败，并报 `value is not lossless JSON`。面向 DSH 的接口会在返回前用 `JSON.parse(JSON.stringify(...))` 对每个结果做一次投影，因此未设置的字段只会消失。

## 让 GUI 指向某个会话

`dsh_open_session({ sessionId })` 请求当前打开的任意 Harness 页面打开该会话并在侧边栏中选中它。这正是“告诉某人一个会话 id”与“把会话展示给他”之间的区别。

DSH 只向浏览器转发**白名单内的 宿主事件**，而该列表在 DSH 构建时就已固定，因此插件无法推送自己的通知。页面改为轮询本插件的回环路由：

| 步骤 | 发生什么 |
|---|---|
| 1 | 工具（或 `POST /mcp-config { "openSession": "<id>" }`）在 宿主上排队一条命令。 |
| 2 | 打开的页面在可见期间每 1.5 秒轮询一次 `GET /mcp-config`，读取 `command`。 |
| 3 | 它调用客户端自己的 `uiWorkspace.openSession(id)`，然后用 `{ "ackCommand": true }` 确认。 |

没有被任何页面消费的命令会在 60 秒后过期，因此稍后打开 GUI 绝不会意外跳转。该工具会拒绝 Harness 不认识的 id，并且不改变会话的任何方面：没有回合、没有消息、没有状态。
