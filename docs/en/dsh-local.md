# DSH-local tools

> Part of [DSH MCP Server](../../README.en.md) · [Docs index](../README.md)

The same table, callable from inside the Harness — with a ceiling on what a caller may do.


The endpoint's tools are **also** callable from inside the running Harness — no second process, no MCP
client config. On by default; set `exposeToDsh: false` to keep the plugin MCP-only.

## On demand, not all at once

Twenty-one tool schemas are ~19.2 KB (~4.8k tokens) of permanent prompt cost in **every** session, whether
that session ever delegates anything or not. So the default surface is a three-tool front door:

| Front-door tool | Purpose |
|---|---|
| `dsh_mcp_tools` | The catalogue — every published name **with its call signature** — plus one line per tool and `native` when it is already callable. `name` returns that tool's parameter schema, projected for the DSH registry. |
| `dsh_mcp_open` | Register the named tools (**or `all: true`) into *this* session**, so they are callable natively from the next step on. The target is always explicit: an empty or missing list is refused rather than quietly opening all twenty-one. |
| `dsh_mcp_call` | Call one published tool directly, without opening it — for a single call that does not deserve a permanent schema. |

That is ~3.1 KB (~770 tokens) at rest instead of ~19.2 KB, and the rest of the table is paid for only by
sessions that actually use it. `dsh_status` reports the whole shape:
`dshTools: { enabled, mode, registered, published, via }`.

## Knowing without looking

A front door that only says "there is a catalogue" costs the model a step: it calls `dsh_mcp_tools`
before it can call anything, and pays that step again in every new session. So the front door states the
catalogue itself — every published name with its required arguments, inside `dsh_mcp_tools`'s own
description:

> Publishes 21: dsh_run_prompt(prompt), dsh_continue_session(sessionId, prompt), dsh_ask_session(sessionId, question), …

That index is ~1.0 KB (~250 tokens) and turns "send this to session X" into a single call:
`dsh_mcp_call({ tool: "dsh_continue_session", arguments: { sessionId, prompt } })`. Names are forgiving:
a bare `continue_session` resolves, a near miss is refused with the close matches named, `arguments`
accepts a JSON object string, and a refused call ends by naming the `dsh_mcp_tools({ name })` lookup that
fixes it. The index is the whole discovery budget — nothing else is paid until a tool is actually opened.

Two tools whose `required` list is not their whole signature say so in the index —
`dsh_run_command(sessionId, line|command)` and `dsh_answer_request(requestId, decision|answers)` — because a
signature a model would be refused for following is worse than no signature at all.

## Adding tools mid-session

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

## The authority ceiling

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
