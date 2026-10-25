# Getting started

> Part of [DSH MCP Server](../../README.en.md) · [Docs index](../README.md)

Install the bundle, read the connection details, and point a client at the endpoint.

## Install into a profile

```bash
git clone https://github.com/baitouwuya/dsh-mcp-server.git
# then, from the Harness UI / plugin_manager:
plugin_manager install_bundle --target /path/to/dsh-mcp-server
```

or, equivalently, `action: install_bundle` with the absolute package directory as `target`.

The bundle's patch inserts **two rows**: `dsh-mcp-server` (the endpoint) and `dsh-work-sync` (task-start
progress sync, see [progress sync](work-sync.md)). They are separate rows on purpose — sync can be disabled, reloaded or replaced without
touching the endpoint, and a profile that omits it still serves MCP, reporting `sync.present: false`.

### Self-check bundle (optional)

`selfcheck/` is a second, tiny bundle (`@local/dsh-mcp-selfcheck`) that registers DSH's **own** MCP
client against this server, so the published endpoint is continuously exercised and its tools appear
inside DSH as `mcp__dsh__*`. It is pure verification — disable or skip it if you do not want a
self-loop in every session:

```bash
plugin_manager install_bundle --target /path/to/dsh-mcp-server/selfcheck
```

The committed `cordis.patch.yml` carries **no literal token** (this is a public repository): set
`DSH_MCP_TOKEN` in the Harness environment, or patch the `mcp-dsh-selfcheck` row from your own
private profile, with the token the server is configured with.

## Endpoint and authentication

On activation the plugin registers `POST /mcp` on the Harness web server (default
`http://127.0.0.1:19387`) and writes connection details to:

```
$DSH_HOME/mcp/dsh-mcp-endpoint.json      # mode 0600
{ "url": "...", "token": "...", "stdioBridge": "...", "tools": [...] }
```

Every request must present the bearer token, in the `Authorization` header (no query-string form: a token
in a URL lands in access logs). The comparison is made over SHA-256 digests, so it is constant-time even
for a token of the wrong length.

```
Authorization: Bearer <token>
```

The token is **generated per activation** unless you configure a fixed one. Set a fixed token
whenever another harness keeps a saved config, because a generated token changes on every Harness
restart. In the desktop profile the `dsh-mcp-server` row carries one:

```yaml
- id: dsh-mcp-server
  disabled: false
  config:
    token: "<fixed token>"     # mirrored in the endpoint file and in the selfcheck bundle
```

Requests that already pass DSH's own connection trust (`ctx.connection`) are also accepted, so local
tooling that holds the Harness token works too.

The endpoint file is owned by the activation that wrote it: on a config hot-reload the outgoing
instance removes it only when it is still the owner, so the replacement instance's file is never
deleted mid-reload.

## Connecting another harness

### 1. Streamable HTTP (no extra process)

Point the client at the endpoint with the bearer token:

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

### 2. stdio (harnesses that only spawn a command)

`bin/dsh-mcp-stdio.mjs` is a dependency-free stdio↔HTTP bridge. It discovers the endpoint from
`$DSH_HOME/mcp/dsh-mcp-endpoint.json` (override with `--url`/`--token` or `DSH_MCP_URL`/`DSH_MCP_TOKEN`):

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

It forwards JSON-RPC messages verbatim, cancels the upstream request when the client sends
`notifications/cancelled`, and keeps stdout clean (diagnostics go to stderr). It also names its
launcher to the endpoint through `x-dsh-mcp-client`, from `--client <label>`, else
`DSH_MCP_CLIENT`, else the parent process name, else `stdio-bridge` — set the variable in the other
harness' MCP server config when the parent is a bare runtime such as `node`.

Because GUI clients launch with a minimal `PATH`, point `command` at an absolute Node binary and rely
on the bridge's `~/.dsh` discovery (both verified with only `HOME` and `PATH` set):

| Client | Config file | Entry |
|---|---|---|
| Claude Code (user scope) | `~/.claude.json` | `mcpServers.dsh` |
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

Restart the client after editing its config. A cloud MCP client (for example a web connector) cannot
reach a loopback endpoint at all — that needs a tunnel and a deliberate networking change.

### 3. DSH as its own MCP client

DSH ships `@deepseek-ai/dsh-mcp-client`; a row like this registers this server's tools inside DSH as
`mcp__dsh__dsh_run_prompt`, …:

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
