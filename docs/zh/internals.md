# 内部实现

> 属于 [DSH MCP Server](../../README.md) · [文档索引](../README.md)

各部分如何协同工作，这里的“兼容”指什么，以及哪些仍属于限制。

## 架构

该插件是两份契约之间的适配器：对外是 MCP，对内是 DSH 服务。它发布的内容不导入任何 DSH 包，因此每一层都通过 `ctx` 和纯数据进行通信。

| 模块 | 职责 |
|---|---|
| [`index.js`](../../index.js) | 组合根：读取行配置，注册路由和本地工具，并负责插件的 `ctx.effect`（端点发布、路由/工具/状态清理），使重载时能回收它创建的资源。 |
| [`lib/protocol.js`](../../lib/protocol.js) | MCP 传输层：JSON-RPC 信封、协议版本协商、错误码、网关分派。 |
| [`lib/http-route.js`](../../lib/http-route.js) / [`bin/dsh-mcp-stdio.mjs`](../../bin/dsh-mcp-stdio.mjs) | 两种传输方式：Harness 监听器上的 Streamable HTTP，以及转发到同一端点的 stdio 桥接器。 |
| [`lib/dsh-capabilities.js`](../../lib/dsh-capabilities.js) | 面向 DSH 的工具和资源；每一项都映射到活的服务（`sessionController`、`sessionQuery`、`tools` 等）。 |
| [`lib/capabilities/definitions.js`](../../lib/capabilities/definitions.js) | 静态目录：全部工具 schema 与 3 个 `dsh://` 资源描述，使面向调用方的契约不必穿过活服务管线即可阅读。 |
| [`lib/capabilities/requests.js`](../../lib/capabilities/requests.js) | 用户决策：从会话日志折出待决审批与提问的纯函数，以及让 MCP 调用方结算它们的挂起/应答钩子（活的部分由外部注入）。 |
| [`lib/authority.js`](../../lib/authority.js) | 这些工具受其约束的权限计算：沙箱阶梯、工作区包含关系，以及 `cwd` 钳制。 |
| [`lib/dsh-contracts.js`](../../lib/dsh-contracts.js) | 工具所读取的事件和消息形态：会话 id、消息正文、对话记录行、回合编号、失败文本——只定义一次，而不是每个调用方各复制一份。传输层级的错误格式化仍留在传输层。 |
| [`lib/dsh-tools-bridge.js`](../../lib/dsh-tools-bridge.js) | 同一张表暴露*进* DSH 内部：三个工具的入口，或安装到注入工具作用域的完整注册表，以及在调用智能体自身作用域中惰性打开的工具。 |
| [`lib/clients.js`](../../lib/clients.js) | 调用方标识与会话归属：请求头/`clientInfo`/User-Agent、一个 0600 注册表，以及会话所记录的归属所有者。 |
| [`lib/config-route.js`](../../lib/config-route.js) + [`lib/client.js`](../../lib/client.js) | 控制平面：一条回环 JSON 路由，以及读写它的浏览器面板——渲染在插件包自己的插件页上（位于其组件行上方），同时也作为该行的 Configure 页面。 |
| [`lib/transcript.js`](../../lib/transcript.js) | 窗口化对话记录读取：tail/head/outline、按角色和序号过滤、单条消息上限以及响应预算。 |
| [`work-sync.js`](../../work-sync.js) | **第二个插件包行**：挂载任务启动进度同步，将其发布为 `workSync` 服务，并管理自己的配置。 |
| [`lib/work-sync.js`](../../lib/work-sync.js) | 同步引擎本身：向谁询问、认领关联、截止时间——只建立在 `session/event` 之上。 |
| [`lib/questions.js`](../../lib/questions.js) | 必须回复的问题：id、阻塞等待、注入到目标自身调用中的仅含 id 的提醒、人工停止的结算、答案，以及死锁/中止处理——投递与时钟都是注入的。 |
| [`lib/workspace-grouping.js`](../../lib/workspace-grouping.js) | 把该端点启动的会话放入其目录已经所属的侧边栏项目。 |

