# Configuration

> Part of [DSH MCP Server](../../README.en.md) · [Docs index](../README.md)

Every switch on the Plugins page, and every field the bundle row accepts.

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

## Bundle row fields

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
| `exposeToDshMode` | `lazy` | `lazy` registers the three-tool front door, whose `dsh_mcp_tools` description already carries every published name and its required arguments (the result rows are name/purpose/native only), and lets a session open what it needs; `full` registers all twenty-one at load (permanent schema cost). An unknown value fails at load. |
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
