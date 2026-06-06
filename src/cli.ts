#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { runAdd } from './add.js'
import { listMaskIds } from './library.js'
import { parsePersonaMd } from './persona-md.js'
import { personaHome } from './paths.js'
import { compilePersonaPrompt } from './renderer.js'
import { validateMask } from './validator.js'

/**
 * Target coding agents the CLI can install/activate/remove against. The MVP
 * registry contains only Claude Code, with `claude` accepted as an alias.
 */
const AGENT_ALIASES: Record<string, string> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
}

function resolveAgent(agent: string | undefined): string {
  if (agent === undefined) return '<choose at command time>'
  return AGENT_ALIASES[agent] ?? agent
}

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
 * The multi-agent command shape is fixed from the start. `install`, `activate`,
 * and `remove` all accept `--agent <agent>` so later slices can fill in the
 * behavior without changing the CLI surface.
 */
function runReserved(command: string, rest: string[]): number {
  const { values } = parseArgs({
    args: rest,
    options: { agent: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const target = resolveAgent(values.agent)
  process.stderr.write(`persona ${command}: not yet implemented (target agent: ${target})\n`)
  return 1
}

const RESERVED_COMMANDS = new Set(['install', 'activate', 'remove'])

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  if (command === 'list') return runList()
  if (command === 'use') return runUse(rest)
  if (command === 'add') return runAdd(rest)
  if (command !== undefined && RESERVED_COMMANDS.has(command)) return runReserved(command, rest)

  process.stderr.write(`persona: unknown command: ${command ?? '(none)'}\n`)
  return 2
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`persona: unexpected error: ${String(err)}\n`)
  process.exit(1)
})
