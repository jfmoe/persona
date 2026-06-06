/**
 * `persona add <source>` — import a local persona mask (人格面具) from a file or
 * directory into `~/.persona/<id>/` and record the import in the
 * 来源与内容账本 (source and content ledger, `~/.persona/.lock.json`).
 *
 * Scope: local sources only (ADR-0003). GitHub remote sources are handled by a
 * separate command slice (#5).
 *
 * Safety rules enforced here (not in the validator):
 *  - Path traversal and path-unsafe ids → hard fail
 *  - Any symlink inside a directory source → hard fail
 *
 * Content rules are delegated to `validateMask` (issue #3) per the validator
 * contract: "Source-path and symlink safety belong to `add`, not here."
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { dirname, join, resolve, basename } from 'node:path'
import { parseArgs } from 'node:util'
import { parsePersonaMd } from './persona-md.js'
import { personaHome } from './paths.js'
import { validateMask } from './validator.js'

// ─── types ───────────────────────────────────────────────────────────────────

/** A discovered mask candidate: the directory containing `persona.md`. */
interface MaskCandidate {
  /** Absolute path to the directory containing `persona.md`. */
  dir: string
  /** Absolute path to the `persona.md` file. */
  file: string
}

// ─── lock file types ─────────────────────────────────────────────────────────

interface LockEntry {
  sourceType: 'local'
  sourceUrl: string
  maskFolderHash: string
  importedAt: string
  updatedAt: string
}

interface LockFile {
  version: 1
  personas: Record<string, LockEntry>
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * A mask id is path-safe when it contains only ASCII alphanumerics, hyphens,
 * underscores, and dots — no slashes, no dots at the start, no empty segments.
 * This prevents path traversal via the id (ADR-0003).
 */
function isPathSafeId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) && !id.includes('/') && !id.includes('\\')
}

/**
 * Recursively check that a directory contains no symlinks (any level).
 * Returns the first symlink path found, or null if clean.
 */
function findSymlink(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findSymlink(join(dir, entry.name))
      if (found !== null) return found
    }
  }
  return null
}

/**
 * Compute the sha256 hash of every file under `dir` (or for a single file),
 * sorted by relative path for determinism. Returns hex digest.
 */
function computeFolderHash(dirOrFile: string): string {
  const hash = createHash('sha256')
  const stat = lstatSync(dirOrFile)

  if (stat.isFile()) {
    hash.update(readFileSync(dirOrFile))
    return hash.digest('hex')
  }

  // Directory: collect all files sorted by relative path
  const files: Array<{ rel: string; abs: string }> = []

  function collect(dir: string, rel: string): void {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absPath = join(dir, entry.name)
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        collect(absPath, relPath)
      } else if (entry.isFile()) {
        files.push({ rel: relPath, abs: absPath })
      }
    }
  }

  collect(dirOrFile, '')

  for (const { rel, abs } of files) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(abs))
    hash.update('\0')
  }

  return hash.digest('hex')
}

/**
 * Discover `persona.md` files in a directory up to `maxDepth` levels.
 * Returns an array of MaskCandidates (the directory containing each
 * `persona.md`). Depth 0 = the directory itself.
 */
function discoverMasks(dir: string, maxDepth: number, currentDepth = 0): MaskCandidate[] {
  const personaMdPath = join(dir, 'persona.md')
  if (existsSync(personaMdPath)) {
    return [{ dir, file: personaMdPath }]
  }

  if (currentDepth >= maxDepth) return []

  const results: MaskCandidate[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name)
      results.push(...discoverMasks(sub, maxDepth, currentDepth + 1))
    }
  }
  return results
}

/** Read and validate a `persona.md` file; return errors or the validated mask. */
function validatePersonaMdFile(file: string): { id: string; errors: string[] } | null {
  const content = readFileSync(file, 'utf8')
  const parsed = parsePersonaMd(content)
  const errors = validateMask(parsed)

  if (errors.length > 0) return { id: parsed.frontmatter['id'] ?? '', errors: errors.map((e) => e.message) }

  const id = parsed.frontmatter['id']
  if (!id || !isPathSafeId(id)) {
    return {
      id: id ?? '',
      errors: [`persona mask id "${id}" is not path-safe (no slashes, must start with alphanumeric)`],
    }
  }

  return null // null means valid
}

/**
 * From a list of candidates, select the one matching `personaId` (if given),
 * or fail if multiple are found in non-interactive mode.
 * Returns the selected candidate, or null if a hard-fail message was emitted.
 */
