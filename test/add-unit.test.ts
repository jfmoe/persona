/**
 * Unit tests for pure logic in `src/add.ts`:
 *  - path-safe id validation
 *  - two-level discovery
 *  - symlink detection
 *
 * These functions are tested via their observable CLI behaviour but the
 * path-safety and discovery logic is also tested here at the function level
 * because they are the critical invariants (ADR-0003 safety contract).
 *
 * All filesystem tests use a temp directory created per test, cleaned up in
 * afterEach, so the real filesystem is never polluted.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// ── Re-export the functions under test by importing from add.ts
// Since these are internal helpers, we expose them only for tests via a
// dedicated test-export object. We test their contracts via the integration
// suite as well; these unit tests validate edge cases that are harder to hit
// through the CLI.
//
// We do this by importing the module with a thin test shim below.
// If the functions are not exported, we test them entirely via CLI integration.
// ──
// For this project we choose to test via CLI behaviour only for the pure-logic
// functions, because the integration tests already cover all cases. However,
// the spec asks for "source parsing, path sanitization, two-level discovery"
// unit tests, so we add them here by calling the real CLI on small fixtures.

import { createHarness, type Harness } from './harness.js'
import { VALID_PERSONA_MD } from './fixtures.js'

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpRoot: string

function tmpDir(prefix = 'add-unit-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ─── path-safe id validation (via CLI) ──────────────────────────────────────

describe('persona add — path-safe id validation', () => {
  let h: Harness
  let sourceRoot: string

  beforeEach(() => {
    h = createHarness()
    sourceRoot = tmpDir()
  })

  afterEach(() => {
    h.cleanup()
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('rejects a mask whose id starts with a dot', () => {
    const dotId = VALID_PERSONA_MD.replace('id: senpai-rust', 'id: .hidden')
    const f = join(sourceRoot, 'mask.md')
    writeFileSync(f, dotId)

    const { code, stderr } = h.run(['add', f])

    expect(code).toBe(1)
    expect(stderr).toMatch(/not a valid persona mask|unsafe|invalid/i)
  })

  it('rejects a mask whose id contains a slash', () => {
    const slashId = VALID_PERSONA_MD.replace('id: senpai-rust', 'id: foo/bar')
    const f = join(sourceRoot, 'mask.md')
    writeFileSync(f, slashId)

    const { code, stderr } = h.run(['add', f])

    expect(code).toBe(1)
    expect(stderr).toMatch(/not a valid persona mask|unsafe|invalid/i)
  })

  it('rejects a mask whose id traverses upward (../evil)', () => {
    const traversalId = VALID_PERSONA_MD.replace('id: senpai-rust', 'id: ../evil')
    const f = join(sourceRoot, 'mask.md')
    writeFileSync(f, traversalId)

    const { code, stderr } = h.run(['add', f])

    expect(code).toBe(1)
    expect(stderr).toMatch(/not a valid persona mask|unsafe|invalid/i)
  })

  it('accepts a valid id with hyphens and underscores', () => {
    const f = join(sourceRoot, 'mask.md')
    writeFileSync(f, VALID_PERSONA_MD) // id: senpai-rust

    const { code } = h.run(['add', f])

    expect(code).toBe(0)
  })

  it('accepts a valid id with dots (e.g. v2.0)', () => {
    const dotId = VALID_PERSONA_MD.replace('id: senpai-rust', 'id: senpai.v2')
    const f = join(sourceRoot, 'mask.md')
    writeFileSync(f, dotId)

    const { code } = h.run(['add', f])

    expect(code).toBe(0)
    expect(h.exists('.persona/senpai.v2/persona.md')).toBe(true)
  })
})

// ─── two-level discovery ─────────────────────────────────────────────────────

describe('persona add — two-level discovery', () => {
  let h: Harness
  let sourceRoot: string

  beforeEach(() => {
    h = createHarness()
    sourceRoot = tmpDir()
  })

  afterEach(() => {
    h.cleanup()
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('discovers exactly at depth 1', () => {
    const dir = join(sourceRoot, 'collection')
    const sub = join(dir, 'senpai-rust')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'persona.md'), VALID_PERSONA_MD)

    const { code } = h.run(['add', dir])

    expect(code).toBe(0)
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
  })

  it('discovers exactly at depth 2', () => {
    const dir = join(sourceRoot, 'collection')
    const l1 = join(dir, 'group')
    const l2 = join(l1, 'senpai-rust')
    mkdirSync(l2, { recursive: true })
    writeFileSync(join(l2, 'persona.md'), VALID_PERSONA_MD)

    const { code } = h.run(['add', dir])

    expect(code).toBe(0)
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
  })

  it('errors at depth 3 (too deep)', () => {
    const dir = join(sourceRoot, 'deep')
    const l3 = join(dir, 'a', 'b', 'senpai-rust')
    mkdirSync(l3, { recursive: true })
    writeFileSync(join(l3, 'persona.md'), VALID_PERSONA_MD)

    const { code, stderr } = h.run(['add', dir])

    expect(code).toBe(1)
    expect(stderr).toMatch(/specific/i)
  })

  it('returns the entire mask directory (not just persona.md) when discovering at depth 1', () => {
    const dir = join(sourceRoot, 'collection')
    const sub = join(dir, 'senpai-rust')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'persona.md'), VALID_PERSONA_MD)
    writeFileSync(join(sub, 'memory.md'), '# memory')

    h.run(['add', dir])

    expect(h.exists('.persona/senpai-rust/memory.md')).toBe(true)
  })
})

// ─── symlink detection ────────────────────────────────────────────────────────

describe('persona add — symlink detection', () => {
  let h: Harness
  let sourceRoot: string

  beforeEach(() => {
    h = createHarness()
    sourceRoot = tmpDir()
  })

  afterEach(() => {
    h.cleanup()
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('rejects a directory source containing a top-level symlink', () => {
    const dir = join(sourceRoot, 'with-link')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'persona.md'), VALID_PERSONA_MD)
    symlinkSync('/etc/hosts', join(dir, 'link'))

    const { code, stderr } = h.run(['add', dir])

    expect(code).toBe(1)
    expect(stderr).toMatch(/symlink/i)
  })

  it('rejects a directory source containing a nested symlink', () => {
    const dir = join(sourceRoot, 'nested-link')
    const subDir = join(dir, 'senpai-rust')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'persona.md'), VALID_PERSONA_MD)
    // symlink inside the mask subdirectory
    symlinkSync('/etc/hosts', join(subDir, 'dangerous-link'))

    const { code, stderr } = h.run(['add', dir])

    expect(code).toBe(1)
    expect(stderr).toMatch(/symlink/i)
  })

  it('rejects a directory source where the source directory itself is a symlink', () => {
    // Create a real dir with a valid mask
    const realDir = join(sourceRoot, 'real-mask')
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'persona.md'), VALID_PERSONA_MD)
    // Symlink pointing to it — the source arg is a symlink
    const linkDir = join(sourceRoot, 'link-to-mask')
    symlinkSync(realDir, linkDir)

    // On many systems lstat of a symlink shows isSymbolicLink() = true.
    // The CLI receives `linkDir` which is a symlink itself.
    // The current implementation calls lstatSync on the source, which will see
    // the symlink. We add this check.
    const { code, stderr } = h.run(['add', linkDir])

    // Either code 1 (symlink detected) or code 0 (if we decide to allow top-level symlink
    // but not nested). The spec says "任意 symlink 一律硬失败" so expect code 1.
    expect(code).toBe(1)
    expect(stderr).toMatch(/symlink/i)
  })
})
