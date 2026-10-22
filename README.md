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

## Architecture

The plugin is an adapter between two contracts: MCP on the outside, DSH services on the inside. Nothing it
ships imports a DSH package, so every layer talks through `ctx` and plain data.

| Module | Role |
|---|---|
| [`index.js`](index.js) | Composition root: reads the row config, registers the routes and the local tools, and owns the plugin's `ctx.effect`s (endpoint publication, route/tool/state disposal) so a reload unwinds what it created. |
| [`lib/protocol.js`](lib/protocol.js) | MCP wire: JSON-RPC envelope, protocol-version negotiation, error codes, gateway dispatch. |
| [`lib/http-route.js`](lib/http-route.js) / [`bin/dsh-mcp-stdio.mjs`](bin/dsh-mcp-stdio.mjs) | The two transports: Streamable HTTP on the Harness listener, and a stdio bridge that forwards to that same endpoint. |
| [`lib/dsh-capabilities.js`](lib/dsh-capabilities.js) | The DSH-facing tools and resources; each maps onto live services (`sessionController`, `sessionQuery`, `tools`, …). |
| [`lib/authority.js`](lib/authority.js) | The authority arithmetic those tools are clamped by: the sandbox ladder, workspace containment, and the `cwd` clamp. |
| [`lib/dsh-contracts.js`](lib/dsh-contracts.js) | The shape of the events and messages the tools read: session ids, message prose, transcript rows, turn numbers, failure text — one definition instead of a copy per caller. Transport-level error formatting stays with the transport. |
| [`lib/dsh-tools-bridge.js`](lib/dsh-tools-bridge.js) | The same table exposed *into* DSH: the three-tool front door or the full registry installed in the injected tools scope, plus tools opened lazily in the calling agent's own scope. |
| [`lib/clients.js`](lib/clients.js) | Caller identity and session ownership: header/`clientInfo`/User-Agent, a 0600 registry, and the owner a session is recorded against. |
| [`lib/config-route.js`](lib/config-route.js) + [`lib/client.js`](lib/client.js) | Control plane: a loopback JSON route and the browser panel that reads and writes it — rendered on the bundle's own Plugins page (above its component rows) and as the row's Configure page. |
| [`lib/transcript.js`](lib/transcript.js) | Windowed transcript reads: tail/head/outline, role and sequence filters, per-message caps and the response budget. |
| [`work-sync.js`](work-sync.js) | The **second bundle row**: mounts task-start progress sync, publishes it as the `workSync` service, and owns its own config. |
| [`lib/work-sync.js`](lib/work-sync.js) | The sync engine itself: who to ask, claim correlation, deadlines — built only on `session/event`. |
| [`lib/workspace-grouping.js`](lib/workspace-grouping.js) | Put a session this endpoint starts into the sidebar project its directory already has. |

Three rules keep the layering honest. **Services, not re-implementations**: transcript reads replay the durable
event log, permissions come from `permissionPresets`, sidebar membership from `workspaceRegistry`. **Narrow
seams**: the transport never touches a session, and the capabilities never touch a socket. **Only own state on
disk**: everything this plugin persists is its own state (`$DSH_HOME/mcp/*.json` by default; `endpointFile` and
`clientsFile` move it) at mode 0600 — never a session, a transcript, or a setting DSH already owns.

## What it exposes

