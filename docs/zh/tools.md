# 工具与资源

> 属于 [DSH MCP Server](../../README.md) · [文档索引](../README.md)

21 个 MCP 工具、2 个资源和 1 个资源模板——每一项的设计都保证：任何一次调用都不会把整个会话一次性倾倒出来。

## 暴露的内容

| MCP 工具 | 用途 |
|---|---|
| `dsh_run_prompt` | 启动一个**新的** DSH 会话并运行一个提示词；返回助手最终的文本和新的 `sessionId`。支持 `cwd`、`agentPreset`、`permissionPreset`、`model`（`provider/model`）、`wait: false`、`timeoutMs`。 |
| `dsh_continue_session` | 向一个**已有**会话发送提示词（若它处于冷状态则恢复它）。保留会话的上下文和工作区；`permissionPreset` 在提示词之前重新固定会话的沙箱模式和审批策略，`model`（`provider/model`）覆盖会话的模型。未提供 `model` 时，会话沿用当前正在运行的模型。 |
| `dsh_ask_session` | 向某个会话提出一个它**必须回答**的问题，并等待答案。问题会获得一个 id（`q-…`），而调用不会先返回——提问的回合在没有答案的情况下无法结束。只有被问到的会话可以回答；问题未决期间，只携带 id 的提醒会注入目标会话自己的后续步骤（绝不会唤醒它）。`timeoutMs`（默认 0）设置可选的截止时间。 |
| `dsh_answer_question` | 由被问到的会话按 id 回答一个必须回复的问题。正在等待的 `dsh_ask_session` 调用会返回这段文本，提问的回合继续。 |
| `dsh_get_question` | 按 id 读取一个必须回复的问题：问题文本、提问者、提问时间、已发送多少条提醒，以及答案（如果已存在）。提醒只携带 id；目标会话正是通过这里重新读到问题的。 |
| `dsh_list_commands` | 某个会话的智能体当前可以运行的斜杠命令：全局命令层加上该智能体预设所组合的内容，因此可用性随智能体预设而不同。 |
| `dsh_run_command` | 在某个会话中运行一条斜杠命令，并返回其落定后的 `{ kind, text, commandId }`。`line` 接收完整的命令行（`"/compact"`、`"/permission danger-full-access"`）；`command`（加上可选的 `args`）接收裸名称。命令立即执行，不经过模型回合。 |
| `dsh_list_sessions` | 会话索引的一页：`sessionId`、标题、运行状态、归档状态、活动时间，以及记录在案的所有者智能体（`view: "full"` 会加上 cwd 和存活状态）。在服务端用 `query`（标题/cwd/所有者/id）、`mine: true`（或 `restrictToOwner` 设置）、`owner: "<id>"`（仅用于收窄：在受限端点上指定其他所有者会被拒绝）和 `running` 收窄结果；用 `cursor`/`nextCursor` 翻页。除非 `includeArchived: true`，归档会话会被隐藏，与 Web UI 保持一致。 |
| `dsh_read_session` | 某个会话对话记录的一个窗口（仅包含用户撰写和助手消息），外加最后一次持久化的 `permissionPreset`。`mode: "tail"`（默认，最后 10 条）/ `"head"` / `"outline"`（每条消息一行紧凑记录，含预览和长度，不含全文）；用 `roles`、`afterSeq` + `window.nextAfterSeq` 翻页，用 `maxChars`（默认 2000）限制单次回答的长度。会报告 `totalMessages`、`matchedMessages` 和 `returned`，因此调用方始终知道自己还有哪些没读到。`limit: 0` 请求最大的窗口（上限 1000 条消息），单次响应上限约 512K 字符（`truncatedByBudget`），所以一次读取永远不会倾倒整个长会话。会话处于归档状态时仍然可用。 |
| `dsh_answer_request` | 回答一个被挂起的决策，仅在部署设置了 `answerUserRequests: true` 时可用：审批用 `decision: "allow"|"deny"`（一次性授权，或拒绝），问题用 `answers: [{ id, selected }]`。id 来自 `dsh_list_requests`，该工具会把本端点挂起的请求标记为 `answerable: true`。GUI 仍在竞争中——谁先决定谁生效——未回答的请求仍会在 `requestAnswerTimeoutMs` 处按失败关闭（fail closed）。DSH 内部调用方只有在已持有 `danger-full-access` 时才能处理**审批**；问题则始终可以回答（见 [DSH 本地工具](dsh-local.md)）。 |
| `dsh_wait_session` | 阻塞直到某个会话已在运行的回合结束，然后返回该回合产生的助手文本——适用于 `wait: false` 启动、GUI 驱动的会话，或另一位调用方的工作。它从不发送提示词、从不插话、也从不取消：到达 `timeoutMs` 时返回 `status: "timedOut"`，此时回合仍在运行，因此需要再次调用；没有回合运行时，`status: "idle"` 会立即返回。 |
| `dsh_list_requests` | 某个会话（或最新的可见会话，运行中的优先）正在等待的用户决策：审批请求（`approval/asked` 没有匹配的 `approval/decided`，也就是沙箱提权背后的一次性权限决策）和未回答的 `ask_user_question` 调用，附带工具、原因、调用 id 和 seq。这些审计事件对模型不可见，因此调用方正是借此得知被委派的回合*为什么*停止推进。仅用于报告：决策在 Harness GUI 中授予。 |
| `dsh_search_sessions` | 在服务端按内容查找会话，得到有界片段而不是整份对话记录：匹配标题/cwd/所有者/id（`scope: "title"`），或匹配消息本身（`"messages"`，默认 `"both"`）。只查看调用方可见的最新 `scan` 个会话（默认 20 个），为每个匹配报告 `where`/`seq`/`snippet`，随后可用 `dsh_read_session` 只读取那个会话。 |
| `dsh_whoami` | 本端点如何识别调用方智能体——`x-dsh-mcp-client` 请求头，否则 `initialize` 的 `clientInfo`，否则 `User-Agent`——以及该智能体创建的会话。这是归属认定，不是身份认证：所有调用方共享同一个端点令牌。 |
| `dsh_cancel_session` | 取消某个会话的活动回合，但不会丢弃其待处理收件箱。 |
| `dsh_archive_session` | 持久地归档一个会话：从所有分组界面中隐藏，且在恢复之前无法运行模型步骤。有工作正在运行的会话会被拒绝，除非指定 `stopActivity: true`（先归档，再停止该工作）。归档会解除固定（pin）。 |
| `dsh_unarchive_session` | 把会话从归档集合中移除；它会重新出现在列表中，并回到其记录的工作区位置。 |
| `dsh_list_permission_presets` | 该部署的权限预设（每个预设把一种沙箱模式与一种审批策略打包在一起）以及新会话的默认值，供上面的 `permissionPreset` 参数使用。 |
| `dsh_list_tools` | DSH 暴露给自身智能体的工具，用于挑选被委派的提示词能做什么；`query` 按名称或描述收窄，`limit` 限制列表长度。 |
| `dsh_open_session` | 请求正在运行的 Web GUI 打开某个会话并在侧边栏中选中它——用于把人指向本端点启动的会话。命令会排入当前打开的页面队列，且只消费一次；会话本身不受影响。 |
| `dsh_status` | 端点、配置档案、版本、会话数与活跃智能体数、默认模型、活动回合、默认权限预设、投递策略、本地工具面（`dshTools`）、配置预设（`configPreset`），以及保持未决的必须回复问题（`questions`）。 |

