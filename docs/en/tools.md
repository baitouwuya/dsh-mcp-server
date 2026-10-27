# Tools and resources

> Part of [DSH MCP Server](../../README.en.md) · [Docs index](../README.md)

Twenty-one MCP tools, two resources and one resource template — each shaped so that no call dumps a session.

## What it exposes

| MCP tool | Purpose |
|---|---|
| `dsh_run_prompt` | Start a **new** DSH session and run one prompt; returns the assistant's final text and the new `sessionId`. Supports `cwd`, `agentPreset`, `permissionPreset`, `model` (`provider/model`), `wait: false`, `timeoutMs`. |
| `dsh_continue_session` | Send a prompt to an **existing** session (resuming it if it is cold). Keeps the session's context and workspace; `permissionPreset` re-pins the session's sandbox mode and approval policy before the prompt, and `model` (`provider/model`) overrides the session's model. Without `model` the session keeps the model it already runs. |
| `dsh_ask_session` | Ask one session a question it **must answer**, and wait for the answer. The question gets an id (`q-…`), and the call does not return first — the asking turn cannot end without one. Only the addressed session may answer; while the question is open, the id-only reminder is injected into the target's own next steps (never a wake-up). `timeoutMs` (default 0) sets an optional deadline. |
| `dsh_answer_question` | Answer a must-reply question by id, from the addressed session. The waiting `dsh_ask_session` call returns this text and the asking turn continues. |
| `dsh_get_question` | Read a must-reply question by id: its text, who asked, when, how many reminders were sent, and the answer once it exists. Reminders carry only the id; this is how the target reads the question again. |
| `dsh_list_commands` | The slash commands a session's agent can currently run: the global command layer plus whatever that agent's preset composes, so availability differs per agent preset. |
| `dsh_run_command` | Run one slash command in a session and return its settled `{ kind, text, commandId }`. `line` takes a complete command line (`"/compact"`, `"/permission danger-full-access"`); `command` (+ optional `args`) takes a bare name. The command executes immediately without a model turn. |
| `dsh_list_sessions` | A page of the session index: `sessionId`, title, running state, archival state, activity time, and the recorded owning agent (`view: "full"` adds cwd and liveness). Narrow server-side with `query` (title/cwd/owner/id), `mine: true` (or the `restrictToOwner` setting), `owner: "<id>"` (narrowing only: on a restricted endpoint another owner is refused), and `running`; page with `cursor`/`nextCursor`. Archived sessions are hidden unless `includeArchived: true`, mirroring the Web UI. |
| `dsh_read_session` | A window of one session's transcript (user-authored and assistant messages only), plus the last durable `permissionPreset`. `mode: "tail"` (default, last 10) / `"head"` / `"outline"` (one compact row per message with a preview and length, no full text); `roles`, `afterSeq` + `window.nextAfterSeq` to page, `maxChars` (default 2000) to cap a single answer. Reports `totalMessages`, `matchedMessages` and `returned`, so the caller always knows what it has not read. `limit: 0` asks for the largest window (capped at 1000 messages), and one response is capped at about 512K characters (`truncatedByBudget`), so a read can never dump a whole long session. Works while the session is archived. |
| `dsh_answer_request` | Answer a parked decision, only when the deployment enables `answerApprovals` and/or `answerQuestions` (or the legacy `answerUserRequests`): `decision: "allow"|"deny"` for an approval (a one-shot grant, or a denial) or `answers: [{ id, selected }]` for a question. Ids come from `dsh_list_requests`, which marks what this endpoint parked with `answerable: true`. The GUI stays in the race — whoever decides first wins — and an unanswered request still fails closed at `requestAnswerTimeoutMs`. An internal DSH caller may only settle an **approval** while it already holds `danger-full-access`; questions are always answerable (see [DSH-local tools](dsh-local.md)). |
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
| `dsh_status` | Endpoint, profile, version, session/live-agent counts, default model, active turns, the default permission preset, the delivery policy, the local tool surface (`dshTools`), the configuration preset (`configPreset`), the answering switches (`answering`), and the must-reply questions held open (`questions`). |

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

## Progressive disclosure

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

## Pending user decisions

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
`answerApprovals` and/or `answerQuestions` (or the legacy `answerUserRequests`) the endpoint becomes one of the composed answerers: it parks the request
and races it against every other answerer, so the GUI card still works and whoever decides first wins
(the GUI, or `dsh_answer_request`). Only sessions an MCP caller created or adopted are parked unless
`answerOwnedSessionsOnly: false`; an unanswered request fails closed at `requestAnswerTimeoutMs`.
Both halves are Cordis waterfall listeners (`approval/request`, `user-questions/request`), and the
scope filter admits an unscoped listener, which is how a Host plugin receives agent-scoped requests.

## Resources

- `dsh://status` — endpoint, version, session/live-agent counts and the tool surface.
- `dsh://sessions` — the visible session index.
- `dsh://session/{sessionId}` — one session’s transcript, read with the same windowing rules.