| MCP tool | Purpose |
|---|---|
| `dsh_run_prompt` | Start a **new** DSH session and run one prompt; returns the assistant's final text and the new `sessionId`. Supports `cwd`, `agentPreset`, `permissionPreset`, `model` (`provider/model`), `wait: false`, `timeoutMs`. |
| `dsh_continue_session` | Send a prompt to an **existing** session (resuming it if it is cold). Keeps the session's context and workspace; `permissionPreset` re-pins the session's sandbox mode and approval policy before the prompt, and `model` (`provider/model`) overrides the session's model. Without `model` the session keeps the model it already runs. |
| `dsh_list_commands` | The slash commands a session's agent can currently run: the global command layer plus whatever that agent's preset composes, so availability differs per agent preset. |
| `dsh_run_command` | Run one slash command in a session and return its settled `{ kind, text, commandId }`. `line` takes a complete command line (`"/compact"`, `"/permission danger-full-access"`); `command` (+ optional `args`) takes a bare name. The command executes immediately without a model turn. |
| `dsh_list_sessions` | A page of the session index: `sessionId`, title, running state, archival state, activity time, and the recorded owning agent (`view: "full"` adds cwd and liveness). Narrow server-side with `query` (title/cwd/owner/id), `mine: true` (or the `restrictToOwner` setting), `owner: "<id>"` (narrowing only: on a restricted endpoint another owner is refused), and `running`; page with `cursor`/`nextCursor`. Archived sessions are hidden unless `includeArchived: true`, mirroring the Web UI. |
| `dsh_read_session` | A window of one session's transcript (user-authored and assistant messages only), plus the last durable `permissionPreset`. `mode: "tail"` (default, last 10) / `"head"` / `"outline"` (one compact row per message with a preview and length, no full text); `roles`, `afterSeq` + `window.nextAfterSeq` to page, `maxChars` (default 2000) to cap a single answer. Reports `totalMessages`, `matchedMessages` and `returned`, so the caller always knows what it has not read. `limit: 0` asks for the largest window (capped at 1000 messages), and one response is capped at about 512K characters (`truncatedByBudget`), so a read can never dump a whole long session. Works while the session is archived. |
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
| `dsh_open_session` | Ask the running Web GUI to open one session and select it in the sidebar — for pointing the person at a session this endpoint started. Queued for the page that is open and consumed once; the session itself is untouched. |
| `dsh_status` | Endpoint, profile, version, session/live-agent counts, default model, active turns, the default permission preset, the delivery policy, and the local tool surface (`dshTools`). |

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
| 2 | the `clientInfo` block MCP clients send on `initialize`, cached per explicit client label | `claude-code 2.0.1` |
| 3 | `User-Agent` | `cursor/1.2` |
| 4 | the auth peer (the bearer token, or DSH connection trust) | `token` |

A rung never borrows from a lower one: a caller that sets the header is named by that label alone, even
if another client's `clientInfo` shares its User-Agent. `dsh_whoami` returns the resolved identity, its
`source` rung, and the sessions that agent created;
`dsh_list_sessions` annotates each row with `owner` and `mine`, and accepts `mine: true`. The registry
lives in `$DSH_HOME/mcp/dsh-mcp-clients.json` (0600), so ownership survives a Harness restart.

This is **attribution, not authentication**: every caller presents the same endpoint token, and a
client may name itself anything with the header. `restrictToOwner: true` therefore confines honest
callers, not an attacker who holds the token: it is a guard against accidents, not a credential
boundary. With it on, a caller can only list, read, wait on, continue, cancel, archive, or run
commands in the sessions it created (or adopted: a session with no recorded owner, such as one the
GUI started, is adopted by the first caller that drives it). The `owner` filter cannot widen that
scope — naming another owner is refused — and a session owned by someone else is refused with a
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

Eighteen tool schemas are ~17.2 KB (~4.3k tokens) of permanent prompt cost in **every** session, whether
that session ever delegates anything or not. So the default surface is a three-tool front door:

| Front-door tool | Purpose |
|---|---|
| `dsh_mcp_tools` | The catalogue — every published name **with its call signature** — plus one line per tool and `native` when it is already callable. `name` returns that tool's parameter schema, projected for the DSH registry. |
| `dsh_mcp_open` | Register the named tools (**or `all: true`) into *this* session**, so they are callable natively from the next step on. The target is always explicit: an empty or missing list is refused rather than quietly opening all eighteen. |
| `dsh_mcp_call` | Call one published tool directly, without opening it — for a single call that does not deserve a permanent schema. |

That is ~3.0 KB (~750 tokens) at rest instead of ~17.2 KB, and the rest of the table is paid for only by
sessions that actually use it. `dsh_status` reports the whole shape:
`dshTools: { enabled, mode, registered, published, via }`.

