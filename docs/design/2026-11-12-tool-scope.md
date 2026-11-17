# 工具作用域（全局 / 按工作区）设计

> 2026-11-12。让本插件暴露给 DSH 的工具可以「全局可见」或「只在选定的工作区可见」，
> 使不需要控制面的工作区不为 28 个工具的 schema 付上下文成本。
>
> 调研见 `docs/research/2026-11-12-tool-scope-survey.md`；v2 按两轮只读评审（自洽性 / 可实现性）
> 改正了 4 个 P0 与 6 个 P1，改动集中在 §2 存储、§3.1 取 cwd、§3.3 生效时机、§4 方法与错误形状。

## 1. 目标与非目标

**目标**

- 两种模式：`global`（默认，与今天完全一致）、`selected`（只有列出的工作区可见）。
- 设置页可切换、勾选、保存；生效**不需要插件重载**（理由见 §2）。
- 判定失败一律收紧（看不见），绝不因为读不出配置而放大可见性。

**非目标**

- 不做 MCP 客户端（外部连接）侧的过滤——外部客户端没有工作区概念（D5）。
- 不做按工具分组的勾选，只做「整个面开/关」。
- 不做按 agent preset、按会话、按时间的开关。

## 2. 存储：sidecar 文件，不是 `cordis.patch.yml`

```jsonc
// $DSH_HOME/mcp/tool-scope.json   (0600, 原子写)
{ "version": 1, "mode": "selected", "workspaceIds": ["ws_ab12"], "updatedAt": "2026-11-12T12:00:00Z" }
```

**为什么不在配置里**（这是对「所有设置都进 `cordis.patch.yml`」的一处**有意例外**）：

- `configEditor.edit()` 会 `await reconcile` 完成插件重载（`config-editor:124`）。重载换掉注册对象后，
  当前 step 已快照的 `toolSet` 因注册身份不相等而失效 ⇒ **正在跑的 turn 剩余调用变成 `UNKNOWN_TOOL`**。
- 已通过 `dsh_mcp_open` 打开的具名工具**属于 agent fiber，插件重载不会撤销**；新实例还会把它们
  当成 `alreadyOpen`，于是「保存后立即生效」对这批工具根本不成立。
- 这个特性的用法是**运行期开关**（一天可能切几次），不是部署配置（一次定终身）。

sidecar 的代价：多一份状态。它已经有先例——本插件本来就写 `$DSH_HOME/mcp/dsh-mcp-endpoint.json`。
配置项 `toolScopeFile` 可覆盖路径，缺省即上面那个。

保存路径：路由处理器**先更新进程内的权威对象，再原子写文件**；`when` 闭包读的是那个对象，
所以下一次 `resolve()` 就能看到新值，全流程**不重载插件、不打断进行中的 turn**。

## 3. 判定与执行期强制

### 3.1 取 cwd 与解析工作区

`agent` 上没有 `cwd`（`dsh-agent-loop/lib/index.js:511` 起的字段只有 `id`/`session`/`ctx`）。取法：

```js
cwd = agent.session?.header?.cwd            // 会话打开时记录的位置（权威）
   ?? ctx.get('workingDirectory')?.get(session)   // 仅在 header 缺失时兜底
```

**必须用记录值，不能用 `workingDirectory` 的当前值**：后者会跟随 `working_directory` 工具改目录，
于是任何会话 `cd` 进一个被选中的工作区根就能在下一步拿到全套控制面工具——这是一条自升权限路径。
身份是「会话在哪里打开」，不是「它现在站在哪里」。

解析顺序（**两者都是精确匹配**）：

1. **会话所属工作区**：`workspaceRegistry.list()` 里 `workspace.sessionIds` 含 `agent.session.id` 的那一个。
   这是 DSH 侧边栏用的同一份记录（`lib/workspace-grouping.js` 已经在维护它），**cwd 之后改成子目录也不影响**。
