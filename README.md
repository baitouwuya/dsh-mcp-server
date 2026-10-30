# DSH MCP Server（dsh-mcp-btwy）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/baitouwuya/dsh-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/baitouwuya/dsh-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-mcp-btwy.svg)](https://www.npmjs.com/package/dsh-mcp-btwy)

**简体中文** · [English](README.en.md)

一个 DeepSeek Harness（DSH）插件：从正在运行的 Harness 宿主发布一个 **Model Context Protocol（MCP）**
服务，让别的 agent harness——Claude Code、Cursor、Codex、另一个 DSH、任何 MCP 客户端——可以直接调用
DSH：创建会话、推进回合、等待结果、读取对话记录、取消工作。

插件是仅宿主侧的 bundle，**零依赖**。每个请求都归因到发起调用的 agent，每个会话都记录在它的创建者名下，
所以多个 harness 可以共用一个端点，仍然能问"哪些会话是我的？"。同一套工具也会注册进本机 Harness，
在那里按调用会话自身的权限收紧。

```
其他 harness ──MCP（Streamable HTTP 或 stdio）──> DSH MCP Server ──> DSH 服务
                                                                     sessionController / sessionQuery / tools
```

## 它能做什么

- **用任意 MCP 客户端驱动 DSH。** `dsh_run_prompt` 创建会话并返回 `sessionId`；
  `dsh_continue_session` 延续它的上下文与工作区；`dsh_wait_session` 只等待、不取消；
  `dsh_cancel_session` 停止回合但保留收件箱。Streamable HTTP 与 stdio 桥都可用。
- **读得准，而不是整份倒出来。** `dsh_list_sessions` 分页列出会话索引，`dsh_search_sessions`
  只返回有限的片段，`dsh_read_session` 以 tail/head/outline 窗口读取，带游标、单条上限和整包预算；
  每个结果都会说明它没有返回什么。
- **多个 harness 共用一个端点。** 调用方身份按请求头、`clientInfo` 或 User-Agent 解析；会话记录在
  所有者名下；`restrictToOwner` 把每个调用方限制在它自己创建的会话里。
- **看见模型看不见的决策。** `dsh_list_requests` 报告审批请求和未回答的用户提问（含工具、原因、
  call id）；开启 `answerApprovals` / `answerQuestions`（旧的 `answerUserRequests` 仍作总开关）后，
  `dsh_answer_request` 可以和 GUI 竞速地给出决定。
- **问一个目标必须回答的问题。** `dsh_ask_session` 让提问回合一直阻塞到被问会话回答；问题带编号，
  提醒只搭在目标自己的调用上（绝不唤醒会话），人为停止会直接结案且不打扰任何人。
- **避免同工作区的 agent 撞车。** 任务开始时进度同步会询问同一工作区里的其他顶层 agent 正在做什么、
  在改哪些文件；它作为独立的 `dsh-work-sync` 行挂载。
- **在 DSH 内部调用同一套工具。** 默认的 lazy 工具面是一个三工具前门（`dsh_mcp_tools`、
  `dsh_mcp_open`、`dsh_mcp_call`），常驻约 770 token 而不是 4.8k；`full` 则注册全部 21 个。
  内部调用始终被限制在调用者自己的沙箱与工作区内。
- **把人带到现场。** 端点创建的会话会归入其目录已有的侧边栏项目；`dsh_open_session` 让打开的
  Web GUI 直接选中某个会话。
- **在插件页配置，或用预设一次设好。** 开关、lazy/full 工具面、侧边栏分组、忙碌时投递方式、进度同步，
  都是插件包自己页面上的控件，经配置文件编辑器保存；部署级还可以在行里写
  `preset: delegate | strict | observer`，只填充没显式设置过的字段。

## 快速开始

1. **安装到 DSH 配置档案**（npm 包 `dsh-mcp-btwy`，零依赖）：

   ```bash
   # 在 Plugins 页面点 Add plugin，把包名粘进输入框：
   dsh-mcp-btwy
   # 或者命令行（profile 名以你的安装为准，桌面版是 desktop）：
   dsh plugin --profile desktop add dsh-mcp-btwy
   ```

   从源码安装（开发或离线）同样可行：`git clone` 后在 Add plugin 里粘仓库路径，或
   `plugin_manager install_bundle --target /path/to/dsh-mcp-server`。

