# Must-reply questions

> Part of [DSH MCP Server](../../README.en.md) · [Docs index](../README.md)

Ask a session something it must answer before its turn can end.

A one-way prompt is not a question when the caller cannot continue without the answer. `dsh_ask_session`
turns one session's question into a request that stays open:

- **One id per question.** The question is delivered once, in full, and gets an id (`q-…`). The call
  blocks: the asking turn cannot end before the target answers, so the answer always reaches the work
  that needs it.
- **Reminders ride calls the target already makes.** There is no reminder timer and no "reminder
  turn": on every turn, step, assistant message and tool result the id-only reminder is injected into
  the target's next call (the Harness's no-wake `inject` path; a running handle that lacks `inject` is
  steered instead). An idle or manually stopped session is never woken just to be reminded, and events
  closer together than one second produce one reminder. If an activity arrives while the question is
  still in flight, the reminder is sent as soon as the question lands. The reminder carries the id and
  the two calls, never the question again; `dsh_get_question` is how the target reads it again.
- **Only the addressed session can answer.** `dsh_answer_question` checks the caller's session id
  against the request's target, so another session (or an external MCP client, which has no session)
  cannot settle it. The first answer stands; repeating it reports `alreadyAnswered`.
- **A human stop wins.** A turn the person stopped (`turn/end` with an `aborted` reason caused by
  `user`) settles the open question with `status: "stopped"` and nothing is sent to that session — no
  reminder, no withdrawal, no new turn. Asking a session whose latest recorded turn was such a stop is
  refused before delivery (also after a reload), so a question can never be what resumes it; resuming
  the session normally clears the stop.
- **The wait can be ended deliberately, never silently.** `timeoutMs: 0` (the default) waits until
  answered; a positive value returns `status: "timedOut"`. A cancelled asking turn, a closed HTTP
  request, or a plugin reload rejects the call, and the target receives one "withdrawn" line so it
  stops working on a question nobody is waiting for.
- **Self-asks and deadlocks are refused before delivery.** Asking yourself is pointless; asking a
  session that is already (directly or transitively) waiting on a must-reply question from you would
  deadlock both turns, so it is refused with the chain named.
- **It needs an answer path.** The target answers through this endpoint's DSH-local tools, so the
  request is refused while `exposeToDsh` is off (a question nobody can answer would only hang).
  An external MCP caller may ask too, but only the addressed DSH session can answer.

The endpoint's one `session/event` listener exists for exactly these two facts — a target about to
run a step, and a target a person stopped. The task-start sync engine is still the separate
`dsh-work-sync` row.

`dsh_status` reports `questions: { pending, settled, activity }`, where `activity` counts the
call events seen, the reminders injected, the refusals and the last refusal reason (`not-live`,
`no-inject`, `inject-threw`, `steer-threw`, …), per event kind. It is how a deployment can tell
"the target never ran" from "the Harness refused the injection".