2. 兜底：`resolveByPath(cwd)`——它内部做 `realpath` 后**逐字比较**（`dsh-workspace:637-641`）。
3. 都解析不到 ⇒ **不可见**，并在 `dsh_status.scope.unmatchedAgents` 里计数（便于发现「配了但没人命中」）。

> **已知边界**：会话的 cwd 若落在某个工作区的**子目录**、且该会话没有登记进那个工作区，
> 就解析不到 ⇒ 不可见。这是「精确」这个选择（D3）的直接后果，写在这里以免被当成 bug。

### 3.2 判定

```js
visible(agent) = mode === 'global'
               ? true
               : workspaceIdOf(agent) !== undefined && workspaceIds.includes(workspaceIdOf(agent))
```

`workspaceIds` 精确相等，不做前缀、不做路径比较。

### 3.3 强制执行：三个点 + 一条铁律

| 位置 | 做法 |
|---|---|
| `full` 模式注册的 28 个定义 | `tools.register(def, { when })` |
| `lazy` 模式的 3 个前门工具 | 同上 |
| `dsh_mcp_open` 往 agent 作用域具名注册的工具 | 注册时**也传** `when`（`register(def, {when})` 支持，`bridge:427` 目前没传） |

**铁律一：`when` 永不抛。** `resolve()` 里 `when` 抛错会中止**整个 turn**
（`dsh-tools:554` → `dsh-agent-loop:813`），不是「这一批工具失败」。判据内部 `try/catch` → `false`。

**铁律二：`when` 只读共享的实时对象。** 不能捕获配置快照——已打开的工具归 agent fiber、
插件重载不撤销它们，闭包里若是旧快照就会一直按旧作用域判断。所以判据读的是 §2 里那个
进程内权威对象（模块级引用，路由保存时就地替换内容）。

**生效时机**：`when` 在**每个 step 准备时**求值并冻结进该步的 `toolSet`。所以：

- 切换作用域 ⇒ **下一步**生效，**当前这一步**不受影响（这正是我们要的：不打断进行中的 turn）。
- 已经被 `dsh_mcp_open` 打开的工具，下一步同样按新作用域决定去留，无需撤销注册。

**另一个必须修的地方**：`tools.get(name, agent)` **不评估 `when`**（`dsh-tools:519`），
而本插件现有的 `visibleTo()` 正是用它判断「这个工具是否已经对该 agent 可见」。
不修的话，`dsh_mcp_open` 会认为工具已经打开并跳过注册。改为 `scope.visible(agent) && tools.get(...)`。

### 3.4 缓存

- **只缓存正向命中**（解析到的 workspaceId）。未命中/解析失败**不缓存**：`workspaceRegistry`
  没有变更事件，负缓存会把「之后新建的工作区」永久判成隐藏。
- 键：`agent.session.id`（不是 cwd——cwd 会变、会无界增长）。
- 命中后仍要校验该 id 在当前 `list()` 里存在；不存在 ⇒ 丢弃缓存、判不可见，并记 `scope-stale`。

## 4. HTTP 契约

新增 `/mcp-scope`，与 `/mcp-config` 同一套 loopback + Origin 白名单 + JSON 校验。

**方法用 GET / POST，不用 PUT**：现有 `createConfigHandler` 只接受 `GET, HEAD, POST`
（`lib/config-route.js:244-247`），`PUT` 会直接 405。为了不复刻两套校验，新路由复用同一批helper
（`isLoopback` / `sendJson` / `readBody` / `isJsonContentType` 抽成共享模块）。

```
GET  /mcp-scope
200 {
  supported: true,
  mode: "global" | "selected",
  workspaceIds: ["ws_ab12"],
  notes: [],                       // scope-degraded / scope-unsupported / scope-stale
  workspaces: [{ id, title, path }]  // path 仅在请求通过 trust 校验时返回，否则省略
}

POST /mcp-scope
body: { mode: "global" | "selected", workspaceIds: ["ws_ab12"] }
200 → 与 GET 同形状（**保存后的真实状态**，因为不重载，进程内对象已经换了）
```

