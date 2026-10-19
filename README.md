# DSH MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A DeepSeek Harness (DSH) plugin that publishes a **Model Context Protocol (MCP)** server from the
running Harness host, so other agent harnesses — Claude Code, Cursor, Codex, another DSH, any MCP
client — can call DSH: start sessions, drive turns, wait for them, read transcripts, and cancel work.

The plugin is a Host-only bundle with **zero dependencies** (no DSH import, no third-party module),
so it installs into a profile and survives Harness upgrades that keep the service contracts.
Every request is attributed to the calling agent and every session is recorded against its creator,
so several harnesses can share one endpoint and still ask "which sessions are mine?".

The same tool table is also registered into the local Harness, so a DSH agent calls these tools
directly — switchable on this bundle's row in the Web **Plugins** page, and clamped to the calling
session's own authority (see [DSH-local tools](#dsh-local-tools)).

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
| `dsh_list_sessions` | A page of the session index: `sessionId`, title, running state, archival state, activity time, and the recorded owning agent (`view: "full"` adds cwd and liveness). Narrow server-side with `query` (title/cwd/owner/id), `mine: true` (or the `restrictToOwner` setting), `owner: "<id>"`, and `running`; page with `cursor`/`nextCursor`. Archived sessions are hidden unless `includeArchived: true`, mirroring the Web UI. |
| `dsh_read_session` | A window of one session's transcript (user-authored and assistant messages only), plus the last durable `permissionPreset`. `mode: "tail"` (default, last 10) / `"head"` / `"outline"` (one compact row per message with a preview and length, no full text); `roles`, `afterSeq` + `window.nextAfterSeq` to page, `maxChars` (default 2000) to cap a single answer. Reports `totalMessages`, `matchedMessages` and `returned`, so the caller always knows what it has not read. `limit: 0` still means everything. Works while the session is archived. |
| `dsh_answer_request` | Answer a parked decision, only when the deployment sets `answerUserRequests: true`: `decision: "allow"|"deny"` for an approval (a one-shot grant, or a denial) or `answers: [{ id, selected }]` for a question. Ids come from `dsh_list_requests`, which marks what this endpoint parked with `answerable: true`. The GUI stays in the race — whoever decides first wins — and an unanswered request still fails closed at `requestAnswerTimeoutMs`. An internal DSH caller may only settle an **approval** while it already holds `danger-full-access`; questions are always answerable (see [DSH-local tools](#dsh-local-tools)). |
| `dsh_wait_session` | Block until the turn a session is already running ends, then return the assistant text it produced — for `wait: false` starts, GUI-driven sessions, or another caller's work. Never prompts, steers, or cancels: reaching `timeoutMs` returns `status: "timedOut"` with the turn still running, so call it again; `status: "idle"` returns immediately when nothing is running. |
| `dsh_list_requests` | The user decisions a session — or the newest visible sessions, running first — is waiting on: approval requests (`approval/asked` with no matching `approval/decided`, the one-shot permission decision behind a sandbox escalation) and unanswered `ask_user_question` calls, with tool, reason, call id and seq. These audit events are invisible to the model, so this is how a caller learns *why* a delegated turn stopped progressing. Reporting only: the decision is granted in the Harness GUI. |
| `dsh_search_sessions` | Find sessions by content server-side and get bounded snippets instead of transcripts: title/cwd/owner/id (`scope: "title"`) or the messages themselves (`"messages"`, `"both"` by default). Looks at the newest `scan` sessions the caller can see (default 20), reports `where`/`seq`/`snippet` per match, and then `dsh_read_session` reads just that session. |
| `dsh_whoami` | How this endpoint identifies the calling agent — `x-dsh-mcp-client` header, else `initialize` `clientInfo`, else `User-Agent` — plus the sessions that agent created. Attribution, not authentication: callers share the endpoint token. |
| `dsh_cancel_session` | Cancel the active turn of a session without dropping its pending inbox. |
| `dsh_archive_session` | Archive one session durably: hidden from every grouping surface, and it cannot run a model step until restored. A session with running work is refused unless `stopActivity: true` (which archives first, then stops that work). Archiving drops the pin. |
| `dsh_unarchive_session` | Drop a session from the archive set; it is listed again and returns to its recorded workspace position. |
| `dsh_list_permission_presets` | The deployment's permission presets (each bundles a sandbox mode with an approval policy) plus the default for new sessions, for the `permissionPreset` argument above. |
| `dsh_list_tools` | The tools DSH exposes to its own agents, for choosing what a delegated prompt can do; `query` narrows by name or description and `limit` caps the list. |
| `dsh_status` | Endpoint, profile, version, session/live-agent counts, default model, active turns, the default permission preset, and the local tool surface (`dshTools`). |

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

### Progressive disclosure

A session's log runs to megabytes and a Harness can hold hundreds of sessions, so no read is a dump:
each tool takes the smallest question that answers what the caller needs, and every payload says what
it did *not* return.

| Need | Call |
|---|---|
| Which sessions exist? | `dsh_list_sessions({ mine: true, query: "tripothon", limit: 10 })` — index rows are id, title, running, archived, time, owner. |
| The next page | `cursor: nextCursor` from the previous result. |
| What is in a long session? | `dsh_read_session({ sessionId, mode: "outline" })` — role, seq, chars, preview per message. |
| What just happened? | `dsh_read_session({ sessionId })` — the last 10 messages, with `window.reachedEnd`, `totalMessages` and `returned`. |
| Walk it forward | `afterSeq: window.nextAfterSeq`, `roles: ["user"]`, `maxChars: 0` when the full text is really needed. |
| Where was X mentioned? | `dsh_search_sessions({ query: "mount", mine: true })` — snippets from titles/cwd/owners and from the messages of the newest `scan` sessions. |
| Which Harness tools exist? | `dsh_list_tools({ query: "file" })`. |

Costs stay bounded by construction: `scan`, `limit`, `perSession` and `maxChars` are ceilings, not
hints, and a cut message carries `truncated: true` with its real length rather than silently losing
the tail.

### Pending user decisions

A turn can block on something the model never sees: an approval request (`approval/asked`, waiting for
the one-shot permission decision) or an `ask_user_question` call. `dsh_list_requests` folds those
audit events out of the session log — `{ sessionId }` for one session, or a scan of the newest sessions
(running ones first) narrowed by `mine`/`owner` — and returns each request with its tool,
reason, call id and seq. `includeSettled: true` also reports how earlier decisions resolved
(`allowed-once`, `rejected`, `cancelled`, `unavailable`).

A question a PTC agent dispatches for itself (from inside `run_code`) is folded from its dispatch-start
event, which is the only durable trace while the tool blocks the turn, and closes when that dispatch
settles. Reads and waits surface the same state as a compact `pending` summary, so a `timedOut` wait no longer
leaves the caller guessing.

By default this is **reporting only** — the decision is granted in the Harness GUI. With
`answerUserRequests: true` the endpoint becomes one of the composed answerers: it parks the request
and races it against every other answerer, so the GUI card still works and whoever decides first wins
(the GUI, or `dsh_answer_request`). Only sessions an MCP caller created or adopted are parked unless
`answerOwnedSessionsOnly: false`; an unanswered request fails closed at `requestAnswerTimeoutMs`.
Both halves are Cordis waterfall listeners (`approval/request`, `user-questions/request`), and the
scope filter admits an unscoped listener, which is how a Host plugin receives agent-scoped requests.

### Caller identity and session ownership

Every request is attributed to a calling agent and every session `dsh_run_prompt` creates is recorded
against that agent, so a shared endpoint can answer "which sessions did *this* agent start?":

| Rung | Signal | Example |
|---|---|---|
| 1 | `x-dsh-mcp-client` request header (or `--client` / `DSH_MCP_CLIENT` on the stdio bridge); a version may follow as `name@version` | `codex`, `claude-code@2.1.295` |
| 2 | the `clientInfo` block MCP clients send on `initialize`, cached per transport | `claude-code 2.0.1` |
| 3 | `User-Agent` | `cursor/1.2` |
| 4 | the auth peer (the bearer token, or DSH connection trust) | `token` |

A rung never borrows from a lower one: a caller that sets the header is named by that label alone, even
if another client's `clientInfo` shares its User-Agent. `dsh_whoami` returns the resolved identity, its
`source` rung, and the sessions that agent created;
`dsh_list_sessions` annotates each row with `owner` and `mine`, and accepts `mine: true`. The registry
lives in `$DSH_HOME/mcp/dsh-mcp-clients.json` (0600), so ownership survives a Harness restart.

This is **attribution, not authentication**: every caller presents the same endpoint token, and a
client may name itself anything with the header. Set `restrictToOwner: true` to turn the record into
isolation — a caller can then only list, read, wait on, continue, cancel, archive, or run commands in
the sessions it created (or adopted: a session with no recorded owner, such as one the GUI started,
is adopted by the first caller that drives it). A session owned by someone else is refused with a
diagnostic naming the owner.

Resources: `dsh://status`, `dsh://sessions`, and the template `dsh://session/{sessionId}`.

### Waiting for a turn

`dsh_run_prompt` and `dsh_continue_session` wait for their own turn by default. When a call must not
block for the whole turn, start it with `wait: false` and follow it with `dsh_wait_session`:

| Result | Meaning |
|---|---|
| `status: "completed"` / `"error"` | The turn ended; `text` is what it produced and `turnEndReason` is the Host's reason. |
| `status: "timedOut"` | `timeoutMs` was reached and the turn is **still running** — call `dsh_wait_session` again. |
| `status: "idle"` | No turn was running, so the call returned immediately. |

No wait path cancels or steers the session: a reached ceiling and a disconnected caller both only stop
waiting. A client with its own call timeout can therefore set `timeoutMs` below it and re-wait instead
of polling `dsh_read_session` in a loop. Only `dsh_cancel_session` stops a turn.

## DSH-local tools

The endpoint's tools are **also** callable from inside the running Harness — no second process, no MCP
client config. On by default; set `exposeToDsh: false` to keep the plugin MCP-only.

### On demand, not all at once

Seventeen tool schemas are ~16.4 KB (~4k tokens) of permanent prompt cost in **every** session, whether
that session ever delegates anything or not. So the default surface is a three-tool front door:

| Front-door tool | Purpose |
|---|---|
| `dsh_mcp_tools` | The catalogue: one line per published tool, marked `native` when it is already callable. `name` returns that tool's complete parameter schema. |
| `dsh_mcp_open` | Register the named tools (**or `all: true`) into *this* session**, so they are callable natively from the next step on. |
| `dsh_mcp_call` | Call one published tool directly, without opening it — for a single call that does not deserve a permanent schema. |

That is ~1.9 KB (~470 tokens) at rest instead of ~16.4 KB, and the rest of the table is paid for only by
sessions that actually use it. `dsh_status` reports the whole shape:
`dshTools: { enabled, mode, registered, published, via }`.

### Adding tools mid-session

`dsh_mcp_open` is not a naming trick: DSH supports adding tools while a session runs, and both
presentations follow the registry.

- **Native mode** changes the request's tool set. The agent loop writes a new `request/header` and appends
  a `developer/message` carrying `tool-addition` (and `tool-removal`) blocks, which the provider adapter
  renders in the form its own `toolUpdate` mode requires (`addition-only` or `in-history`).
- **PTC mode** sends exactly one `run_code` tool whatever is mounted, so the opened tools arrive in the
  regenerated SDK inside the prompt instead. Measured in this repository's own session: opening two tools
  grew the assembled `system/message` from 60,499 to 62,404 characters, the new names appear in it, and
  every `request/header` still listed only `run_code`.

Either way the registrations go into the **calling agent's** scope, so they follow that agent alone and
unwind when it is disposed — `open` in one session never leaks into another.

Set `exposeToDshMode: "full"` to put the whole table in the prompt at load instead, which is what
v0.7.0 did.

| Where | What |
|---|---|
| Web **Plugins** page → this bundle's row → **Configure** | The switch and the surface mode. They save through the profile configuration editor, so they land in `cordis.patch.yml` exactly like a hand edit, and the row reloads. |
| `GET /mcp-config` (loopback only) | The current state: `exposeToDsh`, `exposeToDshMode`, the MCP URL, the published and registered names, the version. |
| `POST /mcp-config` `{ "exposeToDsh": false }` or `{ "exposeToDshMode": "full" }` | The same writes the page performs. |

Both `dsh_status` and `GET /mcp-config` also report `clientPage: { available, inGraph, bundle }` — the
Host's browser module registry answering whether this bundle's page is really being served. It stays
`inGraph: false` until a restart composes a newly added client half, which is the difference between
"the page is missing" and "the page is not built yet".

### The authority ceiling

An internal caller is attributed and clamped, never trusted:

- **Attribution.** A local call is recorded against `dsh-agent:<sessionId>` — the session that made it,
  not the endpoint — so `dsh_whoami`, `mine: true`, `restrictToOwner` and `answerOwnedSessionsOnly`
  apply to it exactly as they do to an MCP caller.
- **A preset may not exceed the caller's own file policy.** `permissionPreset` on
  `dsh_run_prompt`/`dsh_continue_session`, and `/permission <preset>` on `dsh_run_command`, are
  refused when the preset's sandbox is wider than the caller's current mode
  (`read-only` < `workspace-write` < `danger-full-access`). Narrower or equal presets are allowed.
- **A session an internal caller starts is pinned to its own rung.** With no explicit preset the new
  session gets the caller's own preset, or the widest configured preset at the caller's mode — never
  the deployment default, which could be wider than the caller.
- **An approval needs the widest rung.** Settling an approval grants the asking session a sandbox
  strictly wider than its own, so an internal caller may only answer one while it already holds
  `danger-full-access`; anything else stays with the Harness GUI. Questions carry no privilege and
  are always answerable.

External MCP callers are unchanged — they present this endpoint's token, and the ceiling governs calls
made from inside DSH. The Harness GUI remains an answerer in every race.

## Sessions, projects, and message delivery

### A session the endpoint starts joins its directory's project

The Web sidebar groups Sessions by the Workspace registry's **recorded membership**
(`workspace.sessionIds`), not by comparing directories while it renders, and the registry's one-time
bootstrap only grouped the Sessions that already existed when it first ran. A Session created later by
this endpoint therefore trailed in **Ungrouped** even when its directory was already a project.

`dsh_run_prompt` now attaches the Session it just created to that directory's project — creating the
project when the directory has none — and returns it as `workspace: { id, path, title, created, attached }`.
A continuation joins the project its directory already has and never invents one. On activation the
plugin also repairs the backlog once, in the background: every Session its own caller registry attributes
to a caller, whose directory it recorded, is attached — which is what finally moves the Sessions created
by earlier builds out of Ungrouped. Set `groupSessions: false` to keep automation out of the sidebar.

### Queue or steer, following the deployment's own setting

`dsh_continue_session` takes `mode: "queue" | "steer"`. Omitted, it follows this deployment's
`ui-conversation.busyEnter` — the setting the Web composer's Enter key obeys — so sending into a busy
session behaves the way the user's own input does. `busyMode` pins one behaviour for every call
(`"queue"` or `"steer"`), and its `"setting"` default keeps following the live setting. The result
echoes the mode that was actually used (`mode: "steer" | "queue"`).

### A message from DSH names the session that sent it

A prompt sent from inside DSH is delivered with a durable source —
`{ kind: "dsh-mcp-server", sessionId: "<the sending session>", agentId }` — so the target Session's
transcript says where the message came from instead of reading as the user typing, and the result
carries `from: "<sending session>"`. External MCP callers keep the session controller's own `user`
source: they are not DSH Sessions, so there is no session id to name.

### Canonical results are lossless JSON

The Harness validates a tool's canonical value, and an internal (PTC) call has no JSON round trip to
hide a nested `undefined`: one unset field anywhere in a payload fails the whole call with
`value is not lossless JSON`. The DSH-facing surface projects every result through
`JSON.parse(JSON.stringify(...))` before returning it, so an unset field can only ever disappear.

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
| `turnTimeoutMs` | `1800000` | Default wait ceiling for a tool call that waits for a turn. Reaching it stops the wait, never the turn. |
| `maxConcurrentTurns` | `8` | Concurrent waited turns before new calls queue. `dsh_wait_session` starts no turn and takes no slot. |
| `answerUserRequests` | `false` | Become one of the deployment's answerers: park approvals and questions for sessions this endpoint drives so a caller can settle them with `dsh_answer_request`, racing the GUI (whoever decides first wins). |
| `answerOwnedSessionsOnly` | `true` | With answering on, only sessions an MCP caller created or adopted are parked; the GUI keeps every other card. |
| `requestAnswerTimeoutMs` | `600000` | How long a parked request waits for an MCP answer before it fails closed. |
| `restrictToOwner` | `false` | Confine each caller to the sessions it created or adopted: other sessions are refused by id, and `dsh_list_sessions` returns only its own. |
| `clientsFile` | `$DSH_HOME/mcp/dsh-mcp-clients.json` | Where the caller registry (agents seen + session owners) is kept, mode 0600. |
| `clientsFlushMs` | `5000` | How long registry writes are coalesced before they hit disk. |
| `exposeToDsh` | `true` | Expose the MCP tools to DSH itself. `false` keeps the endpoint MCP-only. |
| `exposeToDshMode` | `lazy` | `lazy` registers the three-tool front door and lets a session open what it needs; `full` registers all seventeen at load (permanent schema cost). An unknown value fails at load. |
| `exposeToDshPage` | `true` | Serve the loopback configuration route the Web Plugins page's switch reads and writes. |
| `configPath` | `<path>-config` | Route path of that configuration endpoint (`/mcp-config` by default). |
| `entryId` | `dsh-mcp-server` | Profile row the configuration page addresses when it saves the switch. |
| `groupSessions` | `true` | Attach the Sessions this endpoint starts to their directory's project in the Web sidebar (creating it when missing), and repair the Sessions earlier builds left in "Ungrouped". |
| `busyMode` | `setting` | Delivery to a session that is already running: `setting` follows the deployment's own `ui-conversation.busyEnter`, `queue` always waits for the next turn, `steer` always injects mid-turn. A caller's `mode` argument wins over all three. |
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
node test/client-half-test.mjs         # 8 checks: the browser half's row page and its read/write route
node test/plugin-integration-test.mjs  # 103 checks: apply(), endpoint file + advertised URL, tools,
                                       # transcript windows, outline/paging/truncation, search, index
                                       # cursors, pending user decisions (PTC included), parked approvals
                                       # and questions answered over MCP, waiting, caller identity +
                                       # restrictToOwner, archival tools, permissions, commands, model
                                       # pinning, hot-reload ownership, the on-demand DSH surface (catalogue,
                                       # open, dispatch), its authority ceiling, the configuration route,
                                       # sidebar grouping, delivery mode, sender attribution, lossless values
node test/stdio-bridge-test.mjs        # 4 checks, needs a RUNNING Harness (one real delegated turn)
node test/live-e2e-test.mjs            # 46 checks over HTTP: protocol, resources, all seventeen tools,
                                       # archive/unarchive, permission presets, commands, error paths,
                                       # 4 real turns (needs a Harness)
```

The bridge's schema projection was verified against the Harness's **own** JSON-Schema validator
(extracted from the app bundle): 11 of the 17 raw MCP schemas use keywords that validator rejects
(`minLength`, `maximum`), and all 17 projected schemas — plus canonical values of every shape — are
accepted.

Live checks used during development also covered: a real MCP client exchange against the running
Harness, an end-to-end `dsh_run_prompt` → `dsh_continue_session` → `dsh_read_session` flow, permission
presets applied and re-pinned over MCP and folded back out of the transcript, a command executed
without adding a model message, waiting on a detached turn without cancelling it, caller identity
over the header and User-Agent rungs, windowed/outlined transcript reads, detached start + cancel,
and the stdio bridge.

## Notes and limitations

- **The advertised URL is the listener's own.** The row's `url` and `DSH_WEB_URL` still win, but with
  neither set the endpoint file follows `ctx.webServer` (`protocol`/`host`/`port`) once the app is ready,
  so a Harness whose GUI port is OS-assigned no longer publishes a dead `19387` URL to stdio bridges and
  other clients.

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
- **The local surface needs the Harness tool registry.** `ctx.tools` (`@deepseek-ai/dsh-tools`) is
  composed in every shipped profile; without it the tools simply stay MCP-only and the log says so.
- **Adding the browser half needs a restart.** The Host half's tools land when the row reloads, but
  the Web client graph is composed at boot, so a new `lib/client.js` or `dsh.client` declaration shows
  its **Configure** page only after restarting DSH.
- **Opened tools stay open for the session.** `dsh_mcp_open` registers into the calling agent's scope and
  nothing removes them before the agent is disposed, so a session that opens everything keeps paying for
  it. Open the few tools a task needs; use `dsh_mcp_call` for one-offs.
- **Grouping is the sidebar's own membership record.** A Session's project is recorded, not derived
  while rendering, so "it runs in that directory" is not enough — something has to attach it. This plugin
  does that for the Sessions it starts and, once, for the ones it started before.
- Sessions started over MCP are ordinary DSH sessions: they appear in the Harness session list and can
  be opened and continued in the GUI.

## License

[MIT](LICENSE)