归档需要 宿主的 `workspaceRegistry` 服务（`@deepseek-ai/dsh-workspace`）。缺少该服务时，两个归档工具会报告服务不可用，列表则直接省略 `archived` 字段，而不是靠猜测。

权限预设需要 宿主的 `permissionPresets` 服务（`@deepseek-ai/dsh-permission-presets`）。`permissionPreset` 通过该服务自己的 `set()` 应用——与 GUI `/permission` 命令是同一条写入路径——时机是会话已就绪、且其提示词被接纳之前，因此该回合自身的工具调用就能看到选定的沙箱模式和审批策略。结果会回显实际应用的预设；`dsh_read_session` 会把会话最后一次持久化的 `permission/preset` 事件重新并入其返回负载，`dsh_status` 则携带 `defaultPermissionPreset` 和目录。缺少该服务时，权限相关字段会被省略，`dsh_list_permission_presets` 会报告服务不可用。未指定 `permissionPreset` 创建的会话保持部署默认值，与 GUI 创建的会话完全一致。

命令需要 宿主的 `commands` 服务，并且按**智能体**而非按会话定位：注册表会把全局层与该智能体所挂载预设的各层合并，因此 `dsh_list_commands` 必须按会话询问，像 `/compact` 这样的命令只有在该会话的预设组合了它时才存在（`standard`/`ptc`/`cordis` 有；`minimal` 没有）。执行走的是 Web 输入框所用的同一个 `commands.execute()`：处理器立即运行，生命周期记录为 `command/run` + `command/done`，并且**不会启动模型回合**。`kind` 为 `success` 或 `error`；宿主无法解析为命令的行，或它不认识的名称，会被拒绝并列出可用命令。

