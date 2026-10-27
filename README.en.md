# DSH MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/baitouwuya/dsh-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/baitouwuya/dsh-mcp-server/actions/workflows/ci.yml)

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

1. **Install the bundle** into a DSH profile:

   ```bash
   git clone https://github.com/baitouwuya/dsh-mcp-server.git
   # from the Harness UI / plugin_manager:
   plugin_manager install_bundle --target /path/to/dsh-mcp-server
   ```

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

Version **0.22.0**, checked against **DSH 0.2.1-rc.3** (Cordis 4.0.5): 21 MCP tools, 2 resources, 1 resource
template, 249 offline checks plus live HTTP and stdio suites. Host-only, zero dependencies, MIT.
The plugin imports no DSH package, so compatibility is a question of service contracts rather than a version
pin — see [Internals](docs/en/internals.md#dsh-compatibility). Per-version changes are in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
