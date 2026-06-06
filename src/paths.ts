import { homedir } from 'node:os'
import { join } from 'node:path'

/** The persona mask library directory, `~/.persona/`. */
export function personaHome(): string {
  return join(homedir(), '.persona')
}

/** Claude Code's user-level config directory, `~/.claude/`. */
export function claudeHome(): string {
  return join(homedir(), '.claude')
}

/**
 * Directory where Claude Code Output Style artifacts are stored,
 * `~/.claude/output-styles/`. Created on demand by `persona install`.
 */
export function claudeOutputStylesDir(): string {
  return join(claudeHome(), 'output-styles')
}
