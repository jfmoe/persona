/**
 * `persona add <source>` — import a persona mask (人格面具) from a local file,
 * local directory, or GitHub remote source into `~/.persona/<id>/` and record
 * the import in the 来源与内容账本 (source and content ledger,
 * `~/.persona/.lock.json`).
 *
 * Safety rules enforced here (not in the validator):
 *  - Path traversal and path-unsafe ids → hard fail
 *  - Any symlink inside a directory source → hard fail
 *
 * Content rules are delegated to `validateMask` (issue #3) per the validator
 * contract: "Source-path and symlink safety belong to `add`, not here."
 *
 * GitHub remote sources:
 *  - Detected when the source string does NOT start with `.`, `/`, or `~`
 *    and matches the GitHub shorthand / URL patterns.
 *  - Fetched via `git clone --depth 1` into a temp directory, then processed
 *    through the same local import pipeline.
 *  - The `PERSONA_GIT_REMOTE_BASE` environment variable overrides
 *    `https://github.com/` with an alternative base (e.g. `file:///tmp/repos/`)
 *    to enable zero-network integration tests.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
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

interface LocalLockEntry {
  sourceType: 'local'
  sourceUrl: string
  maskFolderHash: string
  importedAt: string
  updatedAt: string
}

interface GitHubLockEntry {
  sourceType: 'github'
  source: string
  sourceUrl: string
  ref?: string
  maskPath: string
  maskFolderHash: string
  importedAt: string
  updatedAt: string
}

type LockEntry = LocalLockEntry | GitHubLockEntry

interface LockFile {
  version: 1
  personas: Record<string, LockEntry>
}

// ─── GitHub source parsing ────────────────────────────────────────────────────

/**
 * Parsed representation of a GitHub source string.
 *
 * Produced by `parseGitHubSource`. All fields beyond `source` and `cloneUrl`
 * are optional — only set when the input explicitly specifies them.
 */
export interface ParsedGitHubSource {
  /** Canonical shorthand, e.g. `owner/repo`. */
  source: string
  /** HTTPS clone URL, e.g. `https://github.com/owner/repo.git`. */
  cloneUrl: string
  /** Requested Git ref (branch / tag / SHA). Undefined means default branch. */
  ref?: string
  /** Path inside the repo to the mask directory or file. Undefined means root. */
  subPath?: string
  /** Mask id to select when the source contains multiple masks. */
  personaId?: string
}

/**
 * Parse a GitHub source string into its components.
 *
 * Accepted forms:
 *   owner/repo
 *   owner/repo/path/to/mask
 *   owner/repo@id
 *   owner/repo#ref
 *   owner/repo#ref@id
 *   owner/repo/path/to/mask#ref@id
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/<ref>/path/to/mask
 *
 * Returns `null` when the input is clearly a local path (starts with `.`, `/`,
 * `~`) or does not look like a GitHub source.
 *
 * Pure function — no I/O. Exported for unit tests.
 */