## 渐进式披露

一个会话的日志可达数兆字节，而一个 Harness 可以容纳数百个会话，因此任何一次读取都不会是倾倒：每个工具只接受能回答调用方所需的最小问题，而且每份负载都会说明它*没有*返回什么。

| 需求 | 调用 |
|---|---|
| 存在哪些会话？ | `dsh_list_sessions({ mine: true, query: "tripothon", limit: 10 })`——索引行包含 id、标题、运行中、已归档、时间和所有者。 |
| 下一页 | 使用上一次结果中的 `cursor: nextCursor`。 |
| 长会话里有什么？ | `dsh_read_session({ sessionId, mode: "outline" })`——每条消息的角色、seq、字符数、预览。 |
| 刚刚发生了什么？ | `dsh_read_session({ sessionId })`——最后 10 条消息，附带 `window.reachedEnd`、`totalMessages` 和 `returned`。 |
| 继续往后读 | `afterSeq: window.nextAfterSeq`、`roles: ["user"]`，确实需要全文时用 `maxChars: 0`。 |
| X 在哪里被提到过？ | `dsh_search_sessions({ query: "mount", mine: true })`——来自标题/cwd/所有者以及最新 `scan` 个会话消息中的片段。 |
| 有哪些 Harness 工具？ | `dsh_list_tools({ query: "file" })`。 |

开销在结构上就受限：`scan`、`limit`、`perSession` 和 `maxChars` 是上限而不是提示，被截断的消息会带上 `truncated: true` 及其真实长度，而不是悄悄丢掉尾部。

## 待处理的用户决策

回合可能阻塞在模型永远看不到的东西上：审批请求（`approval/asked`，等待一次性权限决策）或一次 `ask_user_question` 调用。`dsh_list_requests` 从会话日志中整理出这些审计事件——传 `{ sessionId }` 查看单个会话，或扫描最新会话（运行中的优先）并用 `mine`/`owner` 收窄——然后返回每个请求的工具、原因、调用 id 和 seq。`includeSettled: true` 还会报告先前决策的处理结果（`allowed-once`、`rejected`、`cancelled`、`unavailable`）。

PTC 智能体为自己派发的问题（在 `run_code` 内部）由其派发开始事件整理而来，那是工具阻塞回合期间唯一持久的痕迹，并在该派发落定后关闭。读取和等待会以紧凑的 `pending` 摘要暴露同一状态，因此 `timedOut` 的等待不再让调用方只能猜测。

默认情况下这只是**报告**——决策在 Harness GUI 中授予。设置 `answerUserRequests: true` 后，端点成为组合回答者之一：它挂起请求并与其他所有回答者竞争，因此 GUI 卡片仍然有效，谁先决定谁生效（GUI，或 `dsh_answer_request`）。除非 `answerOwnedSessionsOnly: false`，否则只挂起 MCP 调用方创建或接管的会话；未回答的请求会在 `requestAnswerTimeoutMs` 处按失败关闭。两半都是 Cordis 瀑布监听器（`approval/request`、`user-questions/request`），而作用域过滤器会接纳未限定作用域的监听器，宿主插件正是以此接收智能体作用域的请求。

## 资源

- `dsh://status`——端点、版本、会话数与活跃智能体数，以及工具面。
- `dsh://sessions`——可见的会话索引。
- `dsh://session/{sessionId}`——某个会话的对话记录，按相同的窗口规则读取。
