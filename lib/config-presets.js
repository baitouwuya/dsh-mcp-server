/**
 * Named bundles of row defaults.
 *
 * A deployment that is not going to hand-tune thirty fields should be able to
 * say what it wants the endpoint to be: a general delegation surface, a
 * locked-down shared endpoint, or an MCP-only surface that stays out of the
 * sidebar and never answers a decision. A preset only fills fields the row
 * leaves unset; an explicit row value always wins, so `preset: "strict"` plus
 * `busyMode: "steer"` keeps the stricter isolation but steers.
 *
 * @module dsh-mcp-server/config-presets
 */

/** The presets this bundle understands, in the order the docs list them. */
export const CONFIG_PRESETS = Object.freeze({
  /** The default: full delegation, per-caller policy chosen by the row. */
  delegate: Object.freeze({}),
  /** Shared endpoint safety: each caller sees only its own sessions. */
  strict: Object.freeze({
    restrictToOwner: true,
    answerUserRequests: false,
    answerOwnedSessionsOnly: true,
    createGroups: false,
    busyMode: 'queue',
  }),
  /** MCP-only: no local tool surface, no sidebar changes, no answerer. */
  observer: Object.freeze({
    exposeToDsh: false,
    groupSessions: false,
    createGroups: false,
    answerUserRequests: false,
    restrictToOwner: true,
    busyMode: 'queue',
  }),
})

/** The names above, for validation and diagnostics. */
export const PRESET_NAMES = Object.freeze(Object.keys(CONFIG_PRESETS))

/**
 * Merge a row's preset under its explicit fields.
 *
 * @param config - the row configuration, possibly carrying `preset`.
 * @returns a configuration whose unset fields come from the preset.
 */
export function resolveConfigPreset(config = {}) {
  const raw = config.preset
  if (raw === undefined || raw === null || raw === '') return { ...config, preset: 'delegate' }
  if (typeof raw !== 'string' || !Object.hasOwn(CONFIG_PRESETS, raw)) {
    throw new Error(
      `dsh-mcp-server: "preset" must be one of ${PRESET_NAMES.join(', ')} (got ${String(raw)}).`,
    )
  }
  return { ...CONFIG_PRESETS[raw], ...config, preset: raw }
}
