# Changelog

Notable changes to `dsh-mcp-btwy`. Older releases are listed on
[GitHub Releases](https://github.com/baitouwuya/dsh-mcp-server/releases).

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
