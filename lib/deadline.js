/**
 * Bound one wait, once, for the whole plugin.
 *
 * This exists because the same twenty lines were wrong three separate times:
 *
 * 1. a timeout that only flipped a flag, so every `await` on the promise hung;
 * 2. a timer that was never cleared, so a healthy wait re-fired its deadline
 *    minutes later and narrowed the deployment;
 * 3. a late answer that overwrote whatever had replaced it.
 *
 * The contract below is deliberately small: it settles exactly once, it clears
 * its own timer, and it never lets the losing side become an unhandled rejection.
 * What a late value *means* stays with the caller.
 *
 * @module dsh-mcp-server/deadline
 */

/** The ceiling used when a caller passes something that is not a duration. */
const DEFAULT_DEADLINE_MS = 2000

/**
 * Wait for `work`, but never longer than `ms`.
 *
 * @param work - the promise to bound.
 * @param ms - how long it may take; a non-finite or negative value falls back.
 * @param options.onTimeout - called once when the deadline wins, before settling.
 * @returns `{ timedOut, value }` — on a deadline, `value` is `undefined`.
 */
export function withDeadline(work, ms, { onTimeout } = {}) {
  const limit = Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_DEADLINE_MS
  const promise = Promise.resolve(work)

  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {
        // A hook that throws must not keep the wait from settling.
      }
      resolve({ timedOut: true, value: undefined })
    }, limit)
  })

  const settled = promise
    .then((value) => ({ timedOut: false, value }))
    .finally(() => clearTimeout(timer))

  // When the deadline wins, this side is the loser: it must not surface later as
  // an unhandled rejection now that nobody is listening.
  settled.catch(() => {})

  return Promise.race([settled, deadline])
}