校验（**两种模式都校验，未知 id 一律不落盘**）：

- `mode` 必须是两个值之一 → `400 invalid-mode`。
- `workspaceIds` 必须是字符串数组 → `400 invalid-workspace-ids`。
- 每一项必须是当前 `workspaceRegistry.list()` 里存在的 id → `400 unknown-workspace`（回显未知项）。
  `mode: global` 时同样校验：否则会存下悬空 id，等切到 `selected` 时静默不可见。
- Host 无 `workspaceRegistry` → `501 scope-unsupported`。
- 写文件失败 → `500 scope-write-failed`（内存对象**不**替换，保持旧值）。

响应形状与现有路由一致：`{ error: "<message>", code?: "<code>" }`（现有 `/mcp-config` 只回 `error`，
这里多给一个稳定的 `code`，不改变既有路由的形状）。

**做最小并发保护（2026-11-12 实现后补记）**：原计划不做，实现时发现两条真实路径会互相覆盖——

- 插件重载：旧实例晚到的 `save` 会把新实例刚收紧的选择覆盖回旧值，**重启后静默放大可见性**；
- 两个进程/两个页面同时打开：后写者无条件覆盖前者。

因此加了两道，都是**写入时**才比较，不加版本号字段：

| 场景 | 行为 |
|---|---|
| 本实例已被 `dispose()`（插件被替换） | `409 scope-disposed` |
| 盘上 `updatedAt|writeId` 与本实例最后读到的不一致 | `409 scope-conflict`（服务端随即重读并闩住，页面必须先 GET） |
| 锁被别的写入者占住超过等待预算 | `409 scope-lock-timeout`（等待预算 8s > 最坏持有 ~6s） |

代价：多一次读盘（几百字节）、一个 `updatedAt` 与一个 `writeId` 字段（后者用来区分同一毫秒的两次写）；不改文档格式版本。

**冲突后必先读**：冲突时服务端会重读盘上文档（页面与 `dsh_status` 立刻显示赢家），并置一个
「冲突待确认」闩；这一次 GET 之后才允许再次保存，避免客户端盲目重试把刚采纳的值又写回去。

## 5. 页面

在现有 `/mcp-config` 页加一节「工具作用域」。现有页面是**改动即存**，而这一节要「先选后存」，
所以它单独持有草稿态：

```
┌ 工具作用域 ────────────────────────────────┐
│ 可见范围   [ 全局 ] [ 仅选定工作区 ]        │   SegmentedControl(disabled=busy)
│                                            │
│ 工作区                                     │
│   repo/hermes        [ ● ]                 │   Switch（mode=global 时 disabled）
│   workspace/twin     [ ○ ]                 │
│   （没有所属工作区的会话一律看不见）         │
│                                            │
│ ⚠ 配置读不出来，已收紧为「谁都不给」         │   仅 notes 非空时
│                        [ 保存 ] [ 重置 ]   │   草稿与已存值不同才可点
└────────────────────────────────────────────┘
```

- 工作区行显示 `title`，鼠标悬停给 `path`（整条路由都过 loopback + trust，`path` 直接随 GET 返回）。
- 保存成功后直接用 POST 的返回值刷新，不重读、不等待重载。
- `supported: false` 时整节只显示原因，不给可点控件。

## 6. `dsh_status` 暴露

```js
scope: {
  mode: 'global' | 'selected',
  workspaceIds: [...],
  notes: ['scope-stale'],
  unmatchedAgents: 0,     // 解析不到工作区的活跃会话数（排查「配了却没人命中」）
}
```

**不**承诺「每个 agent 当前可见与否」：那是每次 `resolve()` 才定下来的运行时快照，
写进状态接口只会和真实可见性各说各话。页面上的 `visible` 一词因此不用——那里只表达「这个工作区被选中了」。

## 7. 错误码

