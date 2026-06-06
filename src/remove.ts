/**
 * `persona remove <id>` — remove a persona mask (人格面具) or a targeted
 * artifact for a specific agent.
 *
 * Two distinct removal modes (ADR-0001, ADR-0003):
 *
 *  Default remove (no --agent):
 *    Removes the whole mask directory (`~/.persona/<id>/`) **and** its
 *    `.lock.json` entry. This is a full persona mask removal (面具移除).
 *
 *  Targeted remove (--agent <agent>):
 *    Removes only the generated artifact for that agent (e.g.
 *    `~/.claude/output-styles/<id>.md` for claude-code). The mask directory
 *    and lock entry are preserved because the mask itself and its source
 *    metadata remain intact. This is "targeted artifact removal".
 *
 * Active-style guard (Claude Code):
 *   If a targeted remove would delete the Output Style file that is currently
 *   active (settings.json `outputStyle === id`), interactive mode prompts the
 *   user to choose between clearing the `outputStyle` or aborting. Non-
 *   interactive mode hard-fails unless `--clear-active` is passed.
 *
 * Stale lock guard:
 *   If the mask directory is absent but a lock entry still exists, interactive
 *   mode prompts the user to clean up the orphaned entry; non-interactive mode
 *   hard-fails unless `--prune-lock` is passed.
 *
 * Non-destructive contract (ADR-0001):
 *   Only files the CLI owns (`~/.persona/<id>/` and
 *   `~/.claude/output-styles/<id>.md`) are ever deleted. Only the `outputStyle`
 *   field is ever cleared in settings.json; all other keys are preserved.
 *   The CLI never touches CLAUDE.md, AGENTS.md, hooks, or subagent definitions.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  personaHome,
  claudeOutputStylesDir,
  claudeSettingsPath,
} from './paths.js'
import { lockPath, readLock, writeLock } from './lock.js'
import { isPathSafeId } from './add.js'
import { resolveAgent, selectAgent, DEFAULT_AGENT, SUPPORTED_AGENTS } from './adapter-registry.js'

// ─── pure logic helpers (exported for unit tests) ────────────────────────────

/**
 * Determine whether a given persona id is currently the active output style
 * in a Claude Code settings file.
 *
 * `settingsContent` is the raw text of the settings file, or `null`/`""` when
 * the file does not exist. Returns `false` on any parse error (the file is
 * treated as "no active style" when it is unreadable — the activate command
 * would already have blocked on this).
 *
 * Pure function — no I/O. Exported for unit tests.
 */
export function isActiveStyle(settingsContent: string | null, id: string): boolean {
  if (settingsContent === null || settingsContent.trim() === '') return false
  try {
    const parsed: unknown = JSON.parse(settingsContent)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>)['outputStyle'] === id
    }
  } catch {
    // invalid JSON — treat as no active style
  }
  return false
}

/**
 * Return a new settings JSON string with `outputStyle` removed (or set to
 * undefined so it is omitted from JSON.stringify output).
 *
 * Throws if `existingContent` is non-empty but contains invalid JSON, or if
 * the top-level value is not a plain object. The caller must not overwrite the
 * file in that case.
 *
 * All other keys are preserved. Pure function — no I/O. Exported for unit tests.
 */
export function clearOutputStyle(existingContent: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(existingContent)
  } catch (cause) {
    throw new Error(`settings.json contains invalid JSON: ${String(cause)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `settings.json is not a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    )
  }
  const settings = { ...(parsed as Record<string, unknown>) }
  delete settings['outputStyle']
  return JSON.stringify(settings, null, 2) + '\n'
}

// ─── I/O helpers ─────────────────────────────────────────────────────────────

/**
 * Read a single line from stdin.
 */
function readOneLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: undefined, terminal: false })
    let line = ''
    rl.once('line', (l) => {
      line = l
      rl.close()
    })
    rl.once('close', () => resolve(line))
  })
}

/**
 * Parse a yes/no confirmation from `input`.
 * Returns `true` for "y" / "yes" (case-insensitive), `false` for anything else.
 */
function parseYesNo(input: string): boolean {
  const trimmed = input.trim().toLowerCase()
  return trimmed === 'y' || trimmed === 'yes'
}

/**
 * Prompt the user interactively to choose a target agent from `candidates`.
 */
