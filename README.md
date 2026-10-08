# DSH MCP Server

A DeepSeek Harness (DSH) plugin that publishes a **Model Context Protocol (MCP)** server from the
running Harness host, so other agent harnesses — Claude Code, Cursor, Codex, another DSH, any MCP
client — can call DSH: start sessions, drive turns, read transcripts, and cancel work.

The plugin is a Host-only bundle with **zero dependencies** (no DSH import, no third-party module),
so it installs into a profile and survives Harness upgrades that keep the service contracts.

```
other harness ──MCP (Streamable HTTP or stdio)──> DSH MCP Server ──> DSH services
                                                                     sessionController / sessionQuery / tools
```

## What it exposes

| MCP tool | Purpose |
|---|---|
| `dsh_run_prompt` | Start a **new** DSH session and run one prompt; returns the assistant's final text and the new `sessionId`. Supports `cwd`, `agentPreset`, `model` (`provider/model`), `wait: false`, `timeoutMs`. |
| `dsh_continue_session` | Send a prompt to an **existing** session (resuming it if it is cold). Keeps the session's context and workspace. |
| `dsh_list_sessions` | Visible sessions with title, cwd, running state, and last activity. |
| `dsh_read_session` | Ordered `{ role, text, seq }` transcript of one session (user-authored and assistant messages only). |
| `dsh_cancel_session` | Cancel the active turn of a session without dropping its pending inbox. |
| `dsh_list_tools` | The tools DSH exposes to its own agents, for choosing what a delegated prompt can do. |
| `dsh_status` | Endpoint, profile, version, session/live-agent counts, default model, active turns. |

Resources: `dsh://status`, `dsh://sessions`, and the template `dsh://session/{sessionId}`.

## Endpoint and authentication

On activation the plugin registers `POST /mcp` on the Harness web server (default
`http://127.0.0.1:19387`) and writes connection details to:

```
$DSH_HOME/mcp/dsh-mcp-endpoint.json      # mode 0600
{ "url": "...", "token": "...", "stdioBridge": "...", "tools": [...] }
```

Every request must present the bearer token:

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

## Configuration

The bundle row in `cordis.patch.yml` accepts (all optional):

| Field | Default | Meaning |
|---|---|---|
| `path` | `/mcp` | Route path on the Harness web server. |
| `token` | generated | Fixed bearer token; set this so external configs stay stable across restarts. |
| `url` | `$DSH_WEB_URL` or `http://127.0.0.1:19387` | Advertised base URL written to the endpoint file. |
| `endpointFile` | `$DSH_HOME/mcp/dsh-mcp-endpoint.json` | Where connection details are published. |
| `writeEndpointFile` | `true` | Publish the endpoint file at all. |
| `allowConnectionAuth` | `true` | Also accept requests admitted by `ctx.connection`. |
| `defaultCwd` | Harness default | Working directory for sessions started without `cwd`. |
| `defaultModel` | Harness default model | `{ provider, model, reasoningEffort? }` for sessions without an explicit override. |
| `turnTimeoutMs` | `1800000` | Default wait ceiling for a tool call that waits for a turn. |
| `maxConcurrentTurns` | `8` | Concurrent waited turns before new calls queue. |
| `maxBodyBytes` | `8388608` | Request body ceiling. |
| `instructions` | built-in text | Replaces the instructions handed to the calling model. |

Example row:

```yaml
- insert:
    - id: dsh-mcp-server
      name: '@local/dsh-mcp-server'
      config:
        token: !!js process.env.DSH_MCP_TOKEN
        defaultCwd: /Users/me/work
```

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
      "args": ["/Users/baitouwuya/dsh-mcp-server/bin/dsh-mcp-stdio.mjs"]
    }
  }
}
```

It forwards JSON-RPC messages verbatim, cancels the upstream request when the client sends
`notifications/cancelled`, and keeps stdout clean (diagnostics go to stderr).

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

## Install into a profile

```bash
# from the Harness UI / plugin_manager
plugin_manager install_bundle --target /Users/baitouwuya/dsh-mcp-server
```

or, equivalently, `action: install_bundle` with the absolute package directory as `target`.

### Self-check bundle (optional)

`selfcheck/` is a second, tiny bundle (`@local/dsh-mcp-selfcheck`) that registers DSH's **own** MCP
client against this server, so the published endpoint is continuously exercised and its tools appear
inside DSH as `mcp__dsh__*`. It is pure verification — disable or skip it if you do not want a
self-loop in every session:

```bash
plugin_manager install_bundle --target /Users/baitouwuya/dsh-mcp-server/selfcheck
```

Its `cordis.patch.yml` bearer token must match the server's configured token.

## Verification

```bash
node test/mcp-self-test.mjs            # 11 transport checks, no Harness needed
node test/plugin-integration-test.mjs  # 10 checks: apply(), endpoint file, tools, transcript filter,
                                       # hot-reload endpoint ownership
node test/stdio-bridge-test.mjs        # 4 checks, needs a RUNNING Harness (one real delegated turn)
node test/live-e2e-test.mjs            # 22 checks over HTTP: protocol, resources, all seven tools,
                                       # error paths, 3 real turns (needs a RUNNING Harness)
```

Live checks used during development also covered: a real MCP client exchange against the running
Harness, an end-to-end `dsh_run_prompt` → `dsh_continue_session` → `dsh_read_session` flow, detached
start + cancel, and the stdio bridge.

## Notes and limitations

- **Code changes need a Harness restart.** Re-enabling a bundle reloads its row but reuses the
  already-imported module generation, so edited plugin code only takes effect after restarting DSH.
  Config changes reach the running instance immediately; changing a bundle's package path may report
  `restart-required`.
- **The bearer token is a local secret.** The desktop profile keeps it in
  `$DSH_HOME/profiles/desktop/cordis.patch.yml`, and `selfcheck/cordis.patch.yml` repeats it. Rotate by
  updating both places. It authorizes full DSH session control over loopback, so treat it accordingly.
- **Localhost only.** The endpoint rides the Harness web server, which binds loopback. Exposing it to
  another machine is a deliberate networking change, not a plugin setting.
- **Approval and user questions.** A turn started over MCP runs with the session's own approval and
  sandbox policy; if a delegated turn needs approval, the prompt appears in the Harness GUI like any
  other session.
- Sessions started over MCP are ordinary DSH sessions: they appear in the Harness session list and can
  be opened and continued in the GUI.