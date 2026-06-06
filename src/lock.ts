/**
 * Shared lock-file (来源与内容账本) read/write helpers.
 *
 * The lock file lives at `~/.persona/.lock.json` and records where each
 * imported persona mask came from (ADR-0003). Both `persona add` and
 * `persona remove` need consistent read/write behaviour, so this module
 * provides a single source of truth for both commands.
 */

import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { personaHome } from './paths.js'

// ─── types ───────────────────────────────────────────────────────────────────

/** A locally-imported mask: `sourceUrl` is the resolved absolute path. */
export interface LocalLockEntry {
  sourceType: 'local'
  sourceUrl: string
  maskFolderHash: string
  importedAt: string
  updatedAt: string
}

/** A mask imported from a GitHub remote source. */
export interface GitHubLockEntry {
  sourceType: 'github'
  source: string
  sourceUrl: string
  ref?: string
  maskPath: string
  maskFolderHash: string
  importedAt: string
  updatedAt: string
}

export type LockEntry = LocalLockEntry | GitHubLockEntry

export interface LockFile {
  version: 1
  personas: Record<string, LockEntry>
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Return the canonical path of the persona lock file under `home`.
 * Defaults to `personaHome()` when called without an argument.
 */
export function lockPath(home?: string): string {
  return join(home ?? personaHome(), '.lock.json')
}

/**
 * Read and validate the lock file at `path`.
 *
 * Returns an empty ledger (`{ version: 1, personas: {} }`) when the file does
 * not exist, cannot be read, or contains data that does not match the expected
 * shape. Callers never need to handle a malformed lock — the write path always
 * produces a well-formed file and a corrupt lock is treated as "no lock".
 */
export function readLock(path: string): LockFile {
  if (!existsSync(path)) return { version: 1, personas: {} }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'personas' in parsed &&
      typeof (parsed as Record<string, unknown>)['personas'] === 'object' &&
      (parsed as Record<string, unknown>)['personas'] !== null &&
      !Array.isArray((parsed as Record<string, unknown>)['personas'])
    ) {
      return parsed as LockFile
    }
    return { version: 1, personas: {} }
  } catch {
    return { version: 1, personas: {} }
  }
}

/**
 * Serialise `lock` to `path` with persona keys sorted alphabetically.
 *
 * Creates parent directories when they do not already exist. Writing is
 * non-destructive for keys outside `lock.personas`: the caller controls the
 * full `LockFile` value that is written.
 */
export function writeLock(path: string, lock: LockFile): void {
  const sorted: LockFile = {
    version: lock.version,
    personas: Object.fromEntries(
      Object.entries(lock.personas).sort(([a], [b]) => a.localeCompare(b)),
    ),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
}
