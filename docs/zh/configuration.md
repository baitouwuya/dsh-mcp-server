# 配置

> 属于 [DSH MCP Server](../../README.md) · [文档索引](../README.md)

插件页上的每个开关，以及插件包行接受的每个字段。

## 插件自己的设置页

面板位于 Web **插件**页上插件包的**自有页面**，就在包标题之下、其组件行之上（页面之所以显示它，
是因为插件包注册了以包名为键的 `plugins.bundle.config` 条目）。它同时仍是插件包行的**配置**页，
因此两个入口到达的是同一组开关。它包含本插件的每个开关，所以其中任何一个都不需要改 YAML：

| 控件 | 写入项 |
|---|---|
| 开/关 | `exposeToDsh` |
| 暴露面：按需 / 一次全给 | `exposeToDshMode` |
| 侧边栏项目：加入 / 可创建 | `groupSessions`、`createGroups` |
| 忙碌时的投递：跟随设置 / 排队 / 插话 | `busyMode`（以及该设置当前解析出的值） |
| 任务启动进度同步：开 / 关 | `dsh-work-sync` 行上的 `syncOnStart` |

每个控件都通过配置档案的配置编辑器保存，并重载本插件的行，与手工编辑完全一致。面板沿用 Harness
自己的设置区样式：加粗的分区标题配一句简述（版本、已发布和已注册的数量），然后每个设置一行——
左侧是 14px 的标题叠在 12px 的描述之上，控件在右侧，行与行之间是一条 `.5px` 的细线。

这些控件是 Harness 自己的 UI 原语，而不是重新实现：`Switch`、`SegmentedControl`、`Pill` 和
`Button` 来自 `@deepseek-ai/dsh-client-ui-primitives`，由客户端模块加载器作为平台种子暴露。因此
开关是 DSH 尺寸的胶囊开关，分段选择是 DSH 的分段控件；它们在构造上就跟随主题。

该路由仅限回环**并且**做了浏览器侧加固：携带外部 `Origin`/`Sec-Fetch-Site` 的请求会经 DSH 自己的
连接防护被拒绝，请求体必须是 `application/json`，未知字段会被拒绝，超大的请求体会得到 `413`
而不是被重置套接字。不发送 `Origin` 的本地工具仍然可以 POST JSON。

## 插件包行字段

`cordis.patch.yml` 中的插件包行接受以下字段（全部可选）。`preset` 只填充行里没有显式设置过的字段；显式字段总是优先：


