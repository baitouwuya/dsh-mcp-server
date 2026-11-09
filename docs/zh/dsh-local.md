# DSH 本地工具

> 属于 [DSH MCP Server](../../README.md) · [文档索引](../README.md)

同一张工具表，也可以在 Harness 内部调用——但对调用方能做什么设有上限。


该端点的工具**同样**可以在运行中的 Harness 内部调用——无需第二个进程，也无需 MCP
客户端配置。默认开启；设置 `exposeToDsh: false` 可以让插件只提供 MCP。

## 按需加载，而不是一次全给

二十六个工具的 schema 合计约 25 KB（约 6.3k tokens），在**每个**会话里都是常驻的提示词开销，
无论该会话是否真的委派过任何事。所以默认的暴露面是一扇三工具的“前门”：

| 前门工具 | 用途 |
|---|---|
| `dsh_mcp_tools` | 目录——每个已发布的名称**连同其调用签名**——外加每个工具一行说明，已可直接调用时标 `native`。`name` 返回该工具的参数 schema，并按 DSH 注册表投影。 |
| `dsh_mcp_open` | 把指定的工具（**或 `all: true`）注册进*当前*会话**，使其从下一步起可原生调用。目标始终显式：列表为空或缺失时会被拒绝，而不是悄悄打开全部二十六个。 |
| `dsh_mcp_call` | 直接调用一个已发布的工具而不打开它——适用于不值得占用常驻 schema 的一次性调用。 |

这样静态开销约为 3.2 KB（约 820 tokens）而不是约 25 KB，工具表剩下的部分只由真正用到它的
会话来付费。`dsh_status` 会报告整体形态：
`dshTools: { enabled, mode, registered, published, via }`。

## 无需先查即知

如果前门只说“存在一个目录”，模型就要多付一步：它得先调用 `dsh_mcp_tools` 才能调用别的任何
工具，而且每个新会话都要再付一次这一步。所以前门直接给出目录本身——每个已发布名称及其必需
参数，就写在 `dsh_mcp_tools` 自己的描述里：

> 发布 26 个：dsh_run_prompt(prompt)、dsh_continue_session(sessionId, prompt)、dsh_ask_session(sessionId, question)、…

这个索引约 1.5 KB（约 375 tokens），把“把这段发给会话 X”变成一次调用：
`dsh_mcp_call({ tool: "dsh_continue_session", arguments: { sessionId, prompt } })`。名称匹配很宽容：
只写 `continue_session` 也能解析；写得接近但不完全对时会被拒绝，并列出相近的匹配；
`arguments` 接受 JSON 对象字符串；被拒绝的调用最后会指出用 `dsh_mcp_tools({ name })` 查询即可
修正。索引就是全部发现成本——在实际打开某个工具之前，不再付出别的开销。

有两个工具的 `required` 列表并不等于它们的完整签名，索引里对此作了说明——
`dsh_run_command(sessionId, line|command)` 和 `dsh_answer_request(requestId, decision|answers)`——
因为让模型照着签名调用却被拒绝，比不给签名更糟。

## 会话进行中追加工具

`dsh_mcp_open` 不是什么命名把戏：DSH 支持在会话运行期间追加工具，两种呈现方式都跟随注册表。

- **原生模式**改变请求的工具集。智能体循环会写一条新的 `request/header`，并追加一条携带
  `tool-addition`（以及 `tool-removal`）块的 `developer/message`，由提供方适配器按自身
  `toolUpdate` 模式要求的形式（`addition-only` 或 `in-history`）渲染。
- **PTC 模式**无论挂载了什么，都只发送一个 `run_code` 工具，因此被打开的工具改为出现在提示词内
  重新生成的 SDK 中。在本仓库自己的会话中实测：打开两个工具后，组装出的 `system/message` 从
  60,499 个字符增长到 62,404 个字符，新名称出现在其中，而每条 `request/header` 仍然只列出
  `run_code`。