### Knowing without looking

A front door that only says "there is a catalogue" costs the model a step: it calls `dsh_mcp_tools`
before it can call anything, and pays that step again in every new session. So the front door states the
catalogue itself — every published name with its required arguments, inside `dsh_mcp_tools`'s own
description:

> Publishes 18: dsh_run_prompt(prompt), dsh_continue_session(sessionId, prompt), dsh_list_commands(sessionId), …

That index is ~600 characters (~150 tokens) and turns "send this to session X" into a single call:
`dsh_mcp_call({ tool: "dsh_continue_session", arguments: { sessionId, prompt } })`. Names are forgiving:
a bare `continue_session` resolves, a near miss is refused with the close matches named, `arguments`
accepts a JSON object string, and a refused call ends by naming the `dsh_mcp_tools({ name })` lookup that
fixes it. The index is the whole discovery budget — nothing else is paid until a tool is actually opened.

Two tools whose `required` list is not their whole signature say so in the index —
`dsh_run_command(sessionId, line|command)` and `dsh_answer_request(requestId, decision|answers)` — because a
signature a model would be refused for following is worse than no signature at all.

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
| Web **Plugins** page → this bundle's page (or a row → **Configure**) | The switch and the surface mode, shown directly on the bundle page. They save through the profile configuration editor, so they land in `cordis.patch.yml` exactly like a hand edit, and the row reloads. |
| `GET /mcp-config` (loopback only) | The current state: `exposeToDsh`, `exposeToDshMode`, the MCP URL, the published and registered names, the version. |
| `POST /mcp-config` `{ "exposeToDsh": false }` or `{ "exposeToDshMode": "full" }` | The same writes the page performs. |
| `POST /mcp-config` `{ "removeGroups": ["/abs/path"] }` | Drop project registrations by directory — the way to undo grouping automation. No folder, file, or Session is touched; those Sessions return to Ungrouped. |

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
- **A session starts inside the caller's own workspace.** The `cwd` of a session an internal caller
  starts must resolve inside that caller's recorded workspace root (symlinks included); without a
  `cwd` it defaults to that root. DSH takes a session's workspace-write boundary from its cwd, so
  naming another directory would hand the new session a wider write root than the caller holds.
- **Driving an existing session is clamped too.** `dsh_continue_session` and `dsh_run_command` refuse
  a target whose sandbox mode is wider than the caller's, or whose writable workspace lies outside it.

External MCP callers are unchanged — they present this endpoint's token, and the ceiling governs calls
made from inside DSH. The Harness GUI remains an answerer in every race.

## Sessions, projects, and message delivery

### A session the endpoint starts joins its directory's project

The Web sidebar groups Sessions by the Workspace registry's **recorded membership**
(`workspace.sessionIds`), not by comparing directories while it renders, and the registry's one-time
bootstrap only grouped the Sessions that already existed when it first ran. A Session created later by
this endpoint therefore trailed in **Ungrouped** even when its directory was already a project.

`dsh_run_prompt` attaches the Session it just created to the project its directory **already** has, and
returns it as `workspace: { id, path, title, created, attached }`. It never invents a project: a
directory with no project keeps its Sessions in Ungrouped, which is where the Harness itself would put
them. `createGroups: true` opts into inventing one; `groupSessions: false` turns the whole behaviour off.

A continuation joins an existing project and never creates one. On activation the plugin also repairs the
backlog once, in the background, under the same rule: every Session its own caller registry attributes to
a caller, whose directory already is a project, is attached — which is what moves the Sessions created by
earlier builds out of Ungrouped. A project this endpoint did create can be dropped again with
`POST /mcp-config { "removeGroups": ["/abs/path"] }`, or from the sidebar's own delete action; either way
the Sessions stay and simply return to Ungrouped.

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

## Task-start progress sync

Two agents editing one tree is how work gets lost, so a session starting a task first asks the other
agents working in the **same workspace** what they are doing and which files they are touching.