三条规则确保分层名副其实。**用服务，而不是重新实现**：对话记录读取重放持久事件日志，权限来自 `permissionPresets`，侧边栏成员关系来自 `workspaceRegistry`。**接缝要窄**：传输层从不接触会话，能力层从不接触套接字。**磁盘上只存自己的状态**：本插件持久化的所有内容都是它自己的状态（默认 `$DSH_HOME/mcp/*.json`；可通过 `endpointFile` 和 `clientsFile` 迁移），以 0600 权限——绝不是会话、对话记录或 DSH 已经拥有的设置。

## DSH 兼容性

插件包不导入任何 DSH 包，因此兼容性取决于服务契约，而不是版本锁定。它已在运行中的 Harness 上针对 **DSH 0.2.1-rc.3**（Cordis 4.0.5）做过验证：会话控制器（`list`、`resolveAgent`、`create`、`cancel`、`follow`、`selectModel`）、`sessionQuery`、实时的 `agents` 注册表及其句柄方法（`followup`、`steer`、`inject`）、`permissionPresets`、`commands`、`workspaceRegistry`、`configEditor`、`clientModules`、Web 服务器路由、`session/event` 的形态与回合结束原因，以及 Web 模块加载器的种子（`react`、`@deepseek-ai/dsh-client-ui-primitives`、`…-ui-slots` 等）与 `plugins.row.config` / `plugins.bundle.config` 槽位键。

有一条 Harness 规则对所有响应 `session/event` 的插件都很重要：监听器运行在**会话的追加提交内部**，此时嵌套追加会被拒绝（`session append cannot reenter while another append is being published`）。本插件包从监听器发出的每次投递——必须回复型提醒的注入或撤回、work-sync 的报告或超时提示——都会在投递前让出一个微任务，确保提交已经先关闭。

## 模型体验

调用模型看到的内容，以及为什么这样设计：

- **`initialize` 指令是地图，而不是工具清单的倾倒。** 它说明哪个工具用于启动会话、哪个用于继续会话，何时使用 `wait: false` + `dsh_wait_session`（等待从不取消），读取是窗口式（`mode`/`maxChars`/`afterSeq`）而非全量倾倒，以及审批和问题是按会话报告的，并且只有当部署启用了 `answerApprovals`/`answerQuestions`（或旧的 `answerUserRequests`）时才可回答。
- **描述承载了 schema 无法承载的内容。** `dsh_run_command(sessionId, line|command)` 在签名中写明了它的两种形态，因为模型如果照着错误的形态调用，结果比没有描述更糟。
- **失败是分类型的。** 未知工具或格式错误的资源 id 会返回 `-32602 invalidParams`；普通的工具失败是 `isError` 结果，不会结束回合。消息会说明下一步该做什么（“用 `stopActivity: true` 重试”、“在 Harness GUI 中提高此会话的预设”），而不是泄露堆栈。
- **工具面感知提示词开销。** `exposeToDshMode: lazy` 给 DSH 会话三个工具，而 `dsh_mcp_tools` 的描述已经携带所有已发布的名称及其必需参数（结果行是名称、用途和 `native`）；`full` 则把全部 21 个放入提示词。
- **状态只需一次调用。** `dsh_status` 回答“我在跟什么通信”——端点、插件版本、当前模型选择、投递策略、同步状态、工具表形态——无需探测。

## 验证

