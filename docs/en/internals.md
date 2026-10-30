# Internals

> Part of [DSH MCP Server](../../README.en.md) · [Docs index](../README.md)

How the pieces fit, what compatibility means here, and what remains a limitation.

## Architecture

The plugin is an adapter between two contracts: MCP on the outside, DSH services on the inside. Nothing it
ships imports a DSH package, so every layer talks through `ctx` and plain data.

| Module | Role |
|---|---|
| [`index.js`](../../index.js) | Composition root: reads the row config, registers the routes and the local tools, and owns the plugin's `ctx.effect`s (endpoint publication, route/tool/state disposal) so a reload unwinds what it created. |
| [`lib/protocol.js`](../../lib/protocol.js) | MCP wire: JSON-RPC envelope, protocol-version negotiation, error codes, gateway dispatch. |
| [`lib/http-route.js`](../../lib/http-route.js) / [`bin/dsh-mcp-stdio.mjs`](../../bin/dsh-mcp-stdio.mjs) | The two transports: Streamable HTTP on the Harness listener, and a stdio bridge that forwards to that same endpoint. |
| [`lib/dsh-capabilities.js`](../../lib/dsh-capabilities.js) | The DSH-facing tools and resources; each maps onto live services (`sessionController`, `sessionQuery`, `tools`, …). |
| [`lib/capabilities/definitions.js`](../../lib/capabilities/definitions.js) | The static catalogue: every tool schema and the three `dsh://` resource descriptors, so the caller-facing contract can be read without the live-service plumbing. |
| [`lib/capabilities/requests.js`](../../lib/capabilities/requests.js) | User decisions: the pure fold that reads pending approvals and questions out of a session log, plus the injected parking/answering hooks that let an MCP caller settle one. |
| [`lib/authority.js`](../../lib/authority.js) | The authority arithmetic those tools are clamped by: the sandbox ladder, workspace containment, and the `cwd` clamp. |
| [`lib/dsh-contracts.js`](../../lib/dsh-contracts.js) | The shape of the events and messages the tools read: session ids, message prose, transcript rows, turn numbers, failure text — one definition instead of a copy per caller. Transport-level error formatting stays with the transport. |
| [`lib/dsh-tools-bridge.js`](../../lib/dsh-tools-bridge.js) | The same table exposed *into* DSH: the three-tool front door or the full registry installed in the injected tools scope, plus tools opened lazily in the calling agent's own scope. |
| [`lib/clients.js`](../../lib/clients.js) | Caller identity and session ownership: header/`clientInfo`/User-Agent, a 0600 registry, and the owner a session is recorded against. |
| [`lib/config-route.js`](../../lib/config-route.js) + [`lib/client.js`](../../lib/client.js) | Control plane: a loopback JSON route and the browser panel that reads and writes it — rendered on the bundle's own Plugins page (above its component rows) and as the row's Configure page. |
| [`lib/transcript.js`](../../lib/transcript.js) | Windowed transcript reads: tail/head/outline, role and sequence filters, per-message caps and the response budget. |
| [`work-sync.js`](../../work-sync.js) | The **second bundle row**: mounts task-start progress sync, publishes it as the `workSync` service, and owns its own config. |
| [`lib/work-sync.js`](../../lib/work-sync.js) | The sync engine itself: who to ask, claim correlation, deadlines — built only on `session/event`. |
| [`lib/questions.js`](../../lib/questions.js) | Must-reply questions: the id, the blocking wait, id-only reminders injected into the target's own calls, human-stop settlement, the answer, and deadlock/abort handling — delivery and the clock are injected. |
| [`lib/workspace-grouping.js`](../../lib/workspace-grouping.js) | Put a session this endpoint starts into the sidebar project its directory already has. |

Three rules keep the layering honest. **Services, not re-implementations**: transcript reads replay the durable
event log, permissions come from `permissionPresets`, sidebar membership from `workspaceRegistry`. **Narrow
seams**: the transport never touches a session, and the capabilities never touch a socket. **Only own state on
disk**: everything this plugin persists is its own state (`$DSH_HOME/mcp/*.json` by default; `endpointFile` and
`clientsFile` move it) at mode 0600 — never a session, a transcript, or a setting DSH already owns.

## DSH compatibility

The bundle imports no DSH package, so compatibility is a question of service contracts rather than a
version pin. It is checked against **DSH 0.2.1-rc.5** (Cordis 4.0.5) on the live Harness: the session
controller (`list`, `resolveAgent`, `create`, `cancel`, `follow`, `selectModel`), `sessionQuery`,
the live `agents` registry and its handle methods (`followup`, `steer`, `inject`), `permissionPresets`,
`commands`, `workspaceRegistry`, `configEditor`, `clientModules`, the web-server route, the
`session/event` shapes and turn-end reasons, and the Web module loader's seed (`react`,
`@deepseek-ai/dsh-client-ui-primitives`, `…-ui-slots`, …) with the `plugins.row.config` /
`plugins.bundle.config` slot keys.