This is its own bundle row. The bundle patch inserts two rows — `dsh-mcp-server` and `dsh-work-sync` — so the
endpoint never mounts the engine itself: it reads `ctx.get('workSync')` for the settings page and
`dsh_status`, and saves the one switch through the profile editor on that row.

- **One question per top-level agent.** The asker resolves each peer's top-level (root) session and asks
  only that one; a root answers on behalf of its whole subtree. A sub-agent never questions peers — it asks
  its own top-level agent, because that is the only place its answer can come from.
- **Same workspace only.** A peer whose recorded `cwd` differs is never asked and never negotiated with.
  That is not configurable: crossing workspaces cannot prevent a collision.
- **The asker does not wait.** It keeps thinking. When the peer answers — its next assistant message — the
  text reaches the asker as a message labelled with the session that sent it, telling it to adjust its order
  and, if the work is duplicate or conflicting, to negotiate with that peer before continuing. A report is
  only handed over while the asker is still working: once its turn has ended, the question is dropped, so a
  finished session is never woken by a late answer or a timeout note.
- **An answer is only an answer once the peer has seen the notice.** The engine waits for the sourced
  `user/message` the peer's own log records when it claims the notice, and only then treats the next
  assistant message as the report; text already in flight when the notice arrived is not mistaken for it.
  A sub-agent's report is handed to its live agent handle, because the API controller deliberately refuses
  subagent-owned sessions.
- **The turn a notice starts is not mistaken for a task.** A delivery that joins a running turn opens none;
  one that opens a turn is counted and consumed by that turn, so it is not answered with another round.
  One question per pair at a time, one round per asker, and the cooldown bound what is left; a peer that
  never answers produces exactly one line, and a sub-agent's notice never wakes an idle root.

On by default: a deployment running one agent at a time pays nothing, because no notice is ever sent when
no peer is running. `syncOnStart: false` on the **dsh-work-sync row** turns it off; the switch on the Plugins
page saves that row, and the advanced knobs (`syncCooldownMs`, `syncWaitMs`, `syncMaxPeers`) are
configuration-only there. `dsh_status` reports `sync: { enabled, present, peersAsked, pending, reports }`;
without the row this endpoint runs normally, reports `present: false`, and refuses to save the switch with a
message naming the row to add. `GET /mcp-config` reports the switch itself.

## Point the GUI at a session

`dsh_open_session({ sessionId })` asks whichever Harness page is open to open that session and select it
in the sidebar. It is the difference between telling someone a session id and showing them the session.

DSH forwards only an **allowlist of Host events** to the browser, and that list is fixed when DSH is built,
so a plugin cannot push a notification of its own. The page polls this plugin's loopback route instead:

| Step | What happens |
|---|---|
| 1 | The tool (or `POST /mcp-config { "openSession": "<id>" }`) queues one command on the Host. |
| 2 | The open page polls `GET /mcp-config` every 1.5 s while it is visible and reads `command`. |
| 3 | It calls the client's own `uiWorkspace.openSession(id)` and then acknowledges with `{ "ackCommand": true }`. |

A command that no page consumes expires after 60 s, so opening the GUI later never jumps unexpectedly. The
tool refuses an id the Harness does not know, and it changes nothing about the session: no turn, no
message, no state.

## The plugin's own settings page

The panel sits on the bundle's **own page** on the Web **Plugins** page, directly under the package title
and above its component rows (the page shows it because the bundle registers a `plugins.bundle.config`
entry keyed by its package name). It also remains the bundle row's **Configure** page, so either entry
reaches the same switches. It carries every switch this plugin has, so none of them needs a YAML edit:

| Control | Writes |
|---|---|
| On/off | `exposeToDsh` |
| Surface: on demand / all at once | `exposeToDshMode` |
| Sidebar projects: join / may create | `groupSessions`, `createGroups` |
| Delivery while busy: follow the setting / queue / steer | `busyMode` (with the value the setting currently resolves to) |
| Task-start progress sync: on / off | `syncOnStart` on the `dsh-work-sync` row |