无论哪种方式，注册都进入**调用方智能体**的作用域，因此只跟随该智能体，并在它被销毁时回退——
一个会话里的 `open` 绝不会泄漏到另一个会话。

改为设置 `exposeToDshMode: "full"` 可以在加载时把整张表放进提示词，这也是 v0.7.0 的做法。

| 位置 | 内容 |
|---|---|
| Web **插件**页 → 本插件包的页面（或某行 → **配置**） | 开关和暴露面模式，直接显示在插件包页面上。它们通过配置档案的配置编辑器保存，因此和一个手工编辑一样落到 `cordis.patch.yml`，并重载该行。 |
| `GET /mcp-config`（仅回环） | 当前状态：`exposeToDsh`、`exposeToDshMode`、MCP URL、已发布和已注册的名称、版本。 |
| `POST /mcp-config` `{ "exposeToDsh": false }` 或 `{ "exposeToDshMode": "full" }` | 与页面执行的那些写入相同。 |
| `POST /mcp-config` `{ "removeGroups": ["/abs/path"] }` | 按目录删除项目注册——用来撤销分组自动化。不会触碰任何文件夹、文件或会话；这些会话回到 Ungrouped。 |

`dsh_status` 和 `GET /mcp-config` 还会报告 `clientPage: { available, inGraph, bundle }`——由 宿主的
浏览器模块注册表回答本插件包的页面是否真的在被提供。直到一次重启把新增的客户端部分组合进来
之前，它一直是 `inGraph: false`，这正是“页面缺失”和“页面尚未构建”的区别。

## 内部消息的来源标注

本插件送进会话的每条消息都带一个持久的 `source`：`dsh_continue_session` 触发的提示词记作
`{ kind: 'dsh-mcp-server', sessionId: <calling session>, agentId }`，进度同步的通知与报告记作
`{ kind: 'dsh-work-sync', sessionId: <asking session> }`。Harness 自己的转投（智能体消息、团队消息、
子智能体结束）用 `source.senderSessionId` 记同一个东西。

对话流默认只渲染正文，这类消息看起来就像人打的。Client 半边因此在
`conversation.chat.user.before`（用户气泡同一行内、气泡上方）注册了一行：

> ✈ 来自「sync-engine」· 进度同步

名字取会话列表里的 `displayTitle`，没有就用子智能体的 label，再没有就显示 8 位短 id；点一下在主页
打开那个会话。来源会话还没加载出来时这一行只显示短 id，不做成按钮。人自己打的消息、以及替外部 MCP
客户端投递（没有会话 id）的消息，不显示这一行。

没有人触发、由通知唤醒的回合，DSH 默认画的是一张“收到执行请求”卡片而不是气泡。本插件把
`conversation.chat.node` 的 `turn-trigger` 格子以更低的优先级遮蔽掉：`dsh-mcp-server` 与
`dsh-work-sync` 两类投递按消息来画——右对齐的气泡，上方是「来自「<会话标题>」· <投递类型>」，点一下就
打开那个会话；超过 12 行或 700 字的投递自动折叠成固定高度（边缘渐隐），底部是「展开全部（N 行）」，
展开后变「收起」。气泡容器和正文渲染都复用 Harness 自己的 `UserMessageBubble` 与 `MarkdownText`，
所以外观和真人消息一致（Markdown 渲染失败时退回纯文本）。其余唤醒家族（定时任务、目标、webhook、后台任务）仍用原卡片，带时钟和折叠。

不喜欢气泡的话，插件页有「内部消息的呈现」开关：**气泡**（默认）或 **提醒卡片**（Harness 原本的
“收到执行请求”卡片）。它写在 `dsh-mcp-server` 这一行的 `internalMessageStyle`（`bubble` | `card`），
和其它开关一样经过校验，保存后这一半会重新加载。

## 权限上限