One Harness rule matters for any plugin that reacts to `session/event`: a listener runs **inside the
session's append commit**, where a nested append is rejected (`session append cannot reenter while
another append is being published`). Every delivery this bundle makes from a listener — a must-reply
reminder injection or withdrawal, a work-sync report or timeout line — yields one microtask before
delivering, so the commit has closed first.

## Model Experience

What a calling model sees, and why it was shaped that way:

- **`initialize` instructions are the map, not a tool dump.** They say which tool starts a session and which
  continues one, when to use `wait: false` + `dsh_wait_session` (waiting never cancels), that reads are windows
  (`mode`/`maxChars`/`afterSeq`) rather than dumps, and that approvals and questions are reported per session
  and answerable only when the deployment enables `answerApprovals`/`answerQuestions` (or the legacy `answerUserRequests`).
- **Descriptions carry what a schema cannot.** `dsh_run_command(sessionId, line|command)` says its two shapes in
  the signature because a model that follows a wrong one is worse off than a model given none.
- **Failures are typed.** An unknown tool or a malformed resource id is `-32602 invalidParams`; a normal tool
  failure is an `isError` result that does not end the turn. Messages say what to do next ("retry with
  `stopActivity: true`", "raise this session's preset in the Harness GUI") instead of leaking a stack.
- **The surface is load-aware.** `exposeToDshMode: lazy` gives a DSH session three tools, and the `dsh_mcp_tools`
  description already carries every published name and its required arguments (the result rows are name, purpose
  and `native`); `full` puts all twenty-one in the prompt.
- **Status is one call.** `dsh_status` answers "what am I talking to" — endpoint, plugin version, live model
  selection, delivery policy, sync state, tool-table shape — without probing.

## Verification

```bash
node test/mcp-self-test.mjs            # 11 transport checks, no Harness needed
node test/contracts-test.mjs           # 6 checks: the Harness wire shapes, pinned in one place
node test/authority-test.mjs           # 5 checks: the sandbox ladder, containment, and the cwd clamp
node test/transcript-test.mjs          # 7 checks: transcript windows, cursors, caps and the response budget
node test/questions-test.mjs           # 17 checks: must-reply ids, injected id-only reminders, human stops, answers, deadlines, aborts, deadlocks
node test/work-sync-test.mjs           # 22 checks: the progress-sync engine against a fake Harness
node test/work-sync-plugin-test.mjs    # 5 checks: the sync bundle row's service, messages, switch, disposal
node test/turn-wait-test.mjs          # 2 checks: which turn a queued or steered prompt reports
node test/integration/protocol-and-tools.mjs       # 27 checks: apply(), endpoint file, tools, status, the
                                                   # lazy front door, its authority ceiling, lossless values
node test/integration/sessions-and-identity.mjs    # 17 checks: waiting, whoami, ownership, restrictToOwner
node test/integration/archive-permissions-commands.mjs # 24 checks: archive, permissions, models, commands
node test/integration/transcripts.mjs              # 11 checks: outline/tail/paging, index, search, budget
node test/integration/decisions.mjs                # 20 checks: parked approvals/questions, per-kind answering, must-reply, busyMode
node test/integration/config-and-grouping.mjs      # 32 checks: config route, presets, grouping, delivery, hot reload
node test/mcp-conformance-test.mjs                 # 26 checks: protocol versions, methods, errors, auth
node test/client-half-test.mjs         # 18 checks: the browser half's bundle page, its row page, its route
node test/stdio-bridge-test.mjs        # 4 checks, needs a RUNNING Harness (one real delegated turn)
node test/live-e2e-test.mjs            # 46 checks over HTTP: protocol, resources, all twenty-one tools,
                                       # archive/unarchive, permission presets, commands, error paths,
                                       # 4 real turns (needs a Harness)
```

`npm run check:docs` guards the Markdown instead: every relative link and anchor resolves, and `docs/zh/` keeps the same heading levels, tables, code fences and inline identifiers as `docs/en/`. CI (`.github/workflows/ci.yml`) runs both.

Re-validating on 0.2.1-rc.5 covered the client side too: the composer still accepts this package's `dsh.client` declaration and both the `plugins.row.config` / `plugins.bundle.config` slots, `dsh_status.clientPage.inGraph` is `true`, and the official MCP client (`@modelcontextprotocol/client` 2.2.0 and 2.4.0) handshakes once each — 21 tools, 3 resources, 1 template and `dsh_status` all behave, negotiating `2025-11-25` and echoing `2026-07-28` when asked.

The bridge's schema projection was verified against the Harness's **own** JSON-Schema validator
(extracted from the app bundle): 15 of the 21 raw MCP schemas use `minLength`, a keyword that validator
rejects outright, and all 21 projected schemas — plus canonical values of every shape — are accepted.

Live checks used during development also covered: a real MCP client exchange against the running
Harness, an end-to-end `dsh_run_prompt` → `dsh_continue_session` → `dsh_read_session` flow, permission
presets applied and re-pinned over MCP and folded back out of the transcript, a command executed
without adding a model message, waiting on a detached turn without cancelling it, caller identity
over the header and User-Agent rungs, windowed/outlined transcript reads, detached start + cancel,
and the stdio bridge.

## Releasing

The version lives in three places that move together: `package.json`, `VERSION` in `index.js`, and
the Status section of both READMEs — plus one `CHANGELOG.md` entry. When the number of tests or
documents changes, the counts in `docs/*/internals.md` and the READMEs follow. Only continue once
`npm run verify` is green.

Then push a tag and let the workflow publish:

```bash
git tag v0.23.0
git push origin v0.23.0   # triggers .github/workflows/publish.yml
```

The workflow checks the tag against `package.json`, runs the tests and the documentation guard, then
publishes with npm provenance. The first release uses the `NPM_TOKEN` secret; after that, configure
this repository and `publish.yml` as a trusted publisher on npm, and the workflow switches to OIDC,
with no token stored. A manual release is the same as `npm publish --provenance --access public`.

The package name is also the row name: the two `name` fields in `cordis.patch.yml` must equal
`package.json`'s `name`, which makes a rename a breaking change — an existing profile's dependency
has to move with it, or the rows resolve no module.

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
