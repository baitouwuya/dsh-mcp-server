# DSH MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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
| `dsh_run_prompt` | Start a **new** DSH session and run one prompt; returns the assistant's final text and the new `sessionId`. Supports `cwd`, `agentPreset`, `permissionPreset`, `model` (`provider/model`), `wait: false`, `timeoutMs`. |
| `dsh_continue_session` | Send a prompt to an **existing** session (resuming it if it is cold). Keeps the session's context and workspace; `permissionPreset` re-pins the session's sandbox mode and approval policy before the prompt, and `model` (`provider/model`) overrides the session's model. Without `model` the session keeps the model it already runs. |
| `dsh_list_commands` | The slash commands a session's agent can currently run: the global command layer plus whatever that agent's preset composes, so availability differs per agent preset. |
| `dsh_run_command` | Run one slash command in a session and return its settled `{ kind, text, commandId }`. `line` takes a complete command line (`"/compact"`, `"/permission danger-full-access"`); `command` (+ optional `args`) takes a bare name. The command executes immediately without a model turn. |
| `dsh_list_sessions` | Visible sessions with title, cwd, running state, archival state, and last activity. Archived sessions are hidden unless `includeArchived: true`, mirroring the Web UI. |
| `dsh_read_session` | Ordered `{ role, text, seq }` transcript of one session (user-authored and assistant messages only), plus the last durable `permissionPreset` when the session has one. Works while the session is archived. |
| `dsh_cancel_session` | Cancel the active turn of a session without dropping its pending inbox. |
| `dsh_archive_session` | Archive one session durably: hidden from every grouping surface, and it cannot run a model step until restored. A session with running work is refused unless `stopActivity: true` (which archives first, then stops that work). Archiving drops the pin. |
| `dsh_unarchive_session` | Drop a session from the archive set; it is listed again and returns to its recorded workspace position. |
| `dsh_list_permission_presets` | The deployment's permission presets (each bundles a sandbox mode with an approval policy) plus the default for new sessions, for the `permissionPreset` argument above. |
| `dsh_list_tools` | The tools DSH exposes to its own agents, for choosing what a delegated prompt can do. |
| `dsh_status` | Endpoint, profile, version, session/live-agent counts, default model, active turns, and the default permission preset. |

Archival needs the Host's `workspaceRegistry` service (`@deepseek-ai/dsh-workspace`). Without it the
two archive tools report that the service is unavailable and listings simply omit the `archived`
field instead of guessing.

Permission presets need the Host's `permissionPresets` service
(`@deepseek-ai/dsh-permission-presets`). `permissionPreset` is applied through that service's own
`set()` — the same write path as the GUI `/permission` command — once the session is live and before
its prompt is admitted, so the turn's own tool calls already see the chosen sandbox mode and approval
policy. The outcome echoes the applied preset; `dsh_read_session` folds the session's last durable
`permission/preset` event back into its payload, and `dsh_status` carries `defaultPermissionPreset`
plus the catalog. Without the service the permission fields are omitted and
`dsh_list_permission_presets` reports that the service is unavailable. A session created without a
`permissionPreset` keeps the deployment default, exactly as a GUI-created session does.

Commands need the Host's `commands` service and are addressed by **agent**, not by session: the
registry merges a global layer with the layers of the preset that agent is mounted under, so
`dsh_list_commands` must be asked per session and a command such as `/compact` exists only when that
session's preset composes it (`standard`/`ptc`/`cordis` do; `minimal` does not). Execution goes
through the same `commands.execute()` the Web composer uses: the handler runs immediately, the
lifecycle is logged as `command/run` + `command/done`, and **no model turn is started**. `kind` is
`success` or `error`; a line the Host would not parse as a command, or a name it does not know, is
rejected with the available commands listed.

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
| `defaultModel` | Harness default model | `{ provider, model, reasoningEffort? }` for **newly started** sessions without an explicit `model`. A continued session keeps the model it already runs. |
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
      "args": ["<path-to-dsh-mcp-server>/bin/dsh-mcp-stdio.mjs"]
    }
  }
}
```

It forwards JSON-RPC messages verbatim, cancels the upstream request when the client sends
`notifications/cancelled`, and keeps stdout clean (diagnostics go to stderr).

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

## Install into a profile

```bash
git clone https://github.com/baitouwuya/dsh-mcp-server.git
# then, from the Harness UI / plugin_manager:
plugin_manager install_bundle --target /path/to/dsh-mcp-server
```

or, equivalently, `action: install_bundle` with the absolute package directory as `target`.

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

## Verification

```bash
node test/mcp-self-test.mjs            # 11 transport checks, no Harness needed
node test/plugin-integration-test.mjs  # 28 checks: apply(), endpoint file, tools, transcript filter,
                                       # archival tools, permission presets, commands, hot-reload ownership
node test/stdio-bridge-test.mjs        # 4 checks, needs a RUNNING Harness (one real delegated turn)
node test/live-e2e-test.mjs            # 34 checks over HTTP: protocol, resources, all twelve tools,
                                       # archive/unarchive, permission presets, commands, error paths,
                                       # 4 real turns (needs a Harness)
```

Live checks used during development also covered: a real MCP client exchange against the running
Harness, an end-to-end `dsh_run_prompt` → `dsh_continue_session` → `dsh_read_session` flow, permission
presets applied and re-pinned over MCP and folded back out of the transcript, a command executed
without adding a model message, detached start + cancel, and the stdio bridge.

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
  sandbox policy (`permissionPreset`, or the deployment default); if a delegated turn needs approval,
  the prompt appears in the Harness GUI like any other session. Switching a session's preset from the
  GUI (`/permission`) and over MCP write the same durable events, so the last writer wins per session.
- **Commands are immediate and per agent.** `dsh_run_command` runs on the addressed agent's command
  layer (global + that agent's preset), so a preset-scoped command such as `/compact` may be absent for
  another session. It is not queued behind a running turn and it can mutate session state
  (`/permission`), so it carries the same authority as typing the command in the GUI; `dsh_list_commands`
  first is the way to know what a session accepts.
- Sessions started over MCP are ordinary DSH sessions: they appear in the Harness session list and can
  be opened and continued in the GUI.

## License

[MIT](LICENSE)
