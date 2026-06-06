/**
 * Integration tests for `persona add <source>` — local source (file + directory)
 * + two-level discovery + lock file (来源与内容账本).
 *
 * All tests drive the real CLI via the harness and assert only external
 * observable behaviour: filesystem side-effects, stdout/stderr, exit codes,
 * and lock file structure.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './harness.js'
import { VALID_PERSONA_MD } from './fixtures.js'

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a source directory at an absolute path. */
function mkSourceDir(base: string, relPath: string): string {
  const dir = join(base, relPath)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Write a file inside `dir` and return the file path. */
function writeIn(dir: string, name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('persona add — local source', () => {
  let h: Harness
  let sourceRoot: string

  beforeEach(() => {
    h = createHarness()
    // Each test gets its own source directory under the temp home.
    sourceRoot = join(h.home, 'sources')
    mkdirSync(sourceRoot, { recursive: true })
  })

  afterEach(() => {
    h.cleanup()
  })

  // ── Slice 1: single-file import ──────────────────────────────────────────

  it('imports a single valid persona.md file into ~/.persona/<id>/persona.md', () => {
    const maskFile = writeIn(sourceRoot, 'senpai-rust.md', VALID_PERSONA_MD)

    const { code, stderr } = h.run(['add', maskFile])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
    expect(h.readFile('.persona/senpai-rust/persona.md')).toBe(VALID_PERSONA_MD)
  })

  it('exits 1 and reports validation errors when the source file is not a valid persona mask', () => {
    const bad = `---\nid: bad-mask\n---\n\n## Linguistic Style\nbad\n`
    const maskFile = writeIn(sourceRoot, 'bad.md', bad)

    const { code, stderr } = h.run(['add', maskFile])

    expect(code).toBe(1)
    expect(stderr).toMatch(/not a valid persona mask/i)
    expect(h.exists('.persona/bad-mask')).toBe(false)
  })

  it('exits 1 when the source file has no id in frontmatter', () => {
    const noId = VALID_PERSONA_MD.replace('id: senpai-rust\n', '')
    const maskFile = writeIn(sourceRoot, 'no-id.md', noId)

    const { code, stderr } = h.run(['add', maskFile])

    expect(code).toBe(1)
    expect(stderr).toMatch(/not a valid persona mask/i)
  })

  it('exits 1 when the source path does not exist', () => {
    const { code, stderr } = h.run(['add', join(sourceRoot, 'nonexistent.md')])

    expect(code).toBe(1)
    expect(stderr).toMatch(/not found|does not exist/i)
  })

  it('exits 1 when the source file id contains path-unsafe characters', () => {
    const unsafe = VALID_PERSONA_MD.replace('id: senpai-rust', 'id: ../evil')
    const maskFile = writeIn(sourceRoot, 'unsafe.md', unsafe)

    const { code, stderr } = h.run(['add', maskFile])

    expect(code).toBe(1)
    expect(stderr).toMatch(/unsafe|invalid|path/i)
  })

  // ── Slice 2: directory import — directory itself has persona.md ──────────

  it('imports a directory that directly contains persona.md as a single mask', () => {
    const dir = mkSourceDir(sourceRoot, 'senpai-dir')
    writeIn(dir, 'persona.md', VALID_PERSONA_MD)
    writeIn(dir, 'memory.md', 'extra file')

    const { code, stderr } = h.run(['add', dir])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
    expect(h.exists('.persona/senpai-rust/memory.md')).toBe(true)
  })

  // ── Slice 3: two-level discovery ─────────────────────────────────────────

  it('discovers a persona.md one level deep inside a directory and imports the mask subdirectory', () => {
    const outer = mkSourceDir(sourceRoot, 'collection')
    const inner = mkSourceDir(outer, 'senpai-rust')
    writeIn(inner, 'persona.md', VALID_PERSONA_MD)
    writeIn(inner, 'memory.md', 'level-1 extra')

    const { code, stderr } = h.run(['add', outer])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
    expect(h.exists('.persona/senpai-rust/memory.md')).toBe(true)
  })

  it('discovers a persona.md two levels deep inside a directory and imports the mask subdirectory', () => {
    const outer = mkSourceDir(sourceRoot, 'collection')
    const mid = mkSourceDir(outer, 'group')
    const inner = mkSourceDir(mid, 'senpai-rust')
    writeIn(inner, 'persona.md', VALID_PERSONA_MD)

    const { code } = h.run(['add', outer])

    expect(code).toBe(0)
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
  })

  it('errors with a "more specific path" message when masks are only 3+ levels deep', () => {
    const outer = mkSourceDir(sourceRoot, 'deep')
    const l1 = mkSourceDir(outer, 'l1')
    const l2 = mkSourceDir(l1, 'l2')
    const l3 = mkSourceDir(l2, 'senpai-rust')
    writeIn(l3, 'persona.md', VALID_PERSONA_MD)

    const { code, stderr } = h.run(['add', outer])

    expect(code).toBe(1)
    expect(stderr).toMatch(/specific/i)
  })

  // ── Slice 4: multi-mask directory — non-interactive ──────────────────────

  it('hard-fails in non-interactive mode when the directory contains multiple persona masks and lists available ids', () => {
    const dir = mkSourceDir(sourceRoot, 'multi')

    // mask A
    const dirA = mkSourceDir(dir, 'senpai-rust')
    writeIn(dirA, 'persona.md', VALID_PERSONA_MD)

    // mask B — different id
    const maskBContent = VALID_PERSONA_MD
      .replace('id: senpai-rust', 'id: kohai-ts')
      .replace('name: 锈学姐', 'name: TS 后辈')
    const dirB = mkSourceDir(dir, 'kohai-ts')
    writeIn(dirB, 'persona.md', maskBContent)

    const { code, stderr } = h.run(['add', dir])

    expect(code).toBe(1)
    expect(stderr).toMatch(/senpai-rust/)
    expect(stderr).toMatch(/kohai-ts/)
    expect(stderr).toMatch(/--persona/i)
  })

  it('imports a specific mask from a multi-mask directory with --persona <id>', () => {
    const dir = mkSourceDir(sourceRoot, 'multi')

    const dirA = mkSourceDir(dir, 'senpai-rust')
    writeIn(dirA, 'persona.md', VALID_PERSONA_MD)

    const maskBContent = VALID_PERSONA_MD
      .replace('id: senpai-rust', 'id: kohai-ts')
      .replace('name: 锈学姐', 'name: TS 后辈')
    const dirB = mkSourceDir(dir, 'kohai-ts')
    writeIn(dirB, 'persona.md', maskBContent)

    const { code, stderr } = h.run(['add', dir, '--persona', 'senpai-rust'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
    expect(h.exists('.persona/kohai-ts')).toBe(false)
  })

  // ── Slice 5: path traversal & symlink safety ─────────────────────────────

  it('hard-fails when the source path does not exist (includes path-traversal attempts)', () => {
    // A traversal attempt that lands on a nonexistent path.
    const traversal = join(sourceRoot, '..', '..', '..', 'definitely-no-such-file.md')
    const { code, stderr } = h.run(['add', traversal])

    expect(code).toBe(1)
    expect(stderr).toMatch(/not found|does not exist/i)
  })

  it('hard-fails when the source directory contains a symlink', () => {
    const dir = mkSourceDir(sourceRoot, 'with-symlink')
    writeIn(dir, 'persona.md', VALID_PERSONA_MD)
    // Create a symlink inside the mask directory
    symlinkSync('/etc/passwd', join(dir, 'evil-link'))

    const { code, stderr } = h.run(['add', dir])

    expect(code).toBe(1)
    expect(stderr).toMatch(/symlink/i)
  })

  // ── Slice 6: overwrite protection ────────────────────────────────────────

  it('hard-fails in non-interactive mode when the target mask already exists (no --force)', () => {
    h.seedMask('senpai-rust')

    const maskFile = writeIn(sourceRoot, 'senpai.md', VALID_PERSONA_MD)
    const { code, stderr } = h.run(['add', maskFile])

    expect(code).toBe(1)
    expect(stderr).toMatch(/already exists/i)
  })

  it('overwrites when the target already exists and --force is passed', () => {
    h.seedMask('senpai-rust', { 'persona.md': '# old' })

    const maskFile = writeIn(sourceRoot, 'senpai.md', VALID_PERSONA_MD)
    const { code } = h.run(['add', maskFile, '--force'])

    expect(code).toBe(0)
    expect(h.readFile('.persona/senpai-rust/persona.md')).toBe(VALID_PERSONA_MD)
  })

  // ── Slice 7: lock file (来源与内容账本) ──────────────────────────────────

  it('writes a lock entry with sourceType "local" and an absolute sourceUrl after import', () => {
    const maskFile = writeIn(sourceRoot, 'senpai.md', VALID_PERSONA_MD)

    h.run(['add', maskFile])

    expect(h.exists('.persona/.lock.json')).toBe(true)
    const lock = JSON.parse(h.readFile('.persona/.lock.json'))
    expect(lock.version).toBe(1)
    expect(lock.personas['senpai-rust']).toBeDefined()
    const entry = lock.personas['senpai-rust']
    expect(entry.sourceType).toBe('local')
    expect(entry.sourceUrl).toBe(maskFile) // resolved absolute path
    expect(entry.maskFolderHash).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
    expect(entry.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('updates the lock entry (updatedAt) when a mask is re-imported with --force', () => {
    const maskFile = writeIn(sourceRoot, 'senpai.md', VALID_PERSONA_MD)

    h.run(['add', maskFile])
    const lock1 = JSON.parse(h.readFile('.persona/.lock.json'))
    const firstImportedAt = lock1.personas['senpai-rust'].importedAt

    h.run(['add', maskFile, '--force'])
    const lock2 = JSON.parse(h.readFile('.persona/.lock.json'))

    expect(lock2.personas['senpai-rust'].importedAt).toBe(firstImportedAt)
    expect(lock2.personas['senpai-rust'].updatedAt).toBeDefined()
  })

  it('writes lock personas keys in sorted order', () => {
    // Import two masks — keys in the lock must be alphabetically sorted.
    const maskFile = writeIn(sourceRoot, 'senpai.md', VALID_PERSONA_MD)
    const maskBContent = VALID_PERSONA_MD
      .replace('id: senpai-rust', 'id: alpha-mask')
      .replace('name: 锈学姐', 'name: Alpha')
    const maskFileB = writeIn(sourceRoot, 'alpha.md', maskBContent)

    h.run(['add', maskFile])
    h.run(['add', maskFileB])

    const raw = h.readFile('.persona/.lock.json')
    const lock = JSON.parse(raw)
    const keys = Object.keys(lock.personas)
    expect(keys).toEqual([...keys].sort())
  })

  // ── Slice 8: manually placed masks remain first-class ────────────────────

  it('does not break list for manually placed masks that have no lock entry', () => {
    // Seed a mask directly (bypassing `add`) — no lock entry.
    h.seedMask('hand-placed')

    const { stdout, code } = h.run(['list'])

    expect(code).toBe(0)
    expect(stdout).toContain('hand-placed')
  })

  it('does not break use for manually placed masks that have no lock entry', () => {
    // Full valid mask seeded manually.
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })

    const { code } = h.run(['use', 'senpai-rust'])

    expect(code).toBe(0)
  })
})