function selectFromMultiple(
  candidates: MaskCandidate[],
  personaId: string | undefined,
): MaskCandidate | null {
  if (personaId !== undefined) {
    const selected = candidates.find((c) => {
      const parsed = parsePersonaMd(readFileSync(c.file, 'utf8'))
      return parsed.frontmatter['id'] === personaId
    })
    if (selected === undefined) {
      process.stderr.write(`persona add: no mask with id "${personaId}" found in source\n`)
      return null
    }
    return selected
  }

  // Non-interactive hard fail: list available ids
  const ids = candidates
    .map((c) => parsePersonaMd(readFileSync(c.file, 'utf8')).frontmatter['id'] ?? basename(c.dir))
    .sort()
  process.stderr.write(
    `persona add: source contains multiple persona masks — use --persona <id> or provide a more specific path\n`,
  )
  process.stderr.write(`Available persona ids:\n`)
  for (const id of ids) {
    process.stderr.write(`  ${id}\n`)
  }
  return null
}

// ─── interactive helpers (pure logic — unit-testable) ─────────────────────────

/**
 * Parse a 1-based numeric choice from `input` against a list of `count` items.
 * Returns the 0-based index if the input is a valid integer in [1, count], or
 * `null` if the input is invalid.
 *
 * Pure function — no I/O. Exported for unit tests.
 */
export function parseChoice(input: string, count: number): number | null {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = parseInt(trimmed, 10)
  if (n < 1 || n > count) return null
  return n - 1 // convert to 0-based
}

/**
 * Parse a yes/no confirmation from `input`.
 * Returns `true` for "y" / "yes" (case-insensitive), `false` for anything else
 * (including empty input → default No).
 *
 * Pure function — no I/O. Exported for unit tests.
 */
export function parseYesNo(input: string): boolean {
  const trimmed = input.trim().toLowerCase()
  return trimmed === 'y' || trimmed === 'yes'
}

/**
 * Prompt the user to choose from `candidates` interactively.
 * Writes the numbered list to stdout and reads a line from stdin.
 * Returns the selected candidate, or `null` if the user gives invalid input.
 */
async function promptSelectCandidate(candidates: MaskCandidate[]): Promise<MaskCandidate | null> {
  const ids = candidates.map((c) => {
    const parsed = parsePersonaMd(readFileSync(c.file, 'utf8'))
    return parsed.frontmatter['id'] ?? basename(c.dir)
  })

  process.stdout.write('persona add: source contains multiple persona masks.\n')
  process.stdout.write('Select one:\n')
  for (let i = 0; i < ids.length; i++) {
    process.stdout.write(`  ${i + 1}) ${ids[i]}\n`)
  }
  process.stdout.write(`Enter number [1-${ids.length}]: `)

  const answer = await readOneLine()
  const idx = parseChoice(answer, candidates.length)
  if (idx === null) {
    process.stderr.write(`persona add: invalid selection "${answer.trim()}"\n`)
    return null
  }
  return candidates[idx]!
}

/**
 * Prompt the user to confirm an overwrite interactively.
 * Returns `true` if the user confirms.
 */
async function promptOverwrite(id: string, targetDir: string): Promise<boolean> {
  process.stdout.write(
    `persona add: mask "${id}" already exists at ${targetDir}\nOverwrite? [y/N] `,
  )
  const answer = await readOneLine()
  return parseYesNo(answer)
}

