/**
 * The static MCP catalogue: the tools this endpoint advertises and the
 * `dsh://` resources it exposes.
 *
 * Tool schemas are pure data, kept out of `lib/dsh-capabilities.js` so the
 * contract a caller sees can be read without the live-service plumbing.
 * The two resource helpers return a fresh descriptor list per listing.
 *
 * @module dsh-mcp-server/capabilities/definitions
 */

/** Every tool this endpoint advertises, in listing order. */
export const TOOL_DEFINITIONS = [
  {
    name: 'dsh_run_prompt',
    title: 'Run a prompt in DeepSeek Harness',
    description: [
      'Start a NEW DeepSeek Harness session and run one prompt in it, on the machine that runs the Harness.',
      'The DSH agent has its full tool set (filesystem, shell, web, subagents) and works inside `cwd`.',
      'By default the call waits for the turn to end and returns the assistant\'s final text plus the new',
      '`sessionId`; pass `wait: false` to return as soon as the turn is admitted and poll with',
      '`dsh_read_session`. Use this for work you want to delegate to the Harness; use',
      '`dsh_continue_session` for follow-ups so the session context is reused.',
      'Optional `agentPreset`, `permissionPreset`, and `model` select how the new session is composed.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        fileIds: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'File ids from `dsh_prepare_upload`, carried into the message as image parts in this order.',
        },
        prompt: { type: 'string', minLength: 1, description: 'The user message to send to the new DSH session.' },
        cwd: {
          type: 'string',
          description: 'Absolute working directory for the new session. Defaults to the Harness default workspace.',
        },
        agentPreset: { type: 'string', description: 'Optional DSH agent preset id for the new session.' },
        permissionPreset: {
          type: 'string',
          description: 'Optional permission preset (sandbox mode + approval policy) applied to the new session before its first turn. List options with dsh_list_permission_presets.',
        },
        model: {
          type: 'string',
          description: 'Optional model override as "provider/model" (for example "deepseek-official/deepseek-v4.1-flash-anthropic").',
        },
        reasoningEffort: { type: 'string', description: 'Optional reasoning effort for an overridden model.' },
        wait: { type: 'boolean', description: 'Wait for the turn to finish (default true).' },
        timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds when waiting (default 1800000).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_continue_session',
    title: 'Continue a DeepSeek Harness session',
    description: [
      'Send one prompt to an EXISTING DeepSeek Harness session (resuming it if it is not live) and return',
      'the assistant\'s final text. Use the `sessionId` returned by dsh_run_prompt or dsh_list_sessions',
      'so the Harness keeps the session\'s context and workspace. `permissionPreset` re-pins the',
      'session\'s sandbox mode and approval policy before this prompt is admitted.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to continue.' },
        prompt: { type: 'string', minLength: 1, description: 'The user message to send.' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: '"queue" waits for the current turn and keeps the message for the next one; "steer" injects it mid-turn at the next step. Omit it to follow this deployment\u2019s own busy-Enter setting (ui-conversation.busyEnter), which is what the Web composer obeys.',
        },
        permissionPreset: {
          type: 'string',
          description: 'Optional permission preset (sandbox mode + approval policy) applied to the session before this prompt. List options with dsh_list_permission_presets.',
        },
        model: { type: 'string', description: 'Optional model override as "provider/model".' },
        reasoningEffort: { type: 'string', description: 'Optional reasoning effort for an overridden model.' },
        wait: { type: 'boolean', description: 'Wait for the turn to finish (default true).' },
        timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds when waiting (default 1800000).' },
      },
      required: ['sessionId', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_ask_session',
    title: 'Ask a DSH session a question it must answer',
    description: [
      'Ask ONE DSH session a question and wait for its answer. The question gets an id (q-...),',
      'and this call does not return before the answer: the asking turn cannot end without one.',
      'Only the addressed session may answer, with dsh_answer_question. While it stays open, the',
      'reminder (id only, never the question again) is injected into the calls the target already',
      'makes; it is never sent as a turn opener, and a session stopped by a person is not woken.',
      'Omit timeoutMs to wait until answered, cancelled, or stopped.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session that must answer.' },
        question: { type: 'string', minLength: 1, description: 'The question to ask; it is delivered once, in full.' },
        timeoutMs: {
          type: 'integer',
          description: 'Optional deadline in milliseconds; 0 (the default) waits until answered or cancelled.',
        },
      },
      required: ['sessionId', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_answer_question',
    title: 'Answer a must-reply question',
    description: [
      'Answer a must-reply question by id. Only the DSH session the question was addressed to may',
      'answer it: the waiting dsh_ask_session call then returns this answer and the asking turn',
      'continues. Call dsh_get_question first when the reminder no longer shows the question text.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'The question id from the reminder or from dsh_ask_session.' },
        answer: { type: 'string', minLength: 1, description: 'The answer text the asking session receives.' },
      },
      required: ['id', 'answer'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_get_question',
    title: 'Read a must-reply question by id',
    description: [
      'Read one must-reply question by id: the original question, who asked it, when, how many',
      'reminders were sent, and the answer once it exists. A reminder carries only the id, so this',
      'is how the addressed session reads the question again.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'The question id from the reminder.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_commands',
    title: 'List DeepSeek Harness commands',
    description: [
      'List the slash commands the session\'s agent can currently run: global commands plus whatever the',
      'agent\'s preset composes. Availability is per agent preset, so a command such as `/compact` only',
      'exists when that session\'s preset provides it.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session whose commands should be listed.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_run_command',
    title: 'Run a DeepSeek Harness command',
    // `required: ['sessionId']` cannot say "line or command", so the DSH
    // front-door index renders this instead of a signature that is refused.
    signature: 'dsh_run_command(sessionId, line|command)',
    description: [
      'Run one slash command in an EXISTING session and return its settled outcome. The command executes',
      'immediately without sending a model turn — for example `/compact` compacts older history and',
      '`/permission <preset>` switches the sandbox/approval preset. Commands resolve for that session\'s',
      'agent, so list them first with `dsh_list_commands`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session the command runs in.' },
        line: {
          type: 'string',
          description: 'Complete command line, e.g. "/compact" or "/permission danger-full-access". Use either "line" or "command".',
        },
        command: {
          type: 'string',
          description: 'Command name with or without its leading slash, e.g. "compact" or "/compact".',
        },
        args: { type: 'string', description: 'Optional trailing input appended to "command".' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedule_create',
    title: 'Create a scheduled task in DeepSeek Harness',
    // `required` cannot say "rrule or timing", so the front-door index shows
    // this signature instead of a required list that would read as both.
    signature: 'dsh_schedule_create(title, prompt, rrule|timing, target?)',
    description: [
      'Create one Host scheduled task: at each occurrence of its recurrence rule, `prompt` is delivered to the',
      'target as a message from the user. Timing is either `rrule` (one DTSTART line and one RRULE line, the',
      'same RFC 5545 subset the Harness agent tools take) or `timing` (the full selector: after, at, every,',
      'daily, weekly, cron, rrule). The target is `this_session` (the calling DSH session, refused to an',
      'external MCP caller), `new_once` (one session created at the first delivery and reused), or `new` (a',
      'fresh session per delivery); `sessionId` instead delivers to an existing session. The result carries the',
      'task id and the next occurrence in `scheduledAt` (UTC) and `scheduledAtLocal`. Tasks survive restarts,',
      'but the Host must be running to deliver them, and after downtime only the latest missed occurrence is sent.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Task name of at most 120 characters in the user language: action plus object. Omit timing, status, ids, and bracketed suffixes.',
        },
        prompt: { type: 'string', minLength: 1, description: 'Instruction delivered to the target at each occurrence.' },
        rrule: {
          type: 'string',
          minLength: 1,
          description: 'Recurrence as one DTSTART line, a newline, and one RRULE line. DTSTART ends in Z for UTC or carries TZID with an IANA zone. Use either "rrule" or "timing".',
        },
        timing: {
          type: 'object',
          description: 'Full timing selector, exactly one of: {kind:"after",after_seconds} | {kind:"at",at} | {kind:"every",every_seconds} | {kind:"daily",daily:{time,time_zone}} | {kind:"weekly",weekly:{time,time_zone,weekdays}} | {kind:"cron",cron:{expression,time_zone}} | {kind:"rrule",rrule}. Keys are snake_case and the daily/weekly/cron selector is nested, exactly as the Harness schedule service takes it. Use either "rrule" or "timing".',
        },
        target: {
          type: 'string',
          enum: ['this_session', 'new_once', 'new'],
          description: '"this_session" delivers to the calling DSH session; "new_once" creates one session at the first delivery and reuses it; "new" creates a session per delivery. Default "new_once". Ignored when "sessionId" is set.',
        },
        sessionId: {
          type: 'string',
          description: 'Deliver to this EXISTING DSH session instead of a target kind. It must exist, be unarchived, and not be a delegated subagent session.',
        },
        cwd: { type: 'string', description: 'Working directory for sessions a "new_once"/"new" target creates. Defaults to the Harness default workspace.' },
        agentPreset: { type: 'string', description: 'Agent preset for sessions a "new_once"/"new" target creates.' },
      },
      required: ['title', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedule_list',
    title: 'List scheduled tasks in DeepSeek Harness',
    description: [
      'List one page of every Host scheduled task, including tasks other sessions and the Web Automation page',
      'created. Active tasks come first by next occurrence; paused and ended tasks follow, newest first. Use',
      '`dsh_schedule_view` for one task and `dsh_schedule_edit` to change, pause, resume, or delete one.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        active: { type: 'boolean', description: 'true keeps only active tasks; false only paused and ended ones; omitted returns every task.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size from 1 through 500; defaults to 100.' },
        offset: { type: 'integer', minimum: 0, description: 'Number of tasks to skip; defaults to 0.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedule_view',
    title: 'Read one scheduled task',
    description: [
      'Read one Host scheduled task by id: its title, prompt, recurrence fields, delivery target, status,',
      'revision (`updatedAt`), and latest delivery. An unknown id returns `{ id, code: "schedule_not_found" }`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'Task id, from dsh_schedule_create or dsh_schedule_list.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedule_edit',
    title: 'Update, pause, resume, or delete a scheduled task',
    signature: 'dsh_schedule_edit(id, action, title?|prompt?|rrule?|timing?|target?|active?)',
    description: [
      'Change one Host scheduled task. `action: "update"` applies at least one of `title`, `prompt`,',
      '`rrule`/`timing`, `target`/`sessionId`, and `active` (false pauses, true resumes; resume needs',
      'a future occurrence). `action: "delete"` removes the task and its saved deliveries but does not retract',
      'a message already queued. Pass `expectedUpdatedAt` from an earlier read to make the change',
      'conditional: a task that changed since then returns `{ id, code: "schedule_conflict" }` and nothing is',
      'written.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'Task id.' },
        action: { type: 'string', enum: ['update', 'delete'], description: '"update" applies the provided fields (at least one); "delete" removes the task.' },
        title: { type: 'string', minLength: 1, maxLength: 120, description: 'New task name of at most 120 characters.' },
        prompt: { type: 'string', minLength: 1, description: 'New instruction delivered at each occurrence.' },
        rrule: { type: 'string', minLength: 1, description: 'New recurrence in the dsh_schedule_create format.' },
        timing: { type: 'object', description: 'New full timing selector in the dsh_schedule_create format: one of {kind:"after",after_seconds}, {kind:"at",at}, {kind:"every",every_seconds}, {kind:"daily",daily:{time,time_zone}}, {kind:"weekly",weekly:{time,time_zone,weekdays}}, {kind:"cron",cron:{expression,time_zone}}, {kind:"rrule",rrule}.' },
        target: { type: 'string', enum: ['this_session', 'new_once', 'new'], description: 'New destination kind. Omit to keep the current destination; a new creating target reserves a different session.' },
        sessionId: { type: 'string', description: 'New destination: this existing DSH session. Omit to keep the current destination.' },
        active: { type: 'boolean', description: 'false pauses the task; true resumes it when its timing still has a future occurrence.' },
        expectedUpdatedAt: { type: 'string', description: 'updatedAt from an earlier read; when the task changed since then the call returns schedule_conflict and writes nothing.' },
      },
      required: ['id', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedule_run',
    title: 'Deliver one scheduled task now',
    description: [
      'Deliver one Host scheduled task immediately without consuming or moving its scheduled occurrence. The',
      'prompt reaches the target session inbox exactly as a scheduled delivery would. An archived destination',
      'is refused; a task already running returns `{ id, code: "schedule_execution_pending" }`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: 'Task id to deliver now.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_sessions',
    title: 'List DeepSeek Harness sessions',
    description: [
      'List a page of the session index, newest activity first. The index view (default) carries only',
      'what identifies a session: id, title, running state, archival state, activity time, and the agent',
      'recorded as its owner; `view: "full"` adds cwd and liveness. Narrow server-side with `query`',
      '(title, cwd, owning agent, id), `mine`/`owner`, and `running`, then page with `cursor` — instead',
      'of pulling every session and filtering locally. Archived sessions are hidden unless',
      '`includeArchived` is true, mirroring the Web UI. Two options keep a large library cheap:',
      '`titles: false` skips the per-row title lookup (the expensive half of a page), and',
      '`order: "created"` reads the header-only catalogue — millisecond-scale on thousands of sessions —',
      'with `createdAt` instead of `updatedAt`; it falls back to activity order, saying so with',
      '`orderFallback: true`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum sessions to return (default 20, max 200).' },
        includeArchived: {
          type: 'boolean',
          description: 'Include archived sessions and mark them with `archived: true` (default false).',
        },
        mine: {
          type: 'boolean',
          description: 'Only sessions the calling agent created (default false; always on when the endpoint sets restrictToOwner).',
        },
        owner: {
          type: 'string',
          description: 'Only sessions owned by this caller id, for an orchestrator inspecting one agent.',
        },
        query: {
          type: 'string',
          description: 'Only sessions whose title, cwd, owning agent, or id contains this text (case-insensitive).',
        },
        running: { type: 'boolean', description: 'Only sessions with (true) or without (false) a running turn.' },
        view: {
          type: 'string',
          enum: ['index', 'full'],
          description: '"index" (default) returns id/title/running/archived/updatedAt/owner; "full" adds cwd, live, and blank.',
        },
        order: {
          type: 'string',
          enum: ['activity', 'created'],
          description: '"activity" (default) sorts by last activity and is a full projection pass; "created" uses the header-only catalogue (much faster on a large library) with createdAt instead of updatedAt.',
        },
        titles: {
          type: 'boolean',
          description: 'false omits every title, skipping the per-row title lookup — the expensive half of a page (default true).',
        },
        cursor: {
          type: 'integer',
          description: 'Offset into the filtered index; pass nextCursor from the previous page to continue.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read_session',
    title: 'Read a DeepSeek Harness transcript',
    description: [
      'Read a window of a DSH session\'s transcript. `mode` chooses it: "tail" (default, the last',
      '`limit` messages), "head" (the first), or "outline" — one compact row per message with a preview',
      'and its length, the cheapest way to see what a long session contains. Narrow with `roles` and',
      '`afterSeq`, page forward with `window.nextAfterSeq`, and read only the seq range you need.',
      'Messages longer than `maxChars` (default 2000) are cut and marked `truncated` with their real',
      'length. The result always reports totalMessages, matchedMessages and returned, so a caller knows',
      'what it has not seen yet, and `pending` when the session is blocked on a user decision (see',
      '`dsh_list_requests`). Works while the session is archived. To follow a `wait: false` start or',
      'a GUI-driven session, call `dsh_wait_session` instead of polling this tool.',
      '`mode: "events"` instead returns the raw log — tool calls, tool results, permission changes —',
      'as `events[]` with `totalEvents`/`matchedEvents`, filtered by `types` before the window is cut.',
      'That view carries event payloads verbatim, so it can expose arguments and outputs the folded prose',
      'hides; `maxChars` still caps each row, and one response stays within the character budget.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to read.' },
        mode: {
          type: 'string',
          enum: ['tail', 'head', 'outline', 'events'],
          description: '"tail" (default) reads the last messages, "head" the first, "outline" one compact row per message with no full text, "events" the raw log itself (tool calls and results included) as `events[]` with `totalEvents`/`matchedEvents` instead of `messages[]`.',
        },
        limit: { type: 'integer', description: 'Messages in the window (default 10; 200 for an outline; max 5000).' },
        afterSeq: {
          type: 'integer',
          description: 'Only messages after this seq — pass window.nextAfterSeq from the previous read to page forward.',
        },
        roles: {
          type: 'array',
          items: { type: 'string', enum: ['user', 'assistant'] },
          description: 'Only these roles (default both). Ignored in "events" mode — raw events carry no role.',
        },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these event types, e.g. ["user/message","tool/call"] (default all). Applies to "events" mode, and narrows before the window is cut.',
        },
        maxChars: {
          type: 'integer',
          description: 'Per-message character cap (default 2000, 0 = full text). Cut messages carry truncated: true and their real chars; in an outline it caps the preview length instead.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_search_sessions',
    title: 'Search DeepSeek Harness sessions',
    description: [
      'Find sessions by what they contain, server-side, and return bounded snippets instead of whole',
      'transcripts: match the title, cwd, owning agent or id (`scope: "title"`), or the messages',
      'themselves (`scope: "messages"`, `"both"` by default). The candidate set is the newest `scan`',
      'sessions visible to the caller (default 20) — narrow with `mine`/`owner`/`sessionIds` rather than',
      'raising `scan`. Every match says where it hit and carries a snippet, so the caller can then read',
      'exactly that session (or seq range) with `dsh_read_session`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'Case-insensitive substring to find.' },
        scope: { type: 'string', enum: ['title', 'messages', 'both'], description: 'What to search (default both).' },
        mine: { type: 'boolean', description: 'Only sessions the calling agent created.' },
        owner: { type: 'string', description: 'Only sessions owned by this caller id.' },
        sessionIds: { type: 'array', items: { type: 'string' }, description: 'Restrict the search to these sessions.' },
        limit: { type: 'integer', description: 'Maximum matches to return (default 10, max 100).' },
        scan: { type: 'integer', description: 'How many of the newest candidate sessions to look into, transcripts included (default 20, max 200).' },
        perSession: { type: 'integer', description: 'Maximum message matches per session (default 2).' },
        snippetChars: { type: 'integer', description: 'Characters of context per match (default 200).' },
        includeArchived: { type: 'boolean', description: 'Search archived sessions too (default false).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_requests',
    title: 'List pending user decisions',
    description: [
      'List the user decisions a session — or the newest visible sessions — is waiting on: approval',
      'requests (an `approval/asked` with no matching `approval/decided`, the one-shot permission decision',
      'behind a sandbox escalation or a denied tool) and unanswered `ask_user_question` calls. These are',
      'audit events the model never sees, so a delegated session that stops making progress is usually',
      'blocked here. Pass `sessionId` for one session, or scan the newest sessions (running ones first)',
      'with `mine`/`owner`/`scan`. Rows are marked `answerable: true` when this endpoint has parked the',
      'request (which needs `answerApprovals`/`answerQuestions`, or the legacy `answerUserRequests`): those',
      'settle with `dsh_answer_request`, and every',
      'other decision stays in the Harness GUI.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Report only this session instead of scanning.' },
        mine: { type: 'boolean', description: 'Scan only sessions the calling agent created.' },
        owner: { type: 'string', description: 'Scan only sessions owned by this caller id.' },
        includeArchived: { type: 'boolean', description: 'Scan archived sessions too (default false).' },
        includeSettled: {
          type: 'boolean',
          description: 'Also report decisions that already resolved, with their outcome (default false).',
        },
        scan: { type: 'integer', description: 'How many of the newest sessions to inspect, running first (default 20, max 200).' },
        limit: { type: 'integer', description: 'Maximum sessions to report (default 20, max 200).' },
        reasonChars: { type: 'integer', description: 'Characters of an approval reason to keep (default 240).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_answer_request',
    title: 'Answer a pending user decision',
    // An approval passes `decision`, a question passes `answers`.
    signature: 'dsh_answer_request(requestId, decision|answers)',
    description: [
      'Answer one approval or user question this endpoint parked for you — available only when the',
      'deployment enables `answerApprovals` and/or `answerQuestions` (or the legacy `answerUserRequests`),',
      'and only for sessions this endpoint drives. For an',
      'approval pass `decision: "allow"` (the one-shot grant the GUI would give) or `"deny"`; for a',
      'question pass `answers: [{ id, selected: [...] }]` with one entry per question. Ids come from',
      '`dsh_list_requests`, which marks the parked rows `answerable: true`. Other answerers — the Harness',
      'GUI above all — stay in the race: whoever decides first wins, and a request nobody answers still',
      'fails closed at the configured ceiling.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          minLength: 1,
          description: 'The approval id or question call id reported by dsh_list_requests.',
        },
        decision: {
          type: 'string',
          enum: ['allow', 'deny'],
          description: 'Approval only: allow one-shot, or deny.',
        },
        answers: {
          type: 'array',
          description: 'Question only: one entry per question in the request.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              selected: { type: 'array', items: { type: 'string' } },
              custom: { type: 'string' },
            },
            required: ['id', 'selected'],
          },
        },
      },
      required: ['requestId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_wait_session',
    title: 'Wait for a DeepSeek Harness turn',
    description: [
      'Block until the turn a session is already running ends, then return the assistant text it produced.',
      'Use it after a `wait: false` start, for sessions started in the Harness GUI, or to follow work in',
      'another caller\'s session. It never prompts, steers, or cancels: reaching `timeoutMs` returns',
      '`status: "timedOut"` with `running: true` and leaves the DSH turn alone, so pass a ceiling below',
      'your own client\'s call timeout and call the tool again while the turn keeps running. A result also',
      'carries `pending` when the session is blocked on a user decision (see `dsh_list_requests`). Returns',
      '`status: "idle"` immediately when no turn is running; `limit` adds the transcript tail to any result.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session to wait for.' },
        timeoutMs: {
          type: 'integer',
          description: 'Wait ceiling in milliseconds (default 1800000, max 86400000). A timed-out wait leaves the turn running.',
        },
        limit: { type: 'integer', description: 'Include the last N transcript messages in the result (default 0 = none).' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_cancel_session',
    title: 'Cancel a DeepSeek Harness turn',
    description: 'Cancel the active turn of a DSH session without dropping its pending inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session whose turn should be cancelled.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_archive_session',
    title: 'Archive a DeepSeek Harness session',
    description: [
      'Archive one session durably: it disappears from every grouping surface (and from',
      '`dsh_list_sessions` unless `includeArchived` is true) and cannot run a model step until it is',
      'unarchived. A session with running work (turn, subagent, job, schedule) is refused unless you',
      'pass `stopActivity: true`, which archives first and then asks those providers to stop. Archiving',
      'also drops the session\'s pin.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to archive.' },
        stopActivity: {
          type: 'boolean',
          description: 'Archive even while work is running, stopping that work (default false).',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_unarchive_session',
    title: 'Unarchive a DeepSeek Harness session',
    description: [
      'Drop a session from the archive set so it is listed again and can run model steps; it returns to',
      'its recorded position. The transcript is readable while archived and is not modified by either',
      'operation.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session id to unarchive.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_permission_presets',
    title: 'List DeepSeek Harness permission presets',
    description: [
      'List the permission presets this deployment offers: each one bundles a sandbox mode',
      '(`read-only`, `workspace-write`, `danger-full-access`) with an approval policy (`ask`, `never`).',
      'Pass a preset name as `permissionPreset` to `dsh_run_prompt` or `dsh_continue_session`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_list_tools',
    title: 'List DeepSeek Harness tools',
    description: [
      'List the tools the Harness exposes to its own agents (names and short descriptions), for',
      'choosing what a delegated prompt can do. Pass `query` to narrow by name or description, and',
      '`limit` to cap the list instead of reading the whole catalog.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Only tools whose name or description contains this text (case-insensitive).' },
        limit: { type: 'integer', description: 'Maximum tools to return (default 0 = all).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_status',
    title: 'DeepSeek Harness status',
    description: 'Report the MCP endpoint, Harness profile/version, session and live-agent counts, the default model, and the default permission preset with its catalog.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dsh_prepare_upload',
    title: 'Prepare a presigned image upload',
    description: [
      'Mint one short-lived upload link per image, so a client that can only run a shell command',
      'can still put bytes into a session. The returned `uploadUrl` accepts a plain `PUT` of the',
      'raw bytes with no authorization header — the unguessable nonce in the path is the capability.',
      'Then pass the returned `fileId`s to `dsh_run_prompt.fileIds`. Links expire',
      '(`uploadTtlMs`, 5 minutes by default) and each accepts one successful upload; failed',
      'attempts may be retried until `uploadMaxAttempts` is reached.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Display name carried into the stored attachment.' },
              mediaType: {
                type: 'string',
                enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
                description: 'Declared MIME type; the bytes are checked against it before storage.',
              },
              expectedBytes: { type: 'integer', description: 'Size the link will accept; defaults to the per-file ceiling.' },
              sha256: { type: 'string', description: 'Optional (or required by configuration) digest of the bytes.' },
            },
            required: ['mediaType'],
            additionalProperties: false,
          },
        },
        clientBaseUrl: {
          type: 'string',
          description: 'Override the address the server echoes into `uploadUrl` (needed when a proxy rewrites Host without X-Forwarded-*).',
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read_attachment',
    title: 'Read one image from a session transcript',
    description: [
      'Return one image that a session recorded (a user upload or a tool result) as an MCP image',
      'content block, so a client with vision can look at it. `seq` is the event sequence number',
      'reported by `dsh_read_session`; when that event carries several images, `index` picks one.',
      'Most clients attach at most four images per tool result, so read several images in several calls.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The session that recorded the image.' },
        seq: { type: 'integer', description: 'Event sequence number inside that session.' },
        index: { type: 'integer', minimum: 0, description: 'Which image of that event, default 0.' },
        maxEdge: { type: 'integer', description: 'Long edge in pixels to downscale to, default 1568.' },
      },
      required: ['sessionId', 'seq'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_whoami',
    title: 'Identify the calling agent',
    description: [
      'Report how this endpoint identifies the calling agent and list the DSH sessions that agent',
      'created. The label comes from the `x-dsh-mcp-client` request header, else the `clientInfo` block',
      'sent on `initialize`, else `User-Agent`; `client.source` says which one was used. This is',
      'attribution, not authentication: all callers present the same endpoint token, so a client may',
      'name itself. Use it to find your own sessions, or in a shared endpoint to attribute one.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum owned sessions to list (default 20, 0 = count only).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_open_session',
    title: 'Open a session in the Harness GUI',
    description: [
      'Ask the running Harness Web GUI to open one session and select it in the sidebar — the way to point',
      'the person at a session this endpoint started, instead of describing where to find it. The request',
      'is delivered to the page that is open (a page polls this endpoint), so it takes effect within a',
      'couple of seconds while the GUI is running; a Harness with no page open simply never consumes it.',
      'It changes nothing about the session itself: no turn, no message, no state.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'The DSH session to open in the GUI.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
]

/** Static resources: status and the session index. */
export function listResources() {
  return [
    {
      uri: 'dsh://status',
      name: 'Harness status',
      title: 'DeepSeek Harness status',
      description: 'Endpoint, profile, version, session and agent counts, default model.',
      mimeType: 'application/json',
    },
    {
      uri: 'dsh://sessions',
      name: 'Sessions',
      title: 'DeepSeek Harness sessions',
      description: 'Visible sessions (archived ones excluded) with title, cwd, running state, archival state, and activity time.',
      mimeType: 'application/json',
    },
  ]
}

/** One resource template per session transcript. */
export function listResourceTemplates() {
  return [
    {
      uriTemplate: 'dsh://session/{sessionId}',
      name: 'Session transcript',
      title: 'DeepSeek Harness session transcript',
      description: 'Ordered user/assistant messages of one session.',
      mimeType: 'application/json',
    },
  ]
}