async function promptAgentSelection(
  candidates: readonly string[],
  maxAttempts = 3,
): Promise<string | undefined> {
  process.stdout.write('Select a target agent:\n')
  for (let i = 0; i < candidates.length; i++) {
    process.stdout.write(`  ${i + 1}) ${candidates[i]}\n`)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const askOnce = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question('Your choice (name or number): ', (answer) => {
        resolve(answer)
      })
    })

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const answer = await askOnce()
      const resolved = selectAgent(answer, candidates)
      if (resolved !== undefined) return resolved
      process.stdout.write(
        `Invalid choice "${answer.trim()}". Please enter a number (1–${candidates.length}) or agent name.\n`,
      )
    }
    return undefined
  } finally {
    rl.close()
  }
}

// ─── main command ─────────────────────────────────────────────────────────────

/**
 * `persona remove <id> [--agent <agent>] [--yes] [--clear-active] [--prune-lock] [--project]`
 *
 * Options:
 *   --agent <name>   Targeted removal: remove only the artifact for this agent.
 *   --yes            Use the default agent (targeted mode, non-interactive).
 *   --clear-active   (Non-interactive) Allow removing an artifact that is
 *                    currently the active outputStyle; clears the outputStyle
 *                    field in settings.json.
 *   --prune-lock     (Non-interactive) Allow cleaning up a stale lock entry
 *                    when the mask directory is missing.
 *   --project        Read/write the project-local .claude/settings.json instead
 *                    of the user-level ~/.claude/settings.json (mirrors activate).
 */