| 状态 | code | 场景 |
|---|---|---|
| 400 | `invalid-body` | 不是 JSON 对象 |
| 400 | `invalid-mode` | mode 不是两个值之一 |
| 400 | `invalid-workspace-ids` | `workspaceIds` 不是字符串数组 |
| 400 | `unknown-workspace` | 有注册表里不存在的 id（回显） |
| 405 | — | 非 GET/POST |
| 413 | — | 请求体超限（复用现有上限） |
| 415 | — | `content-type` 不是 JSON |
| 409 | `scope-disposed` | 本实例已被替换（插件重载），拒绝写入 |
| 409 | `scope-conflict` | 盘上文档已被别处改动；服务端随即重读并**闩住**，必须先 GET 再存 |
| 409 | `scope-lock-timeout` | 另一个写入者持有锁超过等待预算（正常并发不会触发） |
| 500 | `scope-write-failed` | 写文件失败，内存保持旧值 |
| 500 | `scope-registry-unavailable` | 注册表抛错（不是「没有工作区」） |
| 500 | `scope-write-unverified` | 写前读盘失败（无法确认没有并发写），不盲写 |
| 501 | `scope-unsupported` | Host 无 `workspaceRegistry` |
| 403 | — | 非 loopback / Origin 不在白名单（沿用现有） |

## 8. 测试计划

| 层面 | 用例 |
|---|---|
| 判定 | global 恒可见；selected 命中；未命中；cwd 解析不到；`mode` 非法 → 收紧；`workspaceIds` 非数组 → 收紧；含非字符串 → 丢弃后收紧 |
| 解析 | 会话在 `workspace.sessionIds` 里（即使 cwd 是子目录）⇒ 命中；只有 `resolveByPath` 命中 ⇒ 命中；都不命中 ⇒ 不可见 |
| 强制 | `when` 返回 true/false；**`when` 内部抛错时 turn 不被打断、工具判为不可见**；`openFor` 对不可见工作区拒绝；切换作用域后**下一步**生效、当前步不受影响 |
| 存活 | 保存作用域后插件实例不变（不重载）；已 open 的工具在下一步按新作用域去留 |
| 缓存 | 只缓存正向；工作区新建后立即可命中；工作区删除后缓存失效并记 `scope-stale` |
| HTTP | GET 形状；POST 保存并回真实状态；`invalid-mode`；`invalid-workspace-ids`；`unknown-workspace`（含 global 模式）；无 registry 501；写失败 500 且内存不变；非 loopback 403；GET 不带 trust 时不回 path |
| 页面 | 渲染冒烟（有/无 registry）；草稿态（改动前保存按钮不可点）；global 时工作区开关 disabled |
| 回归 | `global` 下 28 个工具全部可见（向后兼容） |

## 9. 决策记录

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 缺省 `global` | 升级不改变既有行为 |
| D2 | 用工作区 **id**，不用路径 | 有设置页可以列出来勾选；id 是注册表的稳定主键 |
| D3 | **精确相等**，不做前缀 | 工作区 id 已是根；前缀会让 `repo-old` 与 `repo` 互相污染 |
| D4 | 做设置页 | 用户明确要求 |
| D5 | 不做 MCP 客户端侧过滤 | 外部客户端没有工作区概念 |
| D6 | 存 **sidecar 文件**，不进 `cordis.patch.yml` | 配置写入会重载插件、打断进行中的 turn，且救不回已 open 的工具；这是运行期开关 |
| D7 | 用 **POST**，不用 PUT | 现有路由只接 GET/HEAD/POST；不复刻两套校验 |
| D8 | 判定优先用「会话所属工作区」，cwd 解析兜底 | cwd 会变；`sessionIds` 是侧边栏同源的记录 |

## 10. 待确认

- **D6 存储位置**：接受 sidecar 吗？（另一条路是坚持写 `cordis.patch.yml`，代价是每次保存都会
  重载插件、打断进行中的 turn。）
- **子目录策略**：确认「cwd 在子目录、且会话没登记进工作区 ⇒ 不可见」可接受？
