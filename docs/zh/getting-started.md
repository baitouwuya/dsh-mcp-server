# 快速开始

> 属于 [DSH MCP Server](../../README.md) · [文档索引](../README.md)

安装插件包，查看连接信息，然后把客户端指向端点。

## 安装到配置档案

已发布到 npm，包名 `dsh-mcp-btwy`，零运行时依赖：

```bash
# 在 Plugins 页面点 Add plugin 并粘贴包名：
dsh-mcp-btwy
# 或命令行（profile 名以你的安装为准，桌面版是 desktop）：
dsh plugin --profile desktop add dsh-mcp-btwy
```

要钉版本就写 `dsh-mcp-btwy@0.23.0`；要升级就再执行一次并重启 DSH。

**从源码安装**（开发或离线）同样可行：

```bash
git clone https://github.com/baitouwuya/dsh-mcp-server.git
# then, from the Harness UI / plugin_manager:
plugin_manager install_bundle --target /path/to/dsh-mcp-server
```

或者等价地，使用 `action: install_bundle`，并把插件包的绝对目录作为 `target`。源码安装时包名仍然是
`dsh-mcp-btwy`——npm 名和仓库目录无关，patch 里的行名跟着包名走。

插件包的 patch 会插入**两行**：`dsh-mcp-server`（端点）和 `dsh-work-sync`（任务启动进度同步，见[进度同步](work-sync.md)）。它们被刻意做成两个独立的行——同步可以禁用、重载或替换，而不影响端点；省略它的配置档案仍然提供 MCP 服务，并报告 `sync.present: false`。

### 自检插件包（可选）

`selfcheck/` 是第二个很小的插件包（`@local/dsh-mcp-selfcheck`），它把 DSH **自身**的 MCP 客户端注册到这个服务器上，使已发布的端点持续得到实际调用，其工具会以 `mcp__dsh__*` 的形式出现在 DSH 内部。它纯粹用于验证——如果你不希望每个会话里都有一个自环，可以禁用它或跳过安装：

```bash
plugin_manager install_bundle --target /path/to/dsh-mcp-server/selfcheck
```

仓库中提交的 `cordis.patch.yml` **不含任何明文令牌**（这是一个公开仓库）：请在 Harness 环境中设置 `DSH_MCP_TOKEN`，或者在你自己私有的配置档案中，用服务器所配置的令牌修改 `mcp-dsh-selfcheck` 行。

## 端点与认证

激活时，插件会在 Harness Web 服务器上注册 `POST /mcp`（默认 `http://127.0.0.1:19387`），并把连接信息写入：

```
$DSH_HOME/mcp/dsh-mcp-endpoint.json      # mode 0600
{ "url": "...", "token": "...", "stdioBridge": "...", "tools": [...] }
```

每个请求都必须在 `Authorization` 头中携带持有者令牌（没有查询字符串形式：URL 中的令牌会进入访问日志）。比较基于 SHA-256 摘要进行，因此即使令牌长度不对，也是常数时间比较。

```
Authorization: Bearer <token>
```

除非你配置固定令牌，否则令牌**每次激活都会重新生成**。只要另一个 harness 保存了配置，就应设置固定令牌，因为生成的令牌会在每次 Harness 重启时变化。在桌面配置档案中，`dsh-mcp-server` 行就携带了一个固定令牌：

```yaml
- id: dsh-mcp-server
  disabled: false
  config:
    token: "<fixed token>"     # mirrored in the endpoint file and in the selfcheck bundle
```

已经通过 DSH 自身连接信任（`ctx.connection`）的请求也会被接受，因此持有 Harness 令牌的本地工具同样可用。

端点文件归写入它的那次激活所有：配置热重载时，即将退出的实例只有在仍然是所有者时才会删除它，因此替换实例的文件不会在重载中途被删除。

## 连接另一个 harness

### 1. Streamable HTTP（无需额外进程）

把客户端指向端点，并带上持有者令牌：

```jsonc
// Claude Code / Cursor style MCP config
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:19387/mcp",
      "headers": { "Authorization": "Bearer <token from dsh-mcp-endpoint.json>" }
    }
  }
}
```

### 2. stdio（只能启动命令的 harness）

`bin/dsh-mcp-stdio.mjs` 是一个无依赖的 stdio↔HTTP 桥接器。它从 `$DSH_HOME/mcp/dsh-mcp-endpoint.json` 发现端点（可用 `--url`/`--token` 或 `DSH_MCP_URL`/`DSH_MCP_TOKEN` 覆盖）：

```jsonc
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["<path-to-dsh-mcp-server>/bin/dsh-mcp-stdio.mjs"]
    }
  }
}
```

它原样转发 JSON-RPC 消息，在客户端发送 `notifications/cancelled` 时取消上游请求，并保持 stdout 干净（诊断信息写入 stderr）。它还通过 `x-dsh-mcp-client` 向端点标识自己的启动者，取值依次为 `--client <label>`、`DSH_MCP_CLIENT`、父进程名，最后回退到 `stdio-bridge`——当父进程是 `node` 这样的裸运行时，请在其他 harness 的 MCP 服务器配置中设置该变量。

由于 GUI 客户端启动时 `PATH` 很精简，请把 `command` 指向 Node 的绝对路径，并依赖桥接器的 `~/.dsh` 发现逻辑（两者都只在仅设置 `HOME` 和 `PATH` 的情况下验证过）：

| 客户端 | 配置文件 | 入口 |
|---|---|---|
| Claude Code（用户级） | `~/.claude.json` | `mcpServers.dsh` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.dsh` |
| ChatGPT desktop / Codex | `~/.codex/config.toml` | `[mcp_servers.dsh]` |

```toml
# Codex / ChatGPT desktop
[mcp_servers.dsh]
type = "stdio"
command = "/absolute/path/to/node"
args = ["<path-to-dsh-mcp-server>/bin/dsh-mcp-stdio.mjs"]
startup_timeout_sec = 60
```

修改配置后请重启客户端。云端 MCP 客户端（例如网页连接器）完全无法访问回环端点——那需要隧道以及对网络的有意改动。

### 3. 让 DSH 作为自己的 MCP 客户端

DSH 自带 `@deepseek-ai/dsh-mcp-client`；像下面这样的一行会把本服务器的工具注册到 DSH 内部，名称形如 `mcp__dsh__dsh_run_prompt` 等：

```yaml
- insert:
    - id: mcp-dsh
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dsh
        transport: streamable-http
        url: http://127.0.0.1:19387/mcp
        headers:
          Authorization: !!js '`Bearer ${process.env.DSH_MCP_TOKEN}`'
```
