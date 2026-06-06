#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { runAdd } from './add.js'
import { listMaskIds } from './library.js'
import { parsePersonaMd } from './persona-md.js'
import { personaHome, claudeOutputStylesDir } from './paths.js'
import { compilePersonaPrompt } from './renderer.js'
import { validateMask } from './validator.js'
import { resolveAgent, selectAgent, DEFAULT_AGENT, SUPPORTED_AGENTS } from './adapter-registry.js'
import { renderOutputStyle } from './install.js'

function runList(): number {
  const ids = listMaskIds(personaHome())
  if (ids.length === 0) {
    process.stderr.write('No persona masks found in ~/.persona/\n')
    return 0
  }
  process.stdout.write(ids.join('\n') + '\n')
  return 0
}

/**
 * `persona use <id>` — temporary application (临时套用). Validates the persona
 * mask, then renders a one-shot main-session prompt to stdout for piping into a
 * coding agent (`persona use senpai-rust | claude`). It renders directly from
 * `~/.persona/<id>/`, installs nothing, and reads no target-agent artifacts.
 *
 * Schema errors block `use` with a non-zero exit and nothing on stdout. Length
 * warnings go to stderr and do not change the exit code.
 */
function runUse(rest: string[]): number {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true })
  const id = positionals[0]
  if (id === undefined) {
    process.stderr.write('persona use: missing persona mask id\n')
    return 2
  }

  const maskDir = join(personaHome(), id)
  const maskFile = join(maskDir, 'persona.md')
  if (!existsSync(maskFile)) {
    process.stderr.write(`persona use: persona mask not found: ${id}\n`)
    return 1
  }

  const parsed = parsePersonaMd(readFileSync(maskFile, 'utf8'))

  const errors = validateMask(parsed)
  if (errors.length > 0) {
    process.stderr.write(`persona use: ${id} is not a valid persona mask:\n`)
    for (const error of errors) {
      process.stderr.write(`  - ${error.message}\n`)
    }
    return 1
  }

  const { prompt, warnings } = compilePersonaPrompt(parsed, maskDir)
  for (const warning of warnings) {
    process.stderr.write(`persona use: warning: ${warning}\n`)
  }
  process.stdout.write(prompt)
  return 0
}

/**
 * Prompt the user interactively to choose a target agent from `candidates`.
 *
 * Lists each candidate with a 1-based index, then reads one line from stdin.
 * Delegates to `selectAgent` for the resolution logic. Retries up to
 * `maxAttempts` times on invalid input before giving up.
 *
 * Returns the canonical agent name, or `undefined` if the user exhausted
 * retries or closed stdin without a valid selection.
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

/**
 * `persona install <id> [--agent <agent>] [--yes]` — face-mask installation
 * (面具安装). Validates the persona mask, renders it as a Claude Code Output
 * Style artifact, and writes it to `~/.claude/output-styles/<id>.md`.
 *
 * Target-agent selection rules:
 *   - `--agent <name>`: use the named agent (alias-resolved).
 *   - `--yes`:          use the default agent without prompting.
 *   - neither + TTY:    interactively prompt the user to choose an agent.
 *   - neither + non-TTY: hard-fail; automated contexts must be explicit.
 *
 * `install` only writes the Output Style file (ADR-0001). It does not:
 *   - enable the style (no settings.json changes, no outputStyle field)
 *   - write CLAUDE.md, AGENTS.md, hooks, or subagent definitions
 */
async function runInstall(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      agent: { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  const id = positionals[0]
  if (id === undefined) {
    process.stderr.write('persona install: missing persona mask id\n')
    return 2
  }

  // Determine target agent --------------------------------------------------
  let targetAgent: string
  if (values.agent !== undefined) {
    const resolved = resolveAgent(values.agent)
    if (resolved === undefined) {
      process.stderr.write(
        `persona install: agent not supported: "${values.agent}". Supported agents: claude-code (alias: claude)\n`,
      )
      return 1
    }
    targetAgent = resolved
  } else if (values.yes) {
    targetAgent = DEFAULT_AGENT
  } else {
    // Branching on TTY vs non-TTY -----------------------------------------
    const isTTY = process.stdin.isTTY === true
    if (!isTTY) {
      // Non-interactive hard-fail: don't guess the target agent.
      process.stderr.write(
        'persona install: non-interactive mode requires --agent <agent> or --yes (to use the default agent)\n',
      )
      return 2
    }
    // Interactive TTY: present a numbered list and let the user choose.
    const chosen = await promptAgentSelection([...SUPPORTED_AGENTS])
    if (chosen === undefined) {
      process.stderr.write('persona install: no valid agent selected; aborting\n')
      return 2
    }
    targetAgent = chosen
  }

  // Load and validate the mask -----------------------------------------------
  const maskDir = join(personaHome(), id)
  const maskFile = join(maskDir, 'persona.md')
  if (!existsSync(maskFile)) {
    process.stderr.write(`persona install: persona mask not found: ${id}\n`)
    return 1
  }

  const parsed = parsePersonaMd(readFileSync(maskFile, 'utf8'))
  const errors = validateMask(parsed)
  if (errors.length > 0) {
    process.stderr.write(`persona install: ${id} is not a valid persona mask:\n`)
    for (const error of errors) {
      process.stderr.write(`  - ${error.message}\n`)
    }
    return 1
  }

  // Render the Output Style artifact (Claude Code only in MVP) ---------------
  if (targetAgent !== 'claude-code') {
    // Future adapters live here; the registry already validates the name above.
    process.stderr.write(`persona install: no adapter for agent: ${targetAgent}\n`)
    return 1
  }

  const { content, warnings } = renderOutputStyle(parsed, maskDir)
  for (const warning of warnings) {
    process.stderr.write(`persona install: warning: ${warning}\n`)
  }

  // Write to ~/.claude/output-styles/<id>.md ---------------------------------
  const outDir = claudeOutputStylesDir()
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `${id}.md`)
  writeFileSync(outFile, content, 'utf8')

  process.stdout.write(`persona install: installed "${id}" for ${targetAgent} at ${outFile}\n`)
  return 0
}

/**
 * The multi-agent command shape is fixed from the start. `activate` and
 * `remove` still accept `--agent <agent>` so later slices can fill in the
 * behavior without changing the CLI surface.
 */
function runReserved(command: string, rest: string[]): number {
  const { values } = parseArgs({
    args: rest,
    options: { agent: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const resolved = values.agent !== undefined ? resolveAgent(values.agent) : undefined
  const target = resolved ?? values.agent ?? '<choose at command time>'
  process.stderr.write(`persona ${command}: not yet implemented (target agent: ${target})\n`)
  return 1
}

const RESERVED_COMMANDS = new Set(['activate', 'remove'])

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  if (command === 'list') return runList()
  if (command === 'use') return runUse(rest)
  if (command === 'add') return runAdd(rest)
  if (command === 'install') return runInstall(rest)
  if (command !== undefined && RESERVED_COMMANDS.has(command)) return runReserved(command, rest)

  process.stderr.write(`persona: unknown command: ${command ?? '(none)'}\n`)
  return 2
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`persona: unexpected error: ${String(err)}\n`)
  process.exit(1)
})