Each control saves through the profile configuration editor and reloads this plugin's row, exactly as a
hand edit would. The panel mirrors the Harness's own settings section: a bold section title with a short summary
(version, published and registered counts), then one row per setting — a 14px title over a 12px description on
the left, the control on the right, and a `.5px` hairline between rows.

The controls are the Harness's own UI primitives, not re-implementations: `Switch`, `SegmentedControl`,
`Pill` and `Button` come from `@deepseek-ai/dsh-client-ui-primitives`, which the client module loader exposes
as a platform seed. The toggles are therefore DSH's capsule switches at DSH's size, and the segmented choices are
DSH's segmented control; they track the theme by construction.

The route is loopback-only **and** browser-hardened: a request carrying a foreign `Origin`/`Sec-Fetch-Site`
is refused through DSH's own connection fence, the body must be `application/json`, unknown fields are
rejected, and an oversized body gets a `413` rather than a reset socket. A local tool that sends no
`Origin` can still POST JSON.

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
| `exposeToDshMode` | `lazy` | `lazy` registers the three-tool front door, whose `dsh_mcp_tools` description already carries every published name and its required arguments (the result rows are name/purpose/native only), and lets a session open what it needs; `full` registers all eighteen at load (permanent schema cost). An unknown value fails at load. |
| `exposeToDshPage` | `true` | Serve the loopback configuration route the Web Plugins page's switch reads and writes. |
| `configPath` | `<path>-config` | Route path of that configuration endpoint (`/mcp-config` by default). |
| `entryId` | `dsh-mcp-server` | Profile row the configuration page addresses when it saves the switch. |
| `groupSessions` | `true` | Attach the Sessions this endpoint starts to the project their directory **already** has, and, once and in the background, restore the Sessions earlier builds left in "Ungrouped". |
| `createGroups` | `false` | Let this endpoint invent a sidebar project for a directory that has none. Off by default: automation does not grow the sidebar on its own, and a Session whose directory has no project stays in Ungrouped. |
| `busyMode` | `setting` | Delivery to a session that is already running: `setting` follows the deployment's own `ui-conversation.busyEnter`, `queue` always waits for the next turn, `steer` always injects mid-turn. A caller's `mode` argument wins over all three. |
| `syncEntryId` | `dsh-work-sync` | Profile row the settings page writes the task-start sync switch to. |
| `dsh-work-sync` → `syncOnStart` | `true` | **On the sync row**: when a task starts, ask the other agents working in the same workspace what they are doing and which files they are touching. The Plugins page switch saves this row. |
| `dsh-work-sync` → `syncCooldownMs` | `300000` | How long one session waits before asking the same peer again. |
| `dsh-work-sync` → `syncWaitMs` | `120000` | How long a peer's report is awaited before the asker is told it is still working. |
| `dsh-work-sync` → `syncMaxPeers` | `3` | How many peers one round may ask. |
| `maxBodyBytes` | `8388608` | Request body ceiling of the MCP endpoint. |
| `configMaxBodyBytes` | `4096` | Request body ceiling of the loopback configuration route. Separate from `maxBodyBytes` on purpose: that route only ever receives a switch patch, so it keeps a much smaller ceiling. Clamped to 1 KB - 1 MB; a value outside the range (or a non-number) is ignored. |
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

The bundle's patch inserts **two rows**: `dsh-mcp-server` (the endpoint) and `dsh-work-sync` (task-start
progress sync, below). They are separate rows on purpose — sync can be disabled, reloaded or replaced without
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

## Model Experience

What a calling model sees, and why it was shaped that way:

- **`initialize` instructions are the map, not a tool dump.** They say which tool starts a session and which
  continues one, when to use `wait: false` + `dsh_wait_session` (waiting never cancels), that reads are windows
  (`mode`/`maxChars`/`afterSeq`) rather than dumps, and that approvals and questions are reported per session
  and answerable only when the deployment enables `answerUserRequests`.