```bash
node test/mcp-self-test.mjs            # 11 transport checks, no Harness needed
node test/contracts-test.mjs           # 6 checks: the Harness wire shapes, pinned in one place
node test/authority-test.mjs           # 5 checks: the sandbox ladder, containment, and the cwd clamp
node test/transcript-test.mjs          # 7 checks: transcript windows, cursors, caps and the response budget
node test/questions-test.mjs           # 17 checks: must-reply ids, injected id-only reminders, human stops, answers, deadlines, aborts, deadlocks
node test/work-sync-test.mjs           # 22 checks: the progress-sync engine against a fake Harness
node test/work-sync-plugin-test.mjs    # 5 checks: the sync bundle row's service, messages, switch, disposal
node test/turn-wait-test.mjs          # 2 checks: which turn a queued or steered prompt reports
node test/integration/protocol-and-tools.mjs       # 26 checks: apply(), endpoint file, tools, status, the
                                                   # lazy front door, its authority ceiling, lossless values
node test/integration/sessions-and-identity.mjs    # 17 checks: waiting, whoami, ownership, restrictToOwner
node test/integration/archive-permissions-commands.mjs # 24 checks: archive, permissions, models, commands
node test/integration/transcripts.mjs              # 11 checks: outline/tail/paging, index, search, budget
node test/integration/decisions.mjs                # 20 checks: parked approvals/questions, per-kind answering, must-reply, busyMode
node test/integration/config-and-grouping.mjs      # 32 checks: config route, presets, grouping, delivery, hot reload
node test/mcp-conformance-test.mjs                 # 26 checks: protocol versions, methods, errors, auth
node test/client-half-test.mjs         # 18 checks: the browser half's bundle page, its row page, its route
node test/stdio-bridge-test.mjs        # 4 checks, needs a RUNNING Harness (one real delegated turn)
node test/live-e2e-test.mjs            # 46 checks over HTTP: protocol, resources, all twenty-one tools,
                                       # archive/unarchive, permission presets, commands, error paths,
                                       # 4 real turns (needs a Harness)
```

`npm run check:docs` 守的是 Markdown：每个相对链接与锚点都可解析，`docs/zh/` 与 `docs/en/` 保持相同的标题层级、表格、代码围栏和行内标识符。CI（`.github/workflows/ci.yml`）两者都跑。

桥接器的 schema 投影已针对 Harness **自身**的 JSON-Schema 校验器（从应用包中提取）验证：21 个原始 MCP schema 中有 15 个使用了 `minLength`，而该校验器会直接拒绝这个关键字；全部 21 个投影后的 schema——以及各种形态的规范值——都能被接受。

开发过程中使用的实机检查还覆盖了：针对运行中 Harness 的真实 MCP 客户端交互，端到端的 `dsh_run_prompt` → `dsh_continue_session` → `dsh_read_session` 流程，通过 MCP 应用并重新固定权限预设、再将其从对话记录中折回，在不新增模型消息的情况下执行命令，等待一个已分离的回合而不取消它，通过请求头与 User-Agent 两级识别调用方，窗口化/大纲式对话记录读取，分离启动 + 取消，以及 stdio 桥接器。

## 发布

版本号出现在三处，必须一起改：`package.json`、`index.js` 的 `VERSION`、两份 README 的「状态」一节；再加一条 `CHANGELOG.md` 记录。测试或文档数量变化时，`docs/*/internals.md` 与 README 里的数字也要同步。`npm run verify` 全绿才继续。

然后推一个 tag，由工作流发布：

```bash
git tag v0.23.0
git push origin v0.23.0   # 触发 .github/workflows/publish.yml
```

工作流先核对 tag 与 `package.json` 的版本、跑测试与文档守卫，再用 npm 的 provenance 发布。首次发布用 `NPM_TOKEN` secret；之后在 npm 上把本仓库与 `publish.yml` 配成受信发布者（trusted publisher），工作流会改走 OIDC，不再需要令牌。手工发布等价于 `npm publish --provenance --access public`。

包名就是行名：`cordis.patch.yml` 两行的 `name` 必须等于 `package.json` 的 `name`，所以改包名是破坏性变更——已有配置档案的依赖必须同步替换，否则行解析不到模块。

## 说明与限制

