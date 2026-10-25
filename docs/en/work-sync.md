# Task-start progress sync

> Part of [DSH MCP Server](../../README.en.md) · [Docs index](../README.md)

Ask peers working in the same workspace what they are doing before editing the same tree.

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
configuration-only there. `dsh_status` reports `sync: { enabled, present, peersAsked, pending, reports }`; each `peersAsked` entry names both sides (`asker`, `peer`, the compatibility `sessionId`, and the `turn` that asked), so a peer questioned by several sub-agents reads differently from one asker re-asking it;
without the row this endpoint runs normally, reports `present: false`, and refuses to save the switch with a
message naming the row to add. `GET /mcp-config` reports the switch itself.
