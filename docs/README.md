# Documentation / 文档

Entry points: [English](../README.en.md) · [简体中文](../README.md)

The README states what the plugin can do; each file below goes one level deeper into one subject.
Both languages mirror the same eight documents: `docs/en/` and `docs/zh/`.
README 只说明能做什么，具体细节按主题拆到下面的文件；两种语言各八篇，结构一一对应。

## English

| Document | What is inside |
|---|---|
| [Getting started](en/getting-started.md) | Install, the endpoint file and token, HTTP/stdio/DSH-as-client configs, the self-check bundle. |
| [Tools and resources](en/tools.md) | All 21 tools, the three resources, progressive reads, pending user decisions. |
| [Sessions and delivery](en/sessions.md) | Caller identity and ownership, waiting, sidebar grouping, queue/steer, opening the GUI. |
| [DSH-local tools](en/dsh-local.md) | The in-Harness surface, the lazy front door, and the authority ceiling. |
| [Must-reply questions](en/questions.md) | Asking, answering, id-only reminders, human stops, deadlines, deadlocks. |
| [Progress sync](en/work-sync.md) | Task-start sync between same-workspace peers, its own bundle row and knobs. |
| [Configuration](en/configuration.md) | Every Plugins-page switch and every `cordis.patch.yml` field. |
| [Internals](en/internals.md) | Module map, DSH compatibility, model experience, verification, limitations. |

## 简体中文

| 文档 | 内容 |
|---|---|
| [快速开始](zh/getting-started.md) | 安装、端点文件与令牌、HTTP/stdio/DSH 作为客户端的配置、自检 bundle。 |
| [工具与资源](zh/tools.md) | 全部 21 个工具、3 个资源、渐进式读取、待决的用户决策。 |
| [会话与投递](zh/sessions.md) | 调用方身份与归属、等待、侧边栏分组、排队/插话、在 GUI 中打开会话。 |
| [DSH 本地工具](zh/dsh-local.md) | Harness 内部工具面、lazy 前门、权限上限。 |
| [必须回复的问题](zh/questions.md) | 提问、回答、只带编号的提醒、人为停止、超时、死锁。 |
| [进度同步](zh/work-sync.md) | 同一工作区同伴之间的任务开始同步、独立 bundle 行及其参数。 |
| [配置](zh/configuration.md) | 插件页上的每个开关和 `cordis.patch.yml` 的每个字段。 |
| [内部实现](zh/internals.md) | 模块图、DSH 兼容性、模型体验、验证方式、已知限制。 |

## Adding a page

1. Put the English page in `docs/en/<topic>.md` and its Chinese mirror in `docs/zh/<topic>.md`.
2. Start both files with the one-line breadcrumb used by the other pages
   (`> Part of [DSH MCP Server](../README.en.md) · [Docs index](../README.md)` /
   `> 属于 [DSH MCP Server](../README.md) · [文档索引](../README.md)`).
3. Link the page from both READMEs' documentation table and from the tables above.
4. Run `npm run check:docs` (CI runs it too): it verifies every relative link and anchor, and that `docs/zh/` keeps the same headings, tables, fences and inline identifiers as `docs/en/`.