export function parseGitHubSource(input: string): ParsedGitHubSource | null {
  // ── Local-path fast exits ────────────────────────────────────────────────
  if (input.startsWith('./') || input.startsWith('../') || input.startsWith('/') || input.startsWith('~')) {
    return null
  }

  // ── Full GitHub URL ──────────────────────────────────────────────────────
  const githubUrlPattern = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?(\/tree\/([^/]+)(\/(.+))?)?$/
  const urlMatch = input.match(githubUrlPattern)
  if (urlMatch) {
    const owner = urlMatch[1]!
    const repo = urlMatch[2]!
    const ref = urlMatch[5]
    const subPath = urlMatch[7]
    return {
      source: `${owner}/${repo}`,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      ...(ref !== undefined ? { ref } : {}),
      ...(subPath !== undefined ? { subPath } : {}),
    }
  }

  // ── Shorthand: owner/repo[/sub/path][#ref][@id] ──────────────────────────
  // Must start with "word/word" pattern (no protocol, no dots-only segments)
  // "owner" and "repo" must be non-empty valid GitHub name segments
  const shorthandPattern = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)((?:\/[^#@]+)*)?(#([^@]+))?(@(.+))?$/
  const shMatch = input.match(shorthandPattern)
  if (shMatch) {
    const owner = shMatch[1]!
    const repo = shMatch[2]!
    const subPathRaw = shMatch[3] // e.g. '/path/to/mask' or ''
    const ref = shMatch[5]
    const personaId = shMatch[7]

    const subPath = subPathRaw ? subPathRaw.replace(/^\//, '') : undefined

    return {
      source: `${owner}/${repo}`,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      ...(ref !== undefined ? { ref } : {}),
      ...(subPath ? { subPath } : {}),
      ...(personaId !== undefined ? { personaId } : {}),
    }
  }

  return null
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

// ─── shared import pipeline ───────────────────────────────────────────────────

/**
 * Options for the shared mask-import pipeline.
 */
interface ImportOptions {
  /** `--persona <id>` — pre-select a mask by id. */
  personaId: string | undefined
  /** `--force` — overwrite an existing mask without prompting. */
  force: boolean
  /** Lock entry to write. Built by the caller (local vs github). */
  buildLockEntry: (id: string, targetDir: string, existing: LockEntry | undefined) => LockEntry
}

/**
 * Shared pipeline: discover a mask inside `searchDir`, validate it, copy it
 * into `~/.persona/<id>/`, and write a lock entry.
 *
 * `searchDir` is treated as a local directory (symlink checks applied).
 * The `isSingleFile` flag is `true` when `searchDir` is actually a single
 * `persona.md` file path rather than a directory.
 */
async function importFromDirectory(
  searchDir: string,
  isSingleFile: boolean,
  opts: ImportOptions,
): Promise<number> {
  let candidate: MaskCandidate

  if (isSingleFile) {
    candidate = { dir: searchDir, file: searchDir }
  } else {
    // Check for symlinks anywhere inside the source directory
    const symlinkFound = findSymlink(searchDir)
    if (symlinkFound !== null) {
      process.stderr.write(
        `persona add: source directory contains a symlink, which is not allowed: ${symlinkFound}\n`,
      )
      return 1
    }

    // Try discovery: root level first (depth 0), then up to 2 levels
    const directCandidates = discoverMasks(searchDir, 0)
    if (directCandidates.length === 1 && directCandidates[0] !== undefined) {
      candidate = directCandidates[0]
    } else if (directCandidates.length === 0) {
      const shallowCandidates = discoverMasks(searchDir, 2)

      if (shallowCandidates.length === 0) {
        const deepCandidates = discoverMasks(searchDir, 10)
        if (deepCandidates.length > 0) {
          process.stderr.write(
            `persona add: persona masks were found but only at more than 2 levels deep — please provide a more specific source path\n`,
          )
        } else {
          process.stderr.write(
            `persona add: no persona.md found in ${searchDir}\n`,
          )
        }
        return 1
      }

      if (shallowCandidates.length > 1) {
        if (opts.personaId !== undefined) {
          const selected = selectFromMultiple(shallowCandidates, opts.personaId)
          if (selected === null) return 1
          candidate = selected
        } else if (process.stdin.isTTY) {
          const selected = await promptSelectCandidate(shallowCandidates)
          if (selected === null) return 1
          candidate = selected
        } else {
          const selected = selectFromMultiple(shallowCandidates, undefined)
          if (selected === null) return 1
          candidate = selected
        }
      } else {
        candidate = shallowCandidates[0]!
      }
    } else {
      // directCandidates.length > 1: multiple at root level
      if (opts.personaId !== undefined) {
        const selected = selectFromMultiple(directCandidates, opts.personaId)
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
  }

  // ── Validate the candidate mask ──────────────────────────────────────────

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

  const content = readFileSync(candidate.file, 'utf8')
  const parsed = parsePersonaMd(content)
  const id = parsed.frontmatter['id']!

  // ── Check for overwrite ───────────────────────────────────────────────────

  const home = personaHome()
  const targetDir = join(home, id)

  if (existsSync(targetDir) && !opts.force) {
    if (process.stdin.isTTY) {
      const confirmed = await promptOverwrite(id, targetDir)
      if (!confirmed) {
        process.stderr.write(`persona add: import cancelled\n`)
        return 1
      }
    } else {
      process.stderr.write(
        `persona add: mask "${id}" already exists at ${targetDir} — use --force to overwrite\n`,
      )
      return 1
    }
  }

  // ── Copy mask into ~/.persona/<id>/ ──────────────────────────────────────

  if (isSingleFile) {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(candidate.file, join(targetDir, 'persona.md'))
  } else {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
    cpSync(candidate.dir, targetDir, { recursive: true })
  }

  // ── Write lock entry (来源与内容账本) ────────────────────────────────────

  const lockPath = join(home, '.lock.json')
  const lock = readLock(lockPath)
  const existing = lock.personas[id]

  lock.personas[id] = opts.buildLockEntry(id, targetDir, existing)

  writeLock(lockPath, lock)

  return 0
}

// ─── GitHub import ────────────────────────────────────────────────────────────

/**
 * Resolve the actual clone base URL, applying the `PERSONA_GIT_REMOTE_BASE`
 * seam for zero-network testing.
 *
 * When `PERSONA_GIT_REMOTE_BASE` is set (e.g. `file:///tmp/repos/`), cloneUrl
 * `https://github.com/owner/repo.git` becomes
 * `file:///tmp/repos/owner/repo` (without `.git` for file:// protocol).
 */
function resolveCloneUrl(cloneUrl: string): string {
  const base = process.env['PERSONA_GIT_REMOTE_BASE']
  if (!base) return cloneUrl

  // Strip trailing slash from base, then rebuild
  const trimmedBase = base.replace(/\/$/, '')
  // cloneUrl is always https://github.com/owner/repo.git
  const match = cloneUrl.match(/github\.com\/(.+?)(?:\.git)?$/)
  if (!match) return cloneUrl
  const ownerRepo = match[1]!
  return `${trimmedBase}/${ownerRepo}`
}

/**
 * Import a GitHub source: shallow-clone to a temp dir, then run the shared
 * import pipeline. The temp dir is cleaned up regardless of success/failure.
 */
async function runAddGitHub(
  parsed: ParsedGitHubSource,
  personaId: string | undefined,
  force: boolean,
): Promise<number> {
  const cloneUrl = resolveCloneUrl(parsed.cloneUrl)
  const tmpDir = mkdtempSync(join(tmpdir(), 'persona-github-'))

  try {
    // ── Shallow clone ──────────────────────────────────────────────────────
    //
    // Every git argument is passed through a `spawnSync` argv array (never a
    // shell string), so a hostile `ref` like `main; rm -rf ~` cannot break out
    // into the shell.
    //
    // We fetch the requested ref explicitly instead of `git clone --branch`:
    // `--branch` only accepts branch/tag names, but a ref may also be a commit
    // SHA (the CLI does not classify ref types — fetch success is the only
    // validity test). `git fetch --depth 1 origin <ref>` shallow-fetches a
    // branch, tag, or reachable commit SHA uniformly; `HEAD` covers the
    // no-ref case (the remote's default branch).
    const fetchRef = parsed.ref ?? 'HEAD'
    const gitSteps: string[][] = [
      ['init', '-q', tmpDir],
      ['-C', tmpDir, 'remote', 'add', 'origin', cloneUrl],
      ['-C', tmpDir, 'fetch', '--depth', '1', 'origin', fetchRef],
      ['-C', tmpDir, 'checkout', '-q', '--detach', 'FETCH_HEAD'],
    ]
    for (const args of gitSteps) {
      const result = spawnSync('git', args, { stdio: 'pipe', encoding: 'utf8' })
      if (result.status !== 0) {
        const detail = (result.stderr || (result.error ? String(result.error) : '')).trim()
        const atRef = parsed.ref !== undefined ? ` at ref "${parsed.ref}"` : ''
        process.stderr.write(`persona add: failed to clone ${cloneUrl}${atRef}: ${detail}\n`)
        return 1
      }
    }

    // Drop the `.git` metadata directory before discovery/import: it must not
    // be scanned for symlinks, copied into the mask folder, or folded into
    // `maskFolderHash` (which would make the hash non-deterministic).
    rmSync(join(tmpDir, '.git'), { recursive: true, force: true })

    // ── Determine search root inside the clone ─────────────────────────────

    // personaId from `@id` syntax takes precedence over `--persona`, but both
    // end up in the same `personaId` parameter (the caller merges them).
    const effectivePersonaId = personaId

    const searchRoot = parsed.subPath ? join(tmpDir, parsed.subPath) : tmpDir

    if (!existsSync(searchRoot)) {
      process.stderr.write(
        `persona add: path "${parsed.subPath}" not found in ${cloneUrl}\n`,
      )
      return 1
    }

    const searchStat = lstatSync(searchRoot)
    const isSingleFile = searchStat.isFile()

    // ── Build the lock-entry factory for GitHub ─────────────────────────────

    const maskPath = parsed.subPath ?? ''
    const sourceUrl = `https://github.com/${parsed.source}.git`

    const buildLockEntry = (_id: string, targetDir: string, existing: LockEntry | undefined): GitHubLockEntry => {
      const now = new Date().toISOString()
      const maskFolderHash = computeFolderHash(targetDir)
      // Build with a stable field order (ref right after sourceUrl, matching
      // the interface and the PRD lock example) so serialized entries are
      // deterministic whether or not a ref is present.
      const entry: GitHubLockEntry = {
        sourceType: 'github',
        source: parsed.source,
        sourceUrl,
        ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}),
        maskPath,
        maskFolderHash,
        importedAt: existing?.importedAt ?? now,
        updatedAt: now,
      }
      return entry
    }

    return await importFromDirectory(searchRoot, isSingleFile, {
      personaId: effectivePersonaId,
      force,
      buildLockEntry,
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ─── main command ─────────────────────────────────────────────────────────────

/**
 * `persona add <source>` — validate and import a persona mask.
 *
 * Source can be:
 *   - A local file path (absolute or relative, starting with `.`, `/`, or `~`)
 *   - A local directory path
 *   - A GitHub shorthand: `owner/repo`, `owner/repo/path`, `owner/repo@id`,
 *     `owner/repo#ref@id`
 *   - A full GitHub URL: `https://github.com/owner/repo/tree/<ref>/path`
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

  // ── Route: GitHub vs local ───────────────────────────────────────────────

  const githubSource = parseGitHubSource(sourcePath)
  if (githubSource !== null) {
    // Merge @id from source shorthand with --persona flag (--persona wins on
    // conflict, but both express the same intent)
    const personaId = values.persona ?? githubSource.personaId
    return runAddGitHub(githubSource, personaId, values.force ?? false)
  }

  // ── Local source path ────────────────────────────────────────────────────

  const resolvedSource = resolve(sourcePath)

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

  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    process.stderr.write(`persona add: source is neither a file nor a directory: ${resolvedSource}\n`)
    return 1
  }

  const isSingleFile = sourceStat.isFile()

  return importFromDirectory(resolvedSource, isSingleFile, {
    personaId: values.persona,
    force: values.force ?? false,
    buildLockEntry: (_id, targetDir, existing) => {
      const now = new Date().toISOString()
      const maskFolderHash = computeFolderHash(targetDir)
      return {
        sourceType: 'local',
        sourceUrl: resolvedSource,
        maskFolderHash,
        importedAt: existing?.importedAt ?? now,
        updatedAt: now,
      }
    },
  })
}
