import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..')
const CLI_ENTRY = resolve(REPO_ROOT, 'src', 'cli.ts')
const TMP_ROOT = realpathSync(tmpdir())
// Resolve the tsx ESM loader via Node's module resolution from this file's
// location so it works even when node_modules lives in a parent directory
// (e.g. git worktrees). Using the absolute path ensures the loader is found
// when the spawned process's cwd is outside the repo root (--project tests).
const TSX_ESM_LOADER = createRequire(import.meta.url).resolve('tsx/esm')

/** Captured result of one `persona` invocation. */
export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export interface RunOptions {
  /** Working directory for the spawned process. Defaults to the repo root. */
  cwd?: string
}

/**
 * Integration test harness for the `persona` CLI.
 *
 * Every harness gets its own throwaway HOME so the real `~/.persona` and
 * `~/.claude` are never read or written. It drives the real CLI as a child
 * process and captures stdout, stderr, and the exit code, and exposes helpers
 * to seed persona masks and assert filesystem side effects.
 */
export interface Harness {
  /** The temp HOME this harness operates under. */
  readonly home: string
  /** `<home>/.persona` — the persona mask library directory. */
  readonly personaDir: string
  /** `<home>/.claude` — Claude Code's user-level config directory. */
  readonly claudeDir: string
  /** Run `persona <args...>` under this harness's HOME. */
  run(args: string[], opts?: RunOptions): RunResult
  /**
   * Seed a persona mask at `~/.persona/<id>/`. By default writes a minimal
   * `persona.md` so the directory is discoverable as a mask. Pass `files` to
   * control the contents; omit `persona.md` from `files` to seed a directory
   * that is deliberately *not* a mask.
   */
  seedMask(id: string, files?: Record<string, string>): void
  /** Write a file relative to HOME, creating parent directories. */
  writeFile(relToHome: string, content: string): void
  /** Read a file relative to HOME. */
  readFile(relToHome: string): string
  /** Whether a path relative to HOME exists. */
  exists(relToHome: string): boolean
  /** Remove the temp HOME. */
  cleanup(): void
}

const DEFAULT_PERSONA_MD = `---
id: PLACEHOLDER
name: Placeholder Mask
description: A seeded persona mask for tests.
self_address: 测试者
user_address: 用户
---

## Linguistic Style
seeded
`

export function createHarness(): Harness {
  const home = mkdtempSync(join(TMP_ROOT, 'persona-test-'))
  const personaDir = join(home, '.persona')
  const claudeDir = join(home, '.claude')

  const abs = (relToHome: string): string => join(home, relToHome)

  return {
    home,
    personaDir,
    claudeDir,

    run(args, opts = {}): RunResult {
      const result = spawnSync(process.execPath, ['--import', TSX_ESM_LOADER, CLI_ENTRY, ...args], {
        cwd: opts.cwd ?? REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
        },
      })
      if (result.error) throw result.error
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        code: result.status ?? -1,
      }
    },

    seedMask(id, files): void {
      const maskDir = join(personaDir, id)
      mkdirSync(maskDir, { recursive: true })
      const contents = files ?? { 'persona.md': DEFAULT_PERSONA_MD.replace('PLACEHOLDER', id) }
      for (const [name, content] of Object.entries(contents)) {
        const target = join(maskDir, name)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content)
      }
    },

    writeFile(relToHome, content): void {
      const target = abs(relToHome)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    },

    readFile(relToHome): string {
      return readFileSync(abs(relToHome), 'utf8')
    },

    exists(relToHome): boolean {
      return existsSync(abs(relToHome))
    },

    cleanup(): void {
      // Defense in depth: never rm anything outside the temp root.
      const realHome = realpathSync(home)
      if (!realHome.startsWith(TMP_ROOT) || !realHome.includes('persona-test-')) {
        throw new Error(`refusing to clean up suspicious harness HOME: ${realHome}`)
      }
      rmSync(home, { recursive: true, force: true })
    },
  }
}
