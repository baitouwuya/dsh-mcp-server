# Changelog

Notable changes to `dsh-mcp-btwy`. Older releases are listed on
[GitHub Releases](https://github.com/baitouwuya/dsh-mcp-server/releases).

## [1.2.0] - 2026-11-10

### Added

- **`dsh_read_session` can read the raw log** — contributed by @SAXEM1997 in
  [#3](https://github.com/baitouwuya/dsh-mcp-server/pull/3). `mode: "events"` returns `events[]` instead of
  folded messages, so `tool/call`, `tool/result`, and `permission/preset` rows are readable: a caller that
  audits what a run actually did no longer loses roughly two thirds of the log. The window arithmetic is the
  message modes' own — `limit`, `afterSeq` + `window.nextAfterSeq`, `reachedEnd` — and `types` narrows by
  event type *before* the window is cut, so `matchedEvents` counts what the filter matched. Rows carry
  `truncated`/`chars` like message rows, and the whole response stays inside the ~512K-character budget.
- Raw payloads travel verbatim, which is the point and the caveat: a `tool/call` argument can hold a secret
  the folded prose view hides. The endpoint token already implies execution (`dsh_run_prompt` can run a
  shell), so the mode ships documented rather than gated.

### Fixed

- Review follow-ups on the contributed mode: the budget now charges the serialized event payload as well as
  the row text (a 2 MB inline image used to slip through with `truncatedByBudget: false`); the window's first
  row is always returned, truncated to what still fits, so `nextAfterSeq` advances and a single oversized
  event can no longer yield an empty page that pages forever; `maxChars` caps one event row like one message;
  and an unused import plus the missing bilingual docs were cleaned up.

### Checks

- 302 offline checks (5 new in `test/transcript-test.mjs` with the mode, 3 more for the budget/progress/
  `maxChars` fixes), plus the live HTTP and stdio suites.

## [1.1.1] - 2026-11-10

### Fixed

- **`dsh_list_sessions` stops paying for what a page does not use** (issue #2). Two costs sat in the
  default path: the controller summarizes every session with its projections to sort by last activity,
  and every returned row resolved its title through the Host. On this machine's 890-session library a
  200-row page took **5.4 s** — almost all of it title lookups (≈26 ms/row) — while the header-only
  catalogue answered in milliseconds.
  - `titles: false` skips the per-row title lookup; rows carry no `title`.
  - `order: "created"` reads `sessionQuery.listSessions()` (detached headers, newest created first) instead
    of the projection pass. Rows then carry `createdAt` and no `updatedAt`; `running` still comes from the
    live agent registry. A deployment that mounts no `sessionQuery` falls back to activity order and the
    payload says `orderFallback: true`.
  - Both defaults are unchanged (`order: "activity"`, `titles: true`), so existing callers see the same
    rows; a collector can now walk a whole library without a second per page.
- The controller's cancellation signal is passed where the Host expects it (`controller.list(signal)`
  rather than `controller.list({}, signal)`), so a caller that hangs up now cancels the listing too.

### Checks

- 294 offline checks (3 new in `test/integration/sessions-and-identity.mjs`: the header catalogue skips
  the projection pass and titles, the default keeps activity order, and the fallback is reported).

## [1.1.0] - 2026-11-09

### Added

- **Scheduled tasks over MCP — the headline of this minor release.** Five tools over the Host `schedule`
  service, the same tasks the Web Automation page and the `schedule_*` agent tools manage:
  `dsh_schedule_create` (an RRULE — one `DTSTART` line plus one `RRULE` line — or the full `timing`
  selector), `dsh_schedule_list`, `dsh_schedule_view`, `dsh_schedule_edit` (update, pause, resume, delete,
  with `expectedUpdatedAt` for a conditional write) and `dsh_schedule_run` (deliver once now without moving
  the occurrence). The destination is an existing session (`sessionId`), the calling session
  (`this_session`), one reused session (`new_once`), or a new session per delivery (`new`).
- The full `timing` selector takes exactly `kind` plus its snake_case selector, nested for
  `daily`/`weekly`/`cron`: `{kind:"daily",daily:{time,time_zone}}`,
  `{kind:"cron",cron:{expression,time_zone}}`, `{kind:"weekly",weekly:{time,time_zone,weekdays}}`,
  `{kind:"after",after_seconds}`, `{kind:"every",every_seconds}`, `{kind:"at",at}`,
  `{kind:"rrule",rrule}`.
- Every task is returned with `scheduledAtLocal` in its own zone — the explicit `time_zone` of a
  cron/daily/weekly rule, or the `TZID` of an RRULE; elapsed and absolute rules display in UTC, as the
  Harness agent tools do — because the stored instant is UTC and the display zone is what a person checks.
- The task catalogue is Host-wide: `dsh_schedule_list` returns tasks other sessions created, and
  `dsh_schedule_edit` changes any of them by id; only the destination names a session. `this_session` needs
  a calling DSH session, so an external MCP client is refused with a pointer to `sessionId`/`new_once`/`new`.
- Harness input failures keep their code (`invalid_rule`, `invalid_time_zone`, `not_future`,
  `frequency_too_high`, `subagent_session`, …) in the model-readable message, and a deployment without the
  `schedule` service says so instead of failing silently.

### Compatibility

- Additive only, so a minor release per the [status section](README.md#状态): the original 21 tool
  names, their schemas, the resource URIs, the configuration fields and the MCP protocol surface are
  unchanged; `dsh_status.toolNames` grows from 21 to 26.

### Checks

- 291 offline checks (14 new in `test/integration/schedule-tools.mjs`), plus the live HTTP and stdio suites.
  Verified against a live Host: all seven timing selectors create, pause/resume works, a stale
  `expectedUpdatedAt` returns `schedule_conflict`, a malformed rule returns `invalid_rule`, an external
  caller is refused for `this_session`, and `dsh_schedule_run` delivers into the reserved session.

### Note

- 1.0.5 and 1.0.6 were published earlier the same day to unblock that rollout (the feature, then a
  documentation correction to the timing shapes). This version carries the same code with consolidated
  notes; upgrade to 1.1.0.

## [1.0.6] - 2026-11-09

### Fixed

- **The documented `timing` shapes match the Host contract.** The full-selector form takes exactly
  `kind` plus its snake_case selector, nested for `daily`/`weekly`/`cron`:
  `{kind:"daily",daily:{time,time_zone}}`, `{kind:"cron",cron:{expression,time_zone}}`,
  `{kind:"weekly",weekly:{time,time_zone,weekdays}}`, `{kind:"after",after_seconds}`,
  `{kind:"every",every_seconds}`, `{kind:"at",at}`, `{kind:"rrule",rrule}`. The tool description and the
  bilingual docs had shown a flat camelCase form that the Host refuses; the plugin never translated it, so
  only the documentation was wrong. Verified against a live Host: all seven selectors create, and the flat
  form is refused with `invalid_rule`.
- The integration harness now applies the same validation, so a documented shape the Host would reject
  fails the suite instead of passing.

## [1.0.5] - 2026-11-09

### Added

- **Scheduled tasks over MCP.** Five tools manage the same Host tasks the Web Automation page and the
  `schedule_*` agent tools use: `dsh_schedule_create` (an RRULE — one `DTSTART` line plus one `RRULE` line
  — or the full `timing` selector: `after`, `at`, `every`, `daily`, `weekly`, `cron`, `rrule`),
  `dsh_schedule_list`, `dsh_schedule_view`, `dsh_schedule_edit` (update, pause, resume, delete, with
  `expectedUpdatedAt` for a conditional write) and `dsh_schedule_run` (deliver once now without moving the
  occurrence). The destination is an existing session (`sessionId`), the calling session (`this_session`),
  one reused session (`new_once`), or a new session per delivery (`new`).
- Every task is returned with `scheduledAtLocal` in its own zone — the explicit `timeZone` of a
  cron/daily/weekly rule, or the `TZID` of an RRULE — because the stored instant is UTC and the display zone
  is what a person checks.
- The task catalogue is Host-wide: `dsh_schedule_list` returns tasks other sessions created, and
  `dsh_schedule_edit` changes any of them by id; only the destination names a session. `this_session` needs
  a calling DSH session, so an external MCP client is refused with a pointer to `sessionId`/`new_once`/`new`.
- Harness input failures keep their code (`invalid_rule`, `invalid_time_zone`, `not_future`,
  `frequency_too_high`, `subagent_session`, …) in the model-readable message, and a deployment without the
  `schedule` service says so instead of failing silently.
- The published table grows to 26 tools, so `dsh_status.toolNames` and the DSH-facing catalogue follow;
  the three-tool front door's index stays under its 3.5 KB ceiling.

### Changed

- The Client half's panel copy advertises the current published count.

### Checks

- 291 offline checks (14 new in `test/integration/schedule-tools.mjs`), plus the live HTTP and stdio suites.

## [1.0.4] - 2026-11-06

### Added

- **A delivered message says who sent it.** Every internal message this package hands a session already carried a
  durable `source` naming the sender — a prompted session (`dsh-mcp-server`), a work-sync notice or report
  (`dsh-work-sync`, whose `source.sessionId` is the asking session). The Chat renders only the body, so those
  rows read as if the person typed them. The Client half now registers one line in
  `conversation.chat.user.before` — above the bubble, inside the same right-aligned row — naming the sending
  Session (`displayTitle`, then the subagent label, then a short id) and the kind of delivery; clicking it opens
  that Session. The same line covers the Harness's own relays (`agent-message`, `team-message`,
  `subagent-settled`, which name the sender on `source.senderSessionId`).
- What this endpoint delivers renders as a **bubble**, not a wake card. DSH draws a `turn-trigger` card for any
  message that starts a turn on its own, and picks its title from the source family; this endpoint's kinds had no
  entry, so a delivered prompt read "a request started this turn". The Client half shadows that keyed cell (same
  key, lower priority) and renders `dsh-mcp-server` and `dsh-work-sync` deliveries the way the person reads them
  — right-aligned bubble, sending Session above it, one click to open it — while every other wake family keeps
  the shipped card, its clock and its disclosure.
- The bubble is a switch, not a decree. The bundle page offers "内部消息的呈现": **气泡** (default) or **提醒卡片**,
  the shipped wake card. It is stored on this row as `internalMessageStyle` (`bubble` | `card`), validated like
  every other setting, and read once per activation — saving it reloads this half, so no stale value survives.
- A delivered bubble reuses the Harness's own UI: `UserMessageBubble` for the chassis and `MarkdownText` for the
  body, both resolved from the primitives the page already seeds, with a plain-text fallback when Markdown
  rendering fails. A look-alike bubble that drifts from the theme is worse than no bubble.
- A delivered bubble folds itself when it is long. A prompt handed to a session can run to many screens and used to
  push every following turn out of view: past 12 lines or 700 characters the bubble clamps to a fixed height
  (fading at the edge) behind "Show all (N lines)", which expands it and folds it back.
- The chain entry carries a selector that declines every row naming no sender, so an ordinary prompt — and a
  delivery made on behalf of an external MCP client, which has no Session id — renders exactly as before.

### Changed

- `dsh.client.inject` now lists `@deepseek-ai/dsh-client-ui-chat`, the module that declares the slot this entry
  renders into.
- 277 offline checks (32 in the client half, fourteen of them new), 46 live MCP checks, 4 stdio bridge checks.

## [1.0.3] - 2026-11-05

### Changed

- Re-validated against **DSH 0.2.2-rc.1** (Cordis 4.1.0): 263 offline checks, 46 live MCP checks, 4 stdio bridge
  checks. Nothing in the upgrade required a code change — the composer still accepts this package's `dsh.client`
  declaration (`dsh_status.clientPage.inGraph` is `true`), the composition primitives (`ctx.effect`,
  `ctx.inject`, `ctx.on`, `ctx.webServer.register`) and the `agents` / `sessionController` / `sessionQuery` /
  `permissionPresets` / `commands` / `workspaceRegistry` services kept their contracts, and both official MCP
  SDK builds (bundled 2.2.0 and current 2.4.0) handshake against the live endpoint.
- Understands DSH 0.2.2's permission vocabulary. The new reserved `auto` preset (per-call review in a
  `danger-full-access` sandbox, present only while its integration is composed) is clamped by the sandbox it
  grants rather than by its name, and a session an internal caller starts no longer risks inheriting it as the
  "widest preset at this rung". `custom` — the derived reading when a session's knobs match no preset — is
  never granted as a name.

### Notes

- `DSH_MCP_URL` is published into the Host process, not into model-facing shells: DSH's `dsh-shell-env` builds a
  curated `DSH_*` namespace per shell call, so only a `!!js` patch expression (or anything else running
  in-process) sees the URL.
- `dsh_list_permission_presets` reports whatever the deployment composes, so a Host with the review integration
  live lists four presets instead of three.

## [1.0.2] - 2026-10-30

### Fixed

- A tool call that blocks longer than a client's own response timeout no longer looks like a dropped
  connection. The HTTP route used to hold a silent `application/json` reply for the whole call — no status
  line, no headers — so an undici-based client (Node's `fetch`, hence the stdio bridge, Claude Code, Codex)
  gave up at its 300 s `headersTimeout` and reported `fetch failed`, while `dsh_read_session` kept working.
  A reply still pending after 10 s now switches to `text/event-stream`: headers immediately, a
  `: keep-alive` comment every 15 s, then the JSON-RPC response as the closing `message` event. Fast calls
  keep the plain JSON body, and a client whose `Accept` does not name `text/event-stream` is never streamed to.
- The stdio bridge parses that event stream — it would otherwise fail every long wait with a JSON parse
  error — and re-reads `$DSH_HOME/mcp/dsh-mcp-endpoint.json` before each request, so a Harness that
  restarted on a new port is picked up without restarting the harness that launched it.

### Notes

- Reproduced before the fix: `dsh_wait_session` with `timeoutMs: 420000` through the bridge returned
  `-32000` "endpoint is unavailable: fetch failed" at 300.9 s, while `dsh_read_session` answered in ~0.7 s
  throughout and `curl` (no header timeout of its own) stayed connected. Old transcripts show the same
  signature: every failing wait took 304 s and asked for more than 300 s, every passing one finished within 244 s.
- DSH's own MCP client caps each tool call at the row's `toolCallTimeoutMs` (60 s by default). That ceiling is
  client-side and a server cannot lift it: raise it for long waits, or wait in shorter installments.

## [1.0.1] - 2026-10-30

### Changed

- Re-validated against **DSH 0.2.1-rc.5** (Cordis 4.0.5): 250 offline checks, 46 live MCP checks, 4 stdio
  bridge checks, and a handshake from the official MCP client (`@modelcontextprotocol/client` 2.2.0 and
  2.4.0) against the running endpoint. rc.5's stricter client composition still accepts this package's
  `dsh.client` declaration, and the endpoint still advertises 21 tools, 3 resources and 1 template.
- The plugin publishes its endpoint URL as `DSH_MCP_URL` for in-process consumers. Newer Harnesses bind an
  OS-assigned Web port, so a profile row that points DSH's own MCP client back at this endpoint can no
  longer hardcode one; the `selfcheck` bundle follows the environment variable instead.

### Notes

- The `dsh-mcp-selfcheck` row is disabled in the desktop profile: with a dynamic port it could only dial a
  dead URL, and the plugin's own front door already gives sessions the same tools at a fraction of the
  prompt cost. Pin the Web port to bring the native `mcp__dsh__*` shape back.

## [1.0.0] - 2026-10-27

### Changed

- First stable release. The package is `dsh-mcp-btwy`, installable from npm, with two bundle rows
  (`dsh-mcp-btwy`, `dsh-mcp-btwy/work-sync`), 21 MCP tools and 3 resources documented under `docs/`.
  A profile that depended on the profile-local `@local/dsh-mcp-server` must switch its dependency.
- The READMEs name the package in the title and link the npm page; 0.23.1 carried that change.

### Notes

- 1.0.0 marks the point where the tool names, resource URIs, configuration fields and the MCP protocol
  surface are treated as stable: breaking one of them takes a major release.

## [0.23.1] - 2026-10-27

### Changed

- The README title names the published package — `# DSH MCP Server (dsh-mcp-btwy)` — and an npm badge
  links the registry page, so the GitHub page, the npm page and the Plugins page agree on one name.

## [0.23.0] - 2026-10-27

### Changed

- The package is now `dsh-mcp-btwy` and is published to npm, so the Plugins page's **Add plugin**
  field and `dsh plugin add dsh-mcp-btwy` install it without cloning the repository. The bundle rows
  in `cordis.patch.yml` follow the package name, as the loader resolves each row by module name.
- Both READMEs lead with the npm install and keep the source install as the fallback, and they now
  state the security boundary up front: loopback binding, the bearer token with no query-string form,
  `restrictToOwner`, and what `answerApprovals` hands over.
- `publishConfig.access` is `public`, and `.github/workflows/publish.yml` publishes a tag through
  npm trusted publishing (or a `NPM_TOKEN` secret before that is configured), with provenance.

### Migration

- A profile that depended on `@local/dsh-mcp-server` (Git or link) must switch the dependency to
  `dsh-mcp-btwy`: the patch row names changed with the package, so the old dependency no longer
  matches the rows the bundle inserts.

## [0.22.0] - 2026-10-27

### Added

- `answerApprovals` and `answerQuestions` split the old `answerUserRequests`
  umbrella: a question is a normal decision, while an approval grants a sandbox
  escalation, so a deployment can now enable either one. The umbrella still sets
  both defaults and an explicit per-kind value wins.
- The Plugins page panel offers a switch for each kind, `dsh_status.answering`
  reports the effective pair (and `answerOwnedSessionsOnly`), and `/mcp-config`
  accepts both fields.
- Two integration checks cover hook registration and the route patch; the client
  half renders and operates both switches (249 offline checks).

## [0.21.0] - 2026-10-26

### Added

- Configuration presets: `preset: delegate | strict | observer` fills only the
  fields the row leaves unset, and an explicit field always wins. `delegate` is
  the default; `strict` isolates callers (`restrictToOwner`, queued busy prompts)
  and stays out of the answerer race; `observer` keeps the endpoint MCP-only,
  out of the sidebar, and answer-free. The `/mcp-config` route accepts the patch,
  and `dsh_status` reports `configPreset`.
- Five integration checks cover preset resolution, explicit overrides, the load
  error for an unknown name, and the configuration-route patch (247 offline checks).

### Fixed

- The live end-to-end suite expected the eighteen-tool table from before
  must-reply questions, so it failed on every run since 0.20.2. It now derives
  the expected names from `lib/capabilities/definitions.js` and validates the
  deployment's own busy-delivery setting instead of hard-coding `setting`.

## [0.20.5] - 2026-10-26

### Added

- `test/mcp-conformance-test.mjs`: 26 protocol checks against the real route —
  revision negotiation, capabilities, tools/resources methods, JSON-RPC error
  envelopes, authentication, and stateless transport.
- `docs/en/protocol.md` / `docs/zh/protocol.md`: the supported MCP revisions,
  methods, notifications, error codes, authentication, and explicit non-support.

### Changed

- `test/plugin-integration-test.mjs` (1936 lines, 123 checks) split into
  `test/helpers/plugin-harness.mjs` and six domain files under
  `test/integration/`; each file runs on its own fake Harness.
- 242 offline checks (was 216).

### Fixed

- `index.js` reported the stale version `0.20.3` through `initialize`,
  `serverInfo`, and `dsh_status`; the constant now follows `package.json`.

## [0.20.4] - 2026-10-26

### Added

- CI workflow running the offline suite and a documentation guard on every push.
- `scripts/check-docs.mjs` (`npm run check:docs`): every relative link and anchor
  resolves, and `docs/zh/` keeps the same headings, tables, fences, and inline
  identifiers as `docs/en/`.

### Changed

- `lib/dsh-capabilities.js` split from 2920 to 2040 lines: the tool/resource
  catalogue moved to `lib/capabilities/definitions.js` and the pending-decision
  fold plus parking hooks to `lib/capabilities/requests.js`.
- `dsh_status.sync.peersAsked` now names both sides (`asker`, `peer`, plus the
  compatibility `sessionId` and the `turn` that asked); a replayed
  `turn/start` no longer spends a second round.
- README restructured into progressive disclosure: a Chinese entry README
  (default), an English mirror, and eight topic documents per language under
  `docs/`.

## [0.20.3] - 2026-10-25

### Fixed

- Deliveries made from a `session/event` listener (must-reply reminder
  injections and withdrawals, work-sync reports and timeout lines) now yield one
  microtask before appending, so they no longer hit DSH's
  "session append cannot reenter" rejection inside the session commit.

## [0.20.2] - 2026-10-23

### Fixed

- Must-reply reminders ride assistant messages and tool results as well, and a
  refused injection explains its reason in `questions.activity.lastError`.

## [0.20.1] - 2026-10-23

### Fixed

- Reminders are injected into calls the target already makes (the Harness's
  no-wake `inject` path) instead of waking it with a new turn.
- A human stop settles an open question with `status: "stopped"`; a session
  stopped by a person is never woken by a question, and asking it again is
  refused until it resumes.

## [0.20.0] - 2026-10-23

### Added

- Must-reply questions between sessions: `dsh_ask_session` blocks the asking
  turn, `dsh_answer_question` settles it by id, and `dsh_get_question` re-reads
  the question when only the id was reminded.