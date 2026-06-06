#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { listMaskIds } from './library.js'
import { personaHome } from './paths.js'

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

function main(argv: string[]): number {
  const [command, ...rest] = argv

  if (command === 'list') return runList()
  if (command !== undefined && RESERVED_COMMANDS.has(command)) return runReserved(command, rest)

  process.stderr.write(`persona: unknown command: ${command ?? '(none)'}\n`)
  return 2
}

process.exit(main(process.argv.slice(2)))
