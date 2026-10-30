# DSH MCP Server (dsh-mcp-btwy)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/baitouwuya/dsh-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/baitouwuya/dsh-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-mcp-btwy.svg)](https://www.npmjs.com/package/dsh-mcp-btwy)

**English** · [简体中文](README.md)

A DeepSeek Harness (DSH) plugin that publishes a **Model Context Protocol (MCP)** server from the running
Harness host, so other agent harnesses — Claude Code, Cursor, Codex, another DSH, any MCP client — can call
DSH: start sessions, drive turns, wait for them, read transcripts, and cancel work.

The plugin is a Host-only bundle with **zero dependencies**. Every request is attributed to the calling
agent and every session is recorded against its creator, so several harnesses can share one endpoint and
still ask "which sessions are mine?". The same tools are also registered into the local Harness, where they
are clamped to the calling session's own authority.

```
other harness ──MCP (Streamable HTTP or stdio)──> DSH MCP Server ──> DSH services
                                                                     sessionController / sessionQuery / tools
```

## What it can do

- **Drive DSH from any MCP client.** `dsh_run_prompt` starts a session and returns its `sessionId`;
  `dsh_continue_session` keeps its context and workspace; `dsh_wait_session` waits without cancelling;
  `dsh_cancel_session` stops a turn and keeps the inbox. Works over Streamable HTTP or the stdio bridge.
- **Long calls outlive a client's timeouts.** A call still running after 10 s answers as an event stream —
  headers at once, a `: keep-alive` comment every 15 s, then the JSON-RPC response — so a
  `dsh_wait_session` lasting minutes is not cut off by a client's 300 s response-header limit.
- **Read and search without dumping.** `dsh_list_sessions` pages the index, `dsh_search_sessions`
  returns bounded snippets, and `dsh_read_session` reads tail/head/outline windows with cursors, caps and
  a response budget. Every payload reports what it did not return.
- **Share one endpoint between harnesses.** Caller identity is resolved from a header, `clientInfo` or
  User-Agent; sessions are recorded against their owner; `restrictToOwner` confines each caller to its own.
- **See the decisions the model never sees.** `dsh_list_requests` reports approvals and unanswered user
  questions with tool, reason and call id; with `answerApprovals` / `answerQuestions` (or the legacy
  `answerUserRequests`), `dsh_answer_request` settles them racing the GUI.
- **Ask a question the target must answer.** `dsh_ask_session` blocks the asking turn until the addressed
  session answers; the question gets an id, reminders ride the target's own calls (never a wake-up), and a
  human stop settles it without waking anyone.
- **Keep same-workspace peers from colliding.** Task-start progress sync asks other top-level agents in the
  same workspace what they are doing and which files they are touching, as its own `dsh-work-sync` row.
- **Call the same tools from inside DSH.** The default lazy surface is a three-tool front door
  (`dsh_mcp_tools`, `dsh_mcp_open`, `dsh_mcp_call`) for ~770 tokens at rest instead of ~4.8k; `full`
  registers all twenty-one. Internal calls stay inside the caller's sandbox and workspace.
- **Point the person at the work.** Sessions this endpoint starts join the sidebar project their directory
  already has, and `dsh_open_session` asks the open Web GUI to select one.
- **Configure it from the Plugins page, or by preset.** On/off, lazy vs. full surface, sidebar grouping,
  busy delivery and progress sync are switches on the bundle's own page, saved through the profile editor;
  a deployment can also write `preset: delegate | strict | observer` in the row, which fills only the fields it leaves unset.

## Quick start

1. **Install the bundle into a DSH profile** (npm package `dsh-mcp-btwy`, zero dependencies):

   ```bash
   # Plugins page -> Add plugin, then paste the package name:
   dsh-mcp-btwy
   # or from the command line (the profile name is the one you use; the desktop app's is desktop):
   dsh plugin --profile desktop add dsh-mcp-btwy
   ```

   A source install (development or offline) works too: `git clone`, then paste the checkout path in
   Add plugin, or `plugin_manager install_bundle --target /path/to/dsh-mcp-server`.

2. **Read the connection details** the plugin publishes at mode 0600:

   ```
   $DSH_HOME/mcp/dsh-mcp-endpoint.json    # { url, token, stdioBridge, tools }
   ```

3. **Point a client at the endpoint** (Streamable HTTP shown; stdio and other clients are in the
   [getting-started guide](docs/en/getting-started.md)):

   ```jsonc
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

4. **Call it.** Start a session, then continue it:

   ```jsonc
   dsh_run_prompt({ "prompt": "summarize README.md", "cwd": "/path/to/repo" })
   // → { "sessionId": "session-…", "text": "…" }

   dsh_continue_session({ "sessionId": "session-…", "prompt": "now list the TODOs" })
   ```

## Security boundary

The point of this plugin is to let **another harness drive this DSH instance**, so the boundary is part
of the design rather than an option:

- The endpoint binds the loopback address (`127.0.0.1`) by default; exposing it means setting `host`
  explicitly, which you usually should not do.
- Every request needs the bearer token written to `$DSH_HOME/mcp/dsh-mcp-endpoint.json` (mode 0600).
  A token in the query string is refused, because it would land in proxy logs.
- `restrictToOwner` keeps every caller inside the sessions it created; guest calls across sessions are refused.
- Answering approvals (`answerApprovals`) hands over the consent that grants sandbox escalation; leave it
  off unless you mean it.

Confirm you trust the harness that will call this endpoint before installing: it runs with your user's authority.

## Documentation

| Document | What is inside |
|---|---|
| [Getting started](docs/en/getting-started.md) | Install, endpoint file and token, HTTP/stdio/DSH-as-client configs, the self-check bundle. |
| [Tools and resources](docs/en/tools.md) | All 21 tools, the three resources, progressive reads, pending decisions. |
| [Protocol support](docs/en/protocol.md) | Supported MCP revisions, methods, capabilities, notifications, error codes, authentication, session headers, and unsupported features. |
| [Sessions and delivery](docs/en/sessions.md) | Caller identity and ownership, waiting, sidebar grouping, queue/steer, GUI open. |
| [DSH-local tools](docs/en/dsh-local.md) | The in-Harness surface, the lazy front door, and the authority ceiling. |
| [Must-reply questions](docs/en/questions.md) | `dsh_ask_session` / `dsh_answer_question` / `dsh_get_question`, reminders, human stops, deadlocks. |
| [Progress sync](docs/en/work-sync.md) | Task-start peer sync, its own bundle row, and its knobs. |
| [Configuration](docs/en/configuration.md) | Every Plugins-page switch and every `cordis.patch.yml` field. |
| [Internals](docs/en/internals.md) | Module map, DSH compatibility, model experience, verification, limitations. |

The [docs index](docs/README.md) lists both languages.

## Status

Version **1.0.2**, checked against **DSH 0.2.1-rc.5** (Cordis 4.0.5): 21 MCP tools, 2 resources, 1 resource
template, 258 offline checks plus live HTTP and stdio suites. Host-only, zero dependencies, MIT.
DSH 0.2.1-rc.5 ships its own MCP client, so besides this plugin's built-in front door the Harness can
connect to this endpoint directly — see
[Connecting DSH's own MCP client](docs/en/dsh-local.md#connecting-dshs-own-mcp-client).
Since 1.0.0 the tool names, resource URIs, configuration fields and the MCP protocol surface follow
semantic versioning: breaking one of them takes a major release.
The plugin imports no DSH package, so compatibility is a question of service contracts rather than a version
pin — see [Internals](docs/en/internals.md#dsh-compatibility). Per-version changes are in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
