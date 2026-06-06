/**
 * Adapter registry for `persona install`.
 *
 * The command shape is multi-agent from the start; the MVP registry contains
 * only `claude-code`. `claude` is accepted as an alias. Alias resolution is
 * intentionally kept here (not in cli.ts) so the install logic and the CLI
 * share a single source of truth.
 */

/** Canonical set of supported target agent identifiers. */
export const SUPPORTED_AGENTS = ['claude-code'] as const
export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number]

/** The default target used when `--yes` is passed without `--agent`. */
export const DEFAULT_AGENT: SupportedAgent = 'claude-code'

/**
 * Alias map: maps user-supplied names (including canonical names) to their
 * canonical agent id. Returns `undefined` for any name not in the registry.
 */
const AGENT_ALIASES: Record<string, SupportedAgent> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
}

/**
 * Resolve a user-supplied agent name to its canonical id.
 *
 * Returns the canonical `SupportedAgent` id, or `undefined` if the name is
 * not recognised. This is the only place agent alias expansion happens — both
 * the CLI flag parser and the install logic delegate here.
 */
export function resolveAgent(agent: string): SupportedAgent | undefined {
  return AGENT_ALIASES[agent]
}

/**
 * Pure function: resolve a user's interactive input to a canonical agent from
 * a given list of candidates.
 *
 * Accepts:
 *   - A canonical agent name (e.g. `"claude-code"`) — resolved via the alias map.
 *   - A known alias (e.g. `"claude"`).
 *   - A 1-based numeric index string (e.g. `"1"`) selecting from `candidates`.
 *
 * Returns the resolved canonical agent, or `undefined` if the input is invalid.
 * Leading/trailing whitespace is trimmed before matching.
 *
 * Keeping the selection logic here (not in cli.ts) allows unit-testing without
 * any readline or TTY machinery.
 */
export function selectAgent(input: string, candidates: readonly string[]): string | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined

  // Try alias / canonical name first.
  const byAlias = AGENT_ALIASES[trimmed]
  if (byAlias !== undefined) return byAlias

  // Try 1-based numeric index.
  const n = Number(trimmed)
  if (Number.isInteger(n) && n >= 1 && n <= candidates.length) {
    return candidates[n - 1]
  }

  return undefined
}
