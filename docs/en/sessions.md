# Sessions and delivery

> Part of [DSH MCP Server](../../README.en.md) · [Docs index](../README.md)

How a caller is identified, how sessions are owned, how a turn is waited on, and where a session appears.

## Caller identity and session ownership

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

## Waiting for a turn

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