export async function runRemove(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      agent: { type: 'string' },
      yes: { type: 'boolean', default: false },
      'clear-active': { type: 'boolean', default: false },
      'prune-lock': { type: 'boolean', default: false },
      project: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  const id = positionals[0]
  if (id === undefined) {
    process.stderr.write('persona remove: missing persona mask id\n')
    return 2
  }

  // Reject path-unsafe ids BEFORE any destructive filesystem operation: the id
  // feeds directly into `join(home, id)` and the artifact path, so an id like
  // `../../etc` could otherwise delete files outside ~/.persona or
  // ~/.claude/output-styles. (Same guard `add` applies on import.)
  if (!isPathSafeId(id)) {
    process.stderr.write(
      `persona remove: invalid persona mask id "${id}" (must be path-safe: no slashes or leading dot)\n`,
    )
    return 1
  }

  const isTTY = process.stdin.isTTY === true
  const home = personaHome()
  const maskDir = join(home, id)
  const lp = lockPath(home)
  const lock = readLock(lp)
  const hasLockEntry = id in lock.personas
  const hasMaskDir = existsSync(maskDir)

  // Determine target agent (only relevant for targeted remove) ---------------
  // We resolve the agent before checking mask existence so that invalid
  // --agent values are caught early regardless of mask state.
  let targetAgent: string | undefined

  if (values.agent !== undefined || values.yes) {
    if (values.agent !== undefined) {
      const resolved = resolveAgent(values.agent)
      if (resolved === undefined) {
        process.stderr.write(
          `persona remove: agent not supported: "${values.agent}". Supported agents: claude-code (alias: claude)\n`,
        )
        return 1
      }
      targetAgent = resolved
    } else {
      // --yes without --agent → use default agent
      targetAgent = DEFAULT_AGENT
    }
  }

  // ── Stale lock check (mask dir absent but lock entry exists) ────────────────
  // This only applies to default remove (no --agent) because targeted remove
  // operates on artifacts — if the mask dir is gone there is nothing to do.
  if (!hasMaskDir && !values.agent && !values.yes) {
    if (!hasLockEntry) {
      process.stderr.write(
        `persona remove: persona mask not found: ${id}\n`,
      )
      return 1
    }

    // Stale lock entry present
    if (!isTTY && !values['prune-lock']) {
      process.stderr.write(
        `persona remove: mask directory for "${id}" does not exist but a lock entry remains.\n` +
          `  Re-run with --prune-lock to clean up the orphaned lock entry.\n`,
      )
      return 1
    }

    // `--prune-lock` expresses the intent explicitly, so honour it without a
    // prompt even on a TTY; only prompt when the flag was not passed.
    if (isTTY && !values['prune-lock']) {
      process.stdout.write(
        `persona remove: mask directory for "${id}" is missing but a lock entry remains.\n` +
          `Clean up the orphaned lock entry? [y/N] `,
      )
      const answer = await readOneLine()
      if (!parseYesNo(answer)) {
        process.stderr.write('persona remove: clean-up cancelled\n')
        return 1
      }
    }

    // Prune the stale lock entry
    delete lock.personas[id]
    writeLock(lp, lock)
    process.stdout.write(`persona remove: removed stale lock entry for "${id}"\n`)
    return 0
  }

  // ── Targeted remove (--agent or --yes) ──────────────────────────────────────
  if (values.agent !== undefined || values.yes) {
    // In targeted mode we need a target agent (already resolved above).
    // If the mask dir doesn't exist, we still allow targeted remove (the
    // artifact may still be present) but we cannot validate schema — that
    // is fine since targeted remove only touches the artifact.

    // Interactive agent selection when neither --agent nor --yes are given
    // is handled by the else-branch below (if we reach here, one of them is set).

    const agent = targetAgent!

    if (agent !== 'claude-code') {
      // Future adapters: fail fast for now (ADR-0001 scope)
      process.stderr.write(`persona remove: no adapter for agent: ${agent}\n`)
      return 1
    }

    // Claude Code targeted remove: delete the output-styles artifact
    const artifactFile = join(claudeOutputStylesDir(), `${id}.md`)

    if (!existsSync(artifactFile)) {
      process.stderr.write(
        `persona remove: artifact not found for "${id}" (agent: ${agent}): ${artifactFile}\n`,
      )
      return 1
    }

    // Determine which settings file to inspect (mirrors activate)
    const settingsFile = values.project
      ? join(process.cwd(), '.claude', 'settings.json')
      : claudeSettingsPath()

    const settingsContent = existsSync(settingsFile)
      ? readFileSync(settingsFile, 'utf8')
      : null

    const active = isActiveStyle(settingsContent, id)

    if (active) {
      if (!isTTY && !values['clear-active']) {
        process.stderr.write(
          `persona remove: "${id}" is currently the active output style for ${agent}.\n` +
            `  Re-run with --clear-active to also clear the outputStyle in settings.json.\n`,
        )
        return 1
      }

      // Interactive: ask the user what to do
      if (isTTY && !values['clear-active']) {
        process.stdout.write(
          `persona remove: "${id}" is currently the active output style.\n` +
            `Clear outputStyle in ${settingsFile}? [y/N] `,
        )
        const answer = await readOneLine()
        if (!parseYesNo(answer)) {
          process.stderr.write('persona remove: removal cancelled\n')
          return 1
        }
      }

      // Clear outputStyle (non-destructive merge)
      if (settingsContent !== null) {
        try {
          const cleared = clearOutputStyle(settingsContent)
          mkdirSync(join(settingsFile, '..'), { recursive: true })
          writeFileSync(settingsFile, cleared, 'utf8')
        } catch (err) {
          process.stderr.write(
            `persona remove: failed to clear outputStyle in ${settingsFile}: ${String(err)}\n`,
          )
          return 1
        }
      }
    }

    // Delete the artifact (CLI owns this file)
    rmSync(artifactFile)

    process.stdout.write(
      `persona remove: removed artifact for "${id}" (agent: ${agent}) at ${artifactFile}\n`,
    )
    // Lock entry is preserved (ADR-0003: targeted remove keeps source metadata)
    return 0
  }

  // ── Interactive agent selection for targeted remove (no --agent, no --yes) ──
  // We only reach here when the user did NOT pass --agent or --yes.
  // If a target agent is NOT specified at all, this is a default remove.
  // Default remove: remove mask directory + lock entry.

  // ── Default remove ───────────────────────────────────────────────────────────

  if (!hasMaskDir) {
    // At this point, if there was a lock entry the stale-lock branch above
    // would have handled it. No directory AND no lock entry → not found.
    process.stderr.write(`persona remove: persona mask not found: ${id}\n`)
    return 1
  }

  // Delete the mask directory (CLI owns everything under ~/.persona/<id>/)
  rmSync(maskDir, { recursive: true, force: true })

  // Remove lock entry if present
  if (hasLockEntry) {
    delete lock.personas[id]
    writeLock(lp, lock)
  }

  process.stdout.write(`persona remove: removed persona mask "${id}"\n`)

  // Default remove deliberately leaves installed agent artifacts alone (those
  // are cleaned up with a targeted `--agent` remove). Warn if a Claude Code
  // Output Style still points at the now-deleted mask so the user isn't left
  // with a dangling artifact — especially one that is still the active style.
  const danglingArtifact = join(claudeOutputStylesDir(), `${id}.md`)
  if (existsSync(danglingArtifact)) {
    const settingsContent = existsSync(claudeSettingsPath())
      ? readFileSync(claudeSettingsPath(), 'utf8')
      : null
    const stillActive = isActiveStyle(settingsContent, id)
    process.stderr.write(
      `persona remove: warning: a Claude Code Output Style for "${id}" still exists at ${danglingArtifact}` +
        `${stillActive ? ' and is currently the active output style' : ''}.\n` +
        `  Run \`persona remove ${id} --agent claude-code\` to remove that artifact too.\n`,
    )
  }

  return 0
}