| 字段 | 默认值 | 含义 |
|---|---|---|
| `preset` | `delegate` | 命名默认组合：`delegate`（完整委派）、`strict`（每个调用方只看见自己的会话，忙碌时排队）、`observer`（不暴露本地工具面、不改侧边栏、不代答决策）。 |
| `path` | `/mcp` | Harness Web 服务器上的路由路径。 |
| `token` | 自动生成 | 固定的持有者令牌；设置它可让外部配置在重启后保持稳定。 |
| `url` | `$DSH_WEB_URL` 或 `http://127.0.0.1:19387` | 写入端点文件的对外基础 URL。 |
| `endpointFile` | `$DSH_HOME/mcp/dsh-mcp-endpoint.json` | 连接详情的发布位置。 |
| `writeEndpointFile` | `true` | 是否发布端点文件。 |
| `allowConnectionAuth` | `true` | 同时接受由 `ctx.connection` 放行的请求。 |
| `defaultCwd` | Harness 默认值 | 未指定 `cwd` 启动的会话的工作目录。 |
| `defaultModel` | Harness 默认模型 | **新启动**且未显式指定 `model` 的会话所用的 `{ provider, model, reasoningEffort? }`。继续的会话保持它已在运行的模型。 |
| `turnTimeoutMs` | `1800000` | 等待回合的工具调用的默认等待上限。到达它只会停止等待，绝不会停止回合。 |
| `maxConcurrentTurns` | `8` | 新调用进入排队前的并发等待回合数。`dsh_wait_session` 不启动回合，也不占名额。 |
| `answerUserRequests` | `false` | 成为部署的应答方之一：把本端点驱动的会话的审批和问题挂起，以便调用方用 `dsh_answer_request` 处理，并与 GUI 竞争（先决定者胜）。 |
| `answerOwnedSessionsOnly` | `true` | 开启应答后，只有 MCP 调用方创建或接管的会话会被挂起；其他卡片仍由 GUI 处理。 |
| `requestAnswerTimeoutMs` | `600000` | 挂起的请求在失败关闭之前等待 MCP 回答多久。 |
| `restrictToOwner` | `false` | 把每个调用方限制在它创建或接管的会话内：其他会话按 id 被拒绝，`dsh_list_sessions` 只返回它自己的会话。 |
| `clientsFile` | `$DSH_HOME/mcp/dsh-mcp-clients.json` | 调用方注册表（见过的智能体 + 会话所有者）的保存位置，权限 0600。 |
| `clientsFlushMs` | `5000` | 注册表写入落盘前合并多长时间。 |
| `exposeToDsh` | `true` | 把 MCP 工具暴露给 DSH 本身。`false` 让端点只提供 MCP。 |
| `exposeToDshMode` | `lazy` | `lazy` 注册三工具前门，其 `dsh_mcp_tools` 描述已经携带每个已发布名称及其必需参数（结果行只有 name/purpose/native），并让会话按需打开所需工具；`full` 在加载时注册全部二十一个（常驻 schema 开销）。未知值会在加载时报错。 |
| `exposeToDshPage` | `true` | 提供 Web 插件页开关读写的回环配置路由。 |
| `configPath` | `<path>-config` | 该配置端点的路由路径（默认 `/mcp-config`）。 |
| `entryId` | `dsh-mcp-server` | 配置页保存开关时针对的配置档案行。 |
| `groupSessions` | `true` | 把本端点启动的会话挂到其目录**已有**的项目上，并在后台一次性把早期版本留在“Ungrouped”的会话恢复回去。 |
| `createGroups` | `false` | 允许本端点为没有项目的目录新建一个侧边栏项目。默认关闭：自动化不会自行扩张侧边栏，目录没有项目的会话仍留在 Ungrouped。 |
| `busyMode` | `setting` | 发给已在运行的会话的投递方式：`setting` 跟随部署自己的 `ui-conversation.busyEnter`，`queue` 总是等到下一回合，`steer` 总是在回合中注入。调用方的 `mode` 参数优先于这三者。 |
| `syncEntryId` | `dsh-work-sync` | 设置页写入任务启动同步开关的配置档案行。 |
| `dsh-work-sync` → `syncOnStart` | `true` | **在同步行上**：任务开始时，询问同一工作区中其他智能体在做什么、在动哪些文件。插件页的开关保存的就是这一行。 |
| `dsh-work-sync` → `syncCooldownMs` | `300000` | 同一会话在再次询问同一同伴之前等待多久。 |
| `dsh-work-sync` → `syncWaitMs` | `120000` | 等待同伴的报告多久之后，告知提问方对方仍在工作。 |
| `dsh-work-sync` → `syncMaxPeers` | `3` | 一轮最多可以问多少个同伴。 |
| `maxBodyBytes` | `8388608` | MCP 端点的请求体上限。 |
| `configMaxBodyBytes` | `4096` | 回环配置路由的请求体上限。有意与 `maxBodyBytes` 分开：该路由只会收到开关补丁，因此保持小得多的上限。会被钳制在 1 KB - 1 MB 之间；超出范围的值（或非数字）会被忽略。 |
| `instructions` | 内置文本 | 替换交给调用方模型的说明文本。 |

示例行：

```yaml
- insert:
    - id: dsh-mcp-server
      name: '@local/dsh-mcp-server'
      config:
        token: !!js process.env.DSH_MCP_TOKEN
        defaultCwd: /Users/me/work
```