/**
 * Read a single line from stdin (resolves immediately when the user hits Enter).
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

/** Read the lock file, or return an empty ledger. */
function readLock(lockPath: string): LockFile {
  if (!existsSync(lockPath)) return { version: 1, personas: {} }
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
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

/** Write the lock file with personas keys sorted. */
function writeLock(lockPath: string, lock: LockFile): void {
  const sorted: LockFile = {
    version: lock.version,
    personas: Object.fromEntries(
      Object.entries(lock.personas).sort(([a], [b]) => a.localeCompare(b)),
    ),
  }
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
}

// ─── main command ─────────────────────────────────────────────────────────────

/**
 * `persona add <source>` — validate and import a local persona mask.
 *
 * Options:
 *   --persona <id>   Select a specific mask from a multi-mask source
 *   --force          Overwrite an existing mask in ~/.persona/
 *
 * Interactive behaviour (only when `process.stdin.isTTY === true`):
 *   - Multiple masks found and --persona not given: numbered selection prompt.
 *   - Target already exists and --force not given: y/N overwrite prompt.
 */
export async function runAdd(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      persona: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  const sourcePath = positionals[0]
  if (sourcePath === undefined) {
    process.stderr.write('persona add: missing source path\n')
    return 2
  }

  const resolvedSource = resolve(sourcePath)

  // ── 1. Check source exists ──────────────────────────────────────────────

  if (!existsSync(resolvedSource)) {
    process.stderr.write(`persona add: source does not exist: ${resolvedSource}\n`)
    return 1
  }

  const sourceStat = lstatSync(resolvedSource)

  // Symlinks at the source root are also banned (任意 symlink 一律硬失败).
  if (sourceStat.isSymbolicLink()) {
    process.stderr.write(
      `persona add: source path is a symlink, which is not allowed: ${resolvedSource}\n`,
    )
    return 1
  }

  // ── 2. Determine the mask candidate ─────────────────────────────────────

  let candidate: MaskCandidate
  let isSingleFile = false

  if (sourceStat.isFile()) {
    // Single-file import: the file itself is the persona.md
    candidate = { dir: resolvedSource, file: resolvedSource }
    isSingleFile = true
  } else if (sourceStat.isDirectory()) {
    // Check for symlinks anywhere inside the source directory
    const symlinkFound = findSymlink(resolvedSource)
    if (symlinkFound !== null) {
      process.stderr.write(
        `persona add: source directory contains a symlink, which is not allowed: ${symlinkFound}\n`,
      )
      return 1
    }

    // Try discovery: root level first (depth 0), then up to 2 levels
    const directCandidates = discoverMasks(resolvedSource, 0)
    if (directCandidates.length === 1 && directCandidates[0] !== undefined) {
      // Directory itself has persona.md → single mask
      candidate = directCandidates[0]
    } else if (directCandidates.length === 0) {
      // Go deeper — up to 2 levels
      const shallowCandidates = discoverMasks(resolvedSource, 2)

      if (shallowCandidates.length === 0) {
        // Check if there are any deeper (> 2 levels)
        const deepCandidates = discoverMasks(resolvedSource, 10)
        if (deepCandidates.length > 0) {
          process.stderr.write(
            `persona add: persona masks were found but only at more than 2 levels deep — please provide a more specific source path\n`,
          )
        } else {
          process.stderr.write(
            `persona add: no persona.md found in ${resolvedSource}\n`,
          )
        }
        return 1
      }

      // Multiple masks found
      if (shallowCandidates.length > 1) {
        if (values.persona !== undefined) {
          // --persona given: filter by id (synchronous)
          const selected = selectFromMultiple(shallowCandidates, values.persona)
          if (selected === null) return 1
          candidate = selected
        } else if (process.stdin.isTTY) {
          // Interactive selection
          const selected = await promptSelectCandidate(shallowCandidates)
          if (selected === null) return 1
          candidate = selected
        } else {
          // Non-interactive hard fail
          const selected = selectFromMultiple(shallowCandidates, undefined)
          if (selected === null) return 1
          candidate = selected
        }
      } else {
        candidate = shallowCandidates[0]!
      }
    } else {
      // directCandidates.length > 1: multiple at root level
      if (values.persona !== undefined) {
        const selected = selectFromMultiple(directCandidates, values.persona)
        if (selected === null) return 1
        candidate = selected
      } else if (process.stdin.isTTY) {
        const selected = await promptSelectCandidate(directCandidates)
        if (selected === null) return 1
        candidate = selected
      } else {
        const selected = selectFromMultiple(directCandidates, undefined)
        if (selected === null) return 1
        candidate = selected
      }
    }
  } else {
    process.stderr.write(`persona add: source is neither a file nor a directory: ${resolvedSource}\n`)
    return 1
  }

  // ── 3. Validate the candidate mask ──────────────────────────────────────

  const validationResult = validatePersonaMdFile(candidate.file)
  if (validationResult !== null) {
    process.stderr.write(
      `persona add: ${candidate.file} is not a valid persona mask:\n`,
    )
    for (const msg of validationResult.errors) {
      process.stderr.write(`  - ${msg}\n`)
    }
    return 1
  }

  // Re-parse for id (already validated above)
  const content = readFileSync(candidate.file, 'utf8')
  const parsed = parsePersonaMd(content)
  const id = parsed.frontmatter['id']!

  // ── 4. Check for overwrite ───────────────────────────────────────────────

  const home = personaHome()
  const targetDir = join(home, id)

  if (existsSync(targetDir) && !values.force) {
    if (process.stdin.isTTY) {
      // Interactive: ask the user
      const confirmed = await promptOverwrite(id, targetDir)
      if (!confirmed) {
        process.stderr.write(`persona add: import cancelled\n`)
        return 1
      }
    } else {
      // Non-interactive hard fail
      process.stderr.write(
        `persona add: mask "${id}" already exists at ${targetDir} — use --force to overwrite\n`,
      )
      return 1
    }
  }

  // ── 5. Copy mask into ~/.persona/<id>/ ──────────────────────────────────

  if (isSingleFile) {
    // Single-file import: remove any existing targetDir first (to avoid stale
    // files from a previous directory import), then create fresh and copy.
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(candidate.file, join(targetDir, 'persona.md'))
  } else {
    // Directory import: remove existing targetDir first so that files present
    // in the old source but absent from the new source do not linger.
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
    cpSync(candidate.dir, targetDir, { recursive: true })
  }

  // ── 6. Write lock entry (来源与内容账本) ────────────────────────────────

  const lockPath = join(home, '.lock.json')
  const lock = readLock(lockPath)

  const now = new Date().toISOString()
  const existing = lock.personas[id]
  const maskFolderHash = computeFolderHash(targetDir)

  lock.personas[id] = {
    sourceType: 'local',
    sourceUrl: resolvedSource,
    maskFolderHash,
    importedAt: existing?.importedAt ?? now,
    updatedAt: now,
  }

  writeLock(lockPath, lock)

  return 0
}
