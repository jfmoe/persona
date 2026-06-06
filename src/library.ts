import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * List the ids of every persona mask in the library directory.
 *
 * A subdirectory is a persona mask if and only if it contains `persona.md`.
 * Imported masks and manually placed masks are discovered the same way — the
 * source and content ledger does not create a managed/unmanaged split here
 * (ADR-0003).
 */
export function listMaskIds(personaDir: string): string[] {
  if (!existsSync(personaDir)) return []
  return readdirSync(personaDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(personaDir, entry.name, 'persona.md')))
    .map((entry) => entry.name)
    .sort()
}