- **Descriptions carry what a schema cannot.** `dsh_run_command(sessionId, line|command)` says its two shapes in
  the signature because a model that follows a wrong one is worse off than a model given none.
- **Failures are typed.** An unknown tool or a malformed resource id is `-32602 invalidParams`; a normal tool
  failure is an `isError` result that does not end the turn. Messages say what to do next ("retry with
  `stopActivity: true`", "raise this session's preset in the Harness GUI") instead of leaking a stack.
- **The surface is load-aware.** `exposeToDshMode: lazy` gives a DSH session three tools, and the `dsh_mcp_tools`
  description already carries every published name and its required arguments (the result rows are name, purpose
  and `native`); `full` puts all eighteen in the prompt.
- **Status is one call.** `dsh_status` answers "what am I talking to" — endpoint, plugin version, live model
  selection, delivery policy, sync state, tool-table shape — without probing.

## Verification

```bash
node test/mcp-self-test.mjs            # 11 transport checks, no Harness needed
node test/contracts-test.mjs           # 6 checks: the Harness wire shapes, pinned in one place
node test/authority-test.mjs           # 5 checks: the sandbox ladder, containment, and the cwd clamp
node test/transcript-test.mjs          # 7 checks: transcript windows, cursors, caps and the response budget
node test/work-sync-test.mjs           # 18 checks: the progress-sync engine against a fake Harness
node test/work-sync-plugin-test.mjs    # 5 checks: the sync bundle row's service, messages, switch, disposal
node test/turn-wait-test.mjs          # 2 checks: which turn a queued or steered prompt reports
node test/client-half-test.mjs         # 18 checks: the browser half's bundle page, its row page, its route
node test/plugin-integration-test.mjs  # 121 checks: apply(), endpoint file + advertised URL, tools,
                                       # transcript windows, outline/paging/truncation, search, index
                                       # cursors, pending user decisions (PTC included), parked approvals
                                       # and questions answered over MCP, waiting, caller identity +
                                       # restrictToOwner, archival tools, permissions, commands, model
                                       # pinning, hot-reload ownership, the on-demand DSH surface (catalogue,
                                       # open, dispatch), its authority ceiling, the configuration route,
                                       # sidebar grouping, delivery mode, sender attribution, lossless values,
                                       # the workspace-root clamp, restrictToOwner's owner filter, the
                                       # configuration route's origin/content-type/413 fences, live default
                                       # model resolution, ownership persistence, and that sync is a separate row
node test/stdio-bridge-test.mjs        # 4 checks, needs a RUNNING Harness (one real delegated turn)
node test/live-e2e-test.mjs            # 46 checks over HTTP: protocol, resources, all eighteen tools,
                                       # archive/unarchive, permission presets, commands, error paths,
                                       # 4 real turns (needs a Harness)
```

The bridge's schema projection was verified against the Harness's **own** JSON-Schema validator
(extracted from the app bundle): 12 of the 18 raw MCP schemas use `minLength`, a keyword that validator
rejects outright, and all 18 projected schemas — plus canonical values of every shape — are accepted.

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
- **Task-start sync is its own row.** `dsh-work-sync` is inserted by this bundle's patch and owns its config;
  without it the endpoint still serves MCP, `dsh_status.sync.present` is `false`, and saving the switch
  explains which row to add. Its engine state is in memory, so reloading that row drops questions that were
  still open. A profile that carried the old `syncOnStart` on the `dsh-mcp-server` row keeps it only as a
  hint — the sync row's own config is authoritative.
- **The settings page keeps the default route and row key.** `configPath`/`entryId` change where the Host serves
  the route and which row is written, but the browser half is built with `/mcp-config` and
  `<package>#<row id>`; a renamed route or row needs a matching build.
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
  does that for the Sessions it starts and, once, for the ones it started before, and it only ever joins a
  project that already exists.
- Sessions started over MCP are ordinary DSH sessions: they appear in the Harness session list and can
  be opened and continued in the GUI.

## License

[MIT](LICENSE)