2. **读取插件发布的连接信息**（文件权限 0600）：

   ```
   $DSH_HOME/mcp/dsh-mcp-endpoint.json    # { url, token, stdioBridge, tools }
   ```

3. **让客户端连上端点**（下图为 Streamable HTTP；stdio、其他客户端见
   [快速开始文档](docs/zh/getting-started.md)）：

   ```jsonc
   {
     "mcpServers": {
       "dsh": {
         "type": "http",
         "url": "http://127.0.0.1:19387/mcp",
         "headers": { "Authorization": "Bearer <dsh-mcp-endpoint.json 里的 token>" }
       }
     }
   }
   ```

4. **调用它。** 先创建会话，再继续：

   ```jsonc
   dsh_run_prompt({ "prompt": "summarize README.md", "cwd": "/path/to/repo" })
   // → { "sessionId": "session-…", "text": "…" }

   dsh_continue_session({ "sessionId": "session-…", "prompt": "now list the TODOs" })
   ```

## 安全边界

这个插件的用途是让**另一个 harness 操作本机这台 DSH**，所以边界是设计的一部分，不是可选项：

- 端点默认只绑回环地址（`127.0.0.1`）；要对外暴露得显式改 `host`，而这通常不该做。
- 每个请求都要 Bearer token；token 写在 `$DSH_HOME/mcp/dsh-mcp-endpoint.json`（权限 0600），
  不接受 URL 查询串（那会进代理日志）。
- `restrictToOwner` 把每个调用方限制在它自己创建的会话里；跨会话来宾调用被拒绝。
- 代答审批（`answerApprovals`）等于把沙箱提权的同意权交出去；不确定时保持关闭。

安装前请确认你信任会调用这个端点的 harness——它在你的用户权限下运行。

## 文档

| 文档 | 内容 |
|---|---|
| [快速开始](docs/zh/getting-started.md) | 安装、端点文件与令牌、HTTP/stdio/DSH 作为客户端的配置、自检 bundle。 |
| [工具与资源](docs/zh/tools.md) | 全部 21 个工具、3 个资源、渐进式读取、待决的用户决策。 |
| [协议支持](docs/zh/protocol.md) | 支持的 MCP 版本、方法、能力声明、通知、错误码、鉴权、会话头，以及明确不支持的项。 |
| [会话与投递](docs/zh/sessions.md) | 调用方身份与归属、等待、侧边栏分组、排队/插话、在 GUI 中打开会话。 |
| [DSH 本地工具](docs/zh/dsh-local.md) | Harness 内部工具面、lazy 前门、权限上限。 |
| [必须回复的问题](docs/zh/questions.md) | `dsh_ask_session` / `dsh_answer_question` / `dsh_get_question`、提醒、人为停止、死锁。 |
| [进度同步](docs/zh/work-sync.md) | 任务开始时的同伴同步、独立 bundle 行及其参数。 |
| [配置](docs/zh/configuration.md) | 插件页上的每个开关和 `cordis.patch.yml` 的每个字段。 |
| [内部实现](docs/zh/internals.md) | 模块图、DSH 兼容性、模型体验、验证方式、已知限制。 |

两种语言的完整索引见 [文档目录](docs/README.md)。

## 状态

版本 **1.0.1**，已针对 **DSH 0.2.1-rc.5**（Cordis 4.0.5）验证：21 个 MCP 工具、2 个资源、
1 个资源模板、250 项离线检查，外加在线 HTTP 与 stdio 套件。仅宿主侧、零依赖、MIT。
DSH 0.2.1-rc.5 起自带 MCP 客户端，所以除了本插件的内建前门，也能让 Harness 直接连接本端点——见
[用 DSH 自己的 MCP 客户端连进来](docs/zh/dsh-local.md#用-dsh-自己的-mcp-客户端连进来)。
从 1.0.0 起，工具名、资源 URI、配置字段与 MCP 协议面按语义化版本对待：破坏其中任何一项都需要大版本。
插件不 import 任何 DSH 包，所以兼容性取决于服务契约而不是版本锁定——见
[内部实现](docs/zh/internals.md#dsh-兼容性)。逐版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
