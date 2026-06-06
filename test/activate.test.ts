/**
 * Tests for `persona activate` — Claude Code settings merge (面具启用).
 *
 * Section A: Unit tests for settings JSON merge logic (mergeOutputStyle).
 * Section B: Integration tests for the `persona activate` CLI command.
 */
import { statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeOutputStyle } from '../src/activate.js'
import { VALID_PERSONA_MD } from './fixtures.js'
import { createHarness, type Harness } from './harness.js'

// ---------------------------------------------------------------------------
// A. Unit tests: settings JSON merge logic
// ---------------------------------------------------------------------------

describe('mergeOutputStyle', () => {
  it('creates a settings object with outputStyle when existing content is null', () => {
    const result = mergeOutputStyle(null, 'senpai-rust')
    const parsed = JSON.parse(result)
    expect(parsed.outputStyle).toBe('senpai-rust')
  })

  it('creates a settings object with outputStyle when existing content is empty string', () => {
    const result = mergeOutputStyle('', 'senpai-rust')
    const parsed = JSON.parse(result)
    expect(parsed.outputStyle).toBe('senpai-rust')
  })

  it('only changes outputStyle, preserving all other keys', () => {
    const existing = JSON.stringify({ theme: 'dark', verbose: true, someList: [1, 2, 3] })
    const result = mergeOutputStyle(existing, 'senpai-rust')
    const parsed = JSON.parse(result)
    expect(parsed.outputStyle).toBe('senpai-rust')
    expect(parsed.theme).toBe('dark')
    expect(parsed.verbose).toBe(true)
    expect(parsed.someList).toEqual([1, 2, 3])
  })

  it('updates an existing outputStyle value to the new one', () => {
    const existing = JSON.stringify({ outputStyle: 'old-persona', theme: 'dark' })
    const result = mergeOutputStyle(existing, 'senpai-rust')
    const parsed = JSON.parse(result)
    expect(parsed.outputStyle).toBe('senpai-rust')
    expect(parsed.theme).toBe('dark')
  })

  it('produces valid JSON with 2-space indentation', () => {
    const result = mergeOutputStyle(null, 'senpai-rust')
    // Should parse successfully
    expect(() => JSON.parse(result)).not.toThrow()
    // Should use 2-space indent
    expect(result).toContain('  "outputStyle"')
  })

  it('throws an error on invalid JSON input (does not return bad data)', () => {
    expect(() => mergeOutputStyle('{ not valid json }', 'senpai-rust')).toThrow()
  })

  it('throws an error when settings JSON is not an object (e.g. an array)', () => {
    expect(() => mergeOutputStyle('[1, 2, 3]', 'senpai-rust')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// B. Integration tests: `persona activate` CLI command
// ---------------------------------------------------------------------------

describe('persona activate', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  // ---- Helper: seed a mask that is already "installed" (output-style file exists)
  function seedInstalledMask(id: string): void {
    h.seedMask(id, { 'persona.md': VALID_PERSONA_MD.replace('id: senpai-rust', `id: ${id}`) })
    // Simulate what `persona install` produces: the output-styles artifact
    h.writeFile(`.claude/output-styles/${id}.md`, `---\nname: ${id}\n---\nMask body.\n`)
  }

  // ---- Happy path -----------------------------------------------------------

  it('writes outputStyle to ~/.claude/settings.json with --agent claude-code', () => {
    seedInstalledMask('senpai-rust')

    const { code } = h.run(['activate', 'senpai-rust', '--agent', 'claude-code'])

    expect(code).toBe(0)
    expect(h.exists('.claude/settings.json')).toBe(true)
    const settings = JSON.parse(h.readFile('.claude/settings.json'))
    expect(settings.outputStyle).toBe('senpai-rust')
  })

  it('only changes outputStyle, preserving other keys in settings.json', () => {
    seedInstalledMask('senpai-rust')
    // Pre-seed a settings.json with other keys
    h.writeFile(
      '.claude/settings.json',
      JSON.stringify({ theme: 'dark', verbose: true, outputStyle: 'old' }, null, 2),
    )

    h.run(['activate', 'senpai-rust', '--agent', 'claude-code'])

    const settings = JSON.parse(h.readFile('.claude/settings.json'))
    expect(settings.outputStyle).toBe('senpai-rust')
    expect(settings.theme).toBe('dark')
    expect(settings.verbose).toBe(true)
  })

  it('creates settings.json (and parent dirs) when file does not exist', () => {
    seedInstalledMask('senpai-rust')
    expect(h.exists('.claude/settings.json')).toBe(false)

    const { code } = h.run(['activate', 'senpai-rust', '--agent', 'claude-code'])

    expect(code).toBe(0)
    expect(h.exists('.claude/settings.json')).toBe(true)
  })

  it('accepts --yes to use the default agent (claude-code)', () => {
    seedInstalledMask('senpai-rust')

    const { code } = h.run(['activate', 'senpai-rust', '--yes'])

    expect(code).toBe(0)
    const settings = JSON.parse(h.readFile('.claude/settings.json'))
    expect(settings.outputStyle).toBe('senpai-rust')
  })

  it('accepts "claude" as alias for claude-code', () => {
    seedInstalledMask('senpai-rust')

    const { code } = h.run(['activate', 'senpai-rust', '--agent', 'claude'])

    expect(code).toBe(0)
    expect(h.exists('.claude/settings.json')).toBe(true)
  })

  // ---- --project flag -------------------------------------------------------

  it('writes to <cwd>/.claude/settings.json with --project flag', () => {
    seedInstalledMask('senpai-rust')
    // Create a fake project dir under HOME
    const projectDir = h.home + '/myproject'
    h.writeFile('myproject/.keep', '')

    const { code } = h.run(['activate', 'senpai-rust', '--agent', 'claude-code', '--project'], {
      cwd: projectDir,
    })

    expect(code).toBe(0)
    expect(h.exists('myproject/.claude/settings.json')).toBe(true)
    const settings = JSON.parse(h.readFile('myproject/.claude/settings.json'))
    expect(settings.outputStyle).toBe('senpai-rust')
    // User-level settings.json should NOT be written
    expect(h.exists('.claude/settings.json')).toBe(false)
  })

  // ---- Success output -------------------------------------------------------

  it('outputs /clear or new-session hint after successful activation', () => {
    seedInstalledMask('senpai-rust')

    const { stdout } = h.run(['activate', 'senpai-rust', '--agent', 'claude-code'])

    // Must mention either /clear or new session
    expect(stdout).toMatch(/\/clear|new.session/i)
  })

  // ---- Activate does NOT re-render/install the artifact --------------------

  it('does not re-write the output-styles file (activation is pure state switch)', () => {
    seedInstalledMask('senpai-rust')
    const artifactPath = h.home + '/.claude/output-styles/senpai-rust.md'
    const mtimeBefore = statSync(artifactPath).mtimeMs

    h.run(['activate', 'senpai-rust', '--agent', 'claude-code'])

    const mtimeAfter = statSync(artifactPath).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  // ---- Precondition: persona must be installed --------------------------------

  it('hard-fails when the persona mask has not been installed for the target agent', () => {
    // Seed mask in library but do NOT create the output-styles artifact
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })

    const { code, stderr } = h.run(['activate', 'senpai-rust', '--agent', 'claude-code'])

    expect(code).not.toBe(0)
    expect(stderr).toMatch(/install/i)
  })

  it('hard-fails with exit 1 when persona mask itself does not exist', () => {
    const { code, stderr } = h.run(['activate', 'ghost', '--agent', 'claude-code'])

    expect(code).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  // ---- Invalid JSON in settings blocks activation --------------------------

  it('hard-fails when settings.json contains invalid JSON, and leaves file unchanged', () => {
    seedInstalledMask('senpai-rust')
    const badJson = '{ this is not json }'
    h.writeFile('.claude/settings.json', badJson)

    const { code, stderr } = h.run(['activate', 'senpai-rust', '--agent', 'claude-code'])

    expect(code).not.toBe(0)
    expect(stderr).toMatch(/invalid|json|parse/i)
    // File must be untouched
    expect(h.readFile('.claude/settings.json')).toBe(badJson)
  })

  // ---- Non-interactive failures --------------------------------------------

  it('fails when --agent and --yes are both absent in non-interactive mode', () => {
    seedInstalledMask('senpai-rust')

    const { code, stderr } = h.run(['activate', 'senpai-rust'])

    expect(code).not.toBe(0)
    expect(stderr).toMatch(/--agent|--yes/i)
  })

  it('fails with non-zero exit when an unknown --agent value is given', () => {
    seedInstalledMask('senpai-rust')

    const { code, stderr } = h.run(['activate', 'senpai-rust', '--agent', 'unknown-agent-xyz'])

    expect(code).not.toBe(0)
    expect(stderr).toMatch(/not supported|unknown.*agent|agent.*unknown/i)
  })
})