内部调用方会被归因并受钳制，从不被信任：

- **归因。** 本地调用记在 `dsh-agent:<sessionId>` 名下——即发起调用的会话，而不是端点——因此
  `dsh_whoami`、`mine: true`、`restrictToOwner` 和 `answerOwnedSessionsOnly` 对它完全和对 MCP
  调用方一样适用。
- **预设不得超出调用方自身的文件策略。** 当预设的沙箱宽于调用方当前模式
  （`read-only` < `workspace-write` < `danger-full-access`）时，`dsh_run_prompt`/`dsh_continue_session`
  上的 `permissionPreset`，以及 `dsh_run_command` 上的 `/permission <preset>` 都会被拒绝。更窄或
  相同的预设允许使用。这把尺子按预设**授予的沙箱**而不是名字来判断：0.2.2 的保留预设 `auto`
  （在 `danger-full-access` 沙箱下逐次审查，仅在其集成被组合时存在）按最宽档位对待，而 `custom`
  （会话旋钮不匹配任何预设时的读数）从不作为授权使用。
- **内部调用方启动的会话被钉在自己的档位上。** 没有显式预设时，新会话获得调用方自己的预设，或
  调用方模式下配置的最宽预设——绝不会是部署默认值，因为它可能比调用方更宽。
- **审批需要最宽的档位。** 处理一个审批会给提问的会话一个严格宽于自身的沙箱，所以内部调用方
  只有在已持有 `danger-full-access` 时才能回答审批；其他情况都留给 Harness GUI。问题不涉及
  权限，始终可以回答。
- **会话在调用方自己的工作区内启动。** 内部调用方启动的会话，其 `cwd` 必须解析到该调用方记录
  的工作区根目录之内（包含符号链接）；没有 `cwd` 时默认为该根目录。DSH 从会话的 cwd 取得其
  workspace-write 边界，因此指定另一个目录会让新会话拿到比调用方更宽的写根。
- **驱动已有会话同样受钳制。** `dsh_continue_session` 和 `dsh_run_command` 会拒绝这样的目标：沙箱
  模式宽于调用方，或可写工作区落在其外部。

外部 MCP 调用方不受影响——它们出示本端点的令牌，而该上限约束的是从 DSH 内部发起的调用。
无论何时竞争，Harness GUI 都仍是应答方之一。

## 用 DSH 自己的 MCP 客户端连进来

DSH 0.2.2-rc.1 自带 MCP 客户端，所以除了上面这扇内建前门，也能让 Harness 像连接任意 MCP
服务器那样连接本端点。工具会以 `mcp__<serverName>__<name>` 的形式出现在会话里：

```yaml
- id: mcp-self
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: dsh
    transport: streamable-http
    url: http://127.0.0.1:19387/mcp
    headers:
      Authorization: Bearer <token>
```

两条路分工不同：内建前门零配置、按需加载，一次性调用走 `dsh_mcp_call`；原生客户端把每个工具都注册
成常驻工具（`mcp__dsh__*`），schema 一直占着提示词，通常只在确实需要那个命名形状时才值得开启。

通过这一行发起的每次调用都受 `toolCallTimeoutMs`（默认 60 秒）限制，而且它管的是整次调用：等待更久的
`dsh_wait_session` 会直接在客户端里失败，与服务端发什么无关。要用长等待就把它调大，或者分段等待——
`status: "timedOut"` 是正常答复，再调一次就是接着等。

端点 URL 与令牌写在 `$DSH_HOME/mcp/dsh-mcp-endpoint.json`。URL 里的端口由 Harness 在启动时分配，
不是历史默认的 `19387`，所以别把它写死：插件会把 URL 发布成环境变量 `DSH_MCP_URL`，补丁表达式
可以读取它；需要在监听绑定之前就知道 URL 时，先把 Web 端口固定下来。令牌是本机密文，不要写进共享
配置，也不要提交到仓库。