- **对外公布的 URL 就是监听器自己的 URL。** 该行的 `url` 和 `DSH_WEB_URL` 仍然优先，但两者都未设置时，端点文件会在应用就绪后跟随 `ctx.webServer`（`protocol`/`host`/`port`），因此 GUI 端口由操作系统分配的 Harness 不会再向 stdio 桥接器和其他客户端公布一个失效的 `19387` URL。

- **改代码需要重启 Harness。** 重新启用插件包会重载它的行，但会复用已导入的模块代际，因此修改过的插件代码只有在重启 DSH 后才生效。配置变更会立即到达运行中的实例；修改插件包的包路径可能会报告 `restart-required`。
- **持有者令牌是本地机密。** 桌面配置档案把它保存在 `$DSH_HOME/profiles/desktop/cordis.patch.yml`，`selfcheck/cordis.patch.yml` 中也重复了一份。轮换时请同时更新这两处。它授权通过回环进行完整的 DSH 会话控制，请按此对待。
- **仅限 localhost。** 端点依附于 Harness Web 服务器，后者绑定回环地址。把它暴露给另一台机器是有意的网络改动，而不是插件设置。
- **审批与用户问题。** 通过 MCP 启动的回合按会话自身的审批和沙箱策略运行（`permissionPreset`，或部署默认值）；如果某个被委派的回合需要审批，提示会像其他会话一样出现在 Harness GUI 中。从 GUI（`/permission`）和通过 MCP 切换会话预设写入的是同一批持久事件，因此每个会话以最后写入者为准。
- **命令是即时执行且按智能体生效的。** `dsh_run_command` 在目标智能体的命令层上运行（全局 + 该智能体的预设），因此像 `/compact` 这样的预设范围命令可能在另一个会话中不存在。它不会排在正在运行的回合之后，并且可以修改会话状态（`/permission`），所以它的权限等同于在 GUI 中输入该命令；先调用 `dsh_list_commands` 是了解某个会话接受哪些命令的办法。
- **任务启动同步是独立的一行。** `dsh-work-sync` 由本插件包的 patch 插入并管理自己的配置；没有它，端点仍然提供 MCP 服务，`dsh_status.sync.present` 为 `false`，保存开关时会说明需要添加哪一行。它的引擎状态保存在内存中，因此重载该行会丢弃仍然未决的问题。在 `dsh-mcp-server` 行上携带旧 `syncOnStart` 的配置档案只会把它当作提示——同步行自己的配置才是权威。
- **设置页保留默认路由和行键。** `configPath`/`entryId` 会改变 宿主提供路由的位置以及写入哪一行，但浏览器部分在构建时固定为 `/mcp-config` 和 `<package>#<row id>`；重命名路由或行需要匹配的构建。
- **本地接口需要 Harness 工具注册表。** `ctx.tools`（`@deepseek-ai/dsh-tools`）在每个随附的配置档案中都会被组合进来；缺少它时，工具就只保留在 MCP 侧，日志也会说明这一点。
- **新增浏览器部分需要重启。** 宿主侧的工具会在行重载时到位，但 Web 客户端依赖图在启动时组合，因此新增的 `lib/client.js` 或 `dsh.client` 声明只有在重启 DSH 后才会显示其 **Configure** 页面。
- **打开的工具会在会话期间一直保持打开。** `dsh_mcp_open` 注册到调用智能体的作用域，在智能体被销毁之前没有任何东西会移除它们，因此把一切都打开的会话会持续为此付出代价。只打开任务需要的少数工具；一次性调用请使用 `dsh_mcp_call`。
- **分组是侧边栏自身的成员记录。** 会话的项目是记录下来的，而不是在渲染时推导出来的，因此“它在该目录中运行”并不够——必须有东西把它挂上去。本插件会对它启动的会话这样做，并且对它此前启动过的会话补做一次，而且只会加入已经存在的项目。
- 通过 MCP 启动的会话就是普通的 DSH 会话：它们出现在 Harness 会话列表中，可以在 GUI 中打开并继续。
