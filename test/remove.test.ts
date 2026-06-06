/**
 * Tests for `persona remove` — mask / targeted artifact / lock cleanup.
 *
 * Section A: Unit tests for pure logic (isActiveStyle, clearOutputStyle).
 * Section B: Integration tests for the `persona remove` CLI command.
 *   B1: Default remove (mask dir + lock entry)
 *   B2: Targeted remove (artifact only; lock entry + mask preserved)
 *   B3: Active style guard (targeted remove while style is active)
 *   B4: Stale lock guard (mask dir missing but lock entry present)
 *   B5: Non-destructive contract (never touches files CLI doesn't own)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isActiveStyle, clearOutputStyle } from '../src/remove.js'
import { VALID_PERSONA_MD } from './fixtures.js'
import { createHarness, type Harness } from './harness.js'

// ---------------------------------------------------------------------------
// A. Unit tests: pure logic helpers
// ---------------------------------------------------------------------------

describe('isActiveStyle', () => {
  it('returns false for null content', () => {
    expect(isActiveStyle(null, 'senpai-rust')).toBe(false)
  })

  it('returns false for empty string content', () => {
    expect(isActiveStyle('', 'senpai-rust')).toBe(false)
  })

  it('returns true when outputStyle matches the given id', () => {
    const settings = JSON.stringify({ outputStyle: 'senpai-rust', theme: 'dark' })
    expect(isActiveStyle(settings, 'senpai-rust')).toBe(true)
  })

  it('returns false when outputStyle differs from the given id', () => {
    const settings = JSON.stringify({ outputStyle: 'other-persona' })
    expect(isActiveStyle(settings, 'senpai-rust')).toBe(false)
  })

  it('returns false when outputStyle is absent', () => {
    const settings = JSON.stringify({ theme: 'dark' })
    expect(isActiveStyle(settings, 'senpai-rust')).toBe(false)
  })

  it('returns false (does not throw) on invalid JSON', () => {
    expect(isActiveStyle('{ not valid json }', 'senpai-rust')).toBe(false)
  })

  it('returns false when settings is an array', () => {
    expect(isActiveStyle('[1, 2, 3]', 'senpai-rust')).toBe(false)
  })
})

describe('clearOutputStyle', () => {
  it('removes outputStyle from settings while preserving other keys', () => {
    const settings = JSON.stringify({ outputStyle: 'senpai-rust', theme: 'dark', verbose: true })
    const result = clearOutputStyle(settings)
    const parsed = JSON.parse(result)
    expect(parsed).not.toHaveProperty('outputStyle')
    expect(parsed.theme).toBe('dark')
    expect(parsed.verbose).toBe(true)
  })

  it('does not crash when outputStyle is already absent', () => {
    const settings = JSON.stringify({ theme: 'light' })
    const result = clearOutputStyle(settings)
    const parsed = JSON.parse(result)
    expect(parsed).not.toHaveProperty('outputStyle')
    expect(parsed.theme).toBe('light')
  })

  it('throws on invalid JSON', () => {
    expect(() => clearOutputStyle('{ not valid json }')).toThrow()
  })

  it('throws when settings JSON is an array', () => {
    expect(() => clearOutputStyle('[1, 2, 3]')).toThrow()
  })

  it('produces valid JSON with 2-space indentation', () => {
    const settings = JSON.stringify({ outputStyle: 'x', a: 1 })
    const result = clearOutputStyle(settings)
    expect(() => JSON.parse(result)).not.toThrow()
    expect(result).toContain('  "a"')
  })
})

// ---------------------------------------------------------------------------
// B. Integration tests: `persona remove` CLI command
// ---------------------------------------------------------------------------

describe('persona remove', () => {
  let h: Harness

  /** Seed a mask with a lock entry (simulates a mask imported via `add`). */
  function seedMaskWithLock(id: string): void {
    h.seedMask(id, { 'persona.md': VALID_PERSONA_MD.replace('id: senpai-rust', `id: ${id}`) })
    // Write a minimal lock entry
    h.writeFile(
      '.persona/.lock.json',
      JSON.stringify(
        {
          version: 1,
          personas: {
            [id]: {
              sourceType: 'local',
              sourceUrl: `/tmp/source/${id}`,
              maskFolderHash: 'abc123',
              importedAt: '2025-01-01T00:00:00.000Z',
              updatedAt: '2025-01-01T00:00:00.000Z',
            },
          },
        },
        null,
        2,
      ) + '\n',
    )
  }

  /** Seed only the artifact (output-styles file) without a mask in the library. */
  function seedArtifactOnly(id: string): void {
    h.writeFile(`.claude/output-styles/${id}.md`, `---\nname: ${id}\n---\nMask body.\n`)
  }

  /** Seed a mask with both a lock entry and the installed artifact. */
  function seedInstalledMask(id: string): void {
    seedMaskWithLock(id)
    h.writeFile(`.claude/output-styles/${id}.md`, `---\nname: ${id}\n---\nMask body.\n`)
  }

  /** Write settings.json with the given persona as the active outputStyle. */
  function setActiveStyle(id: string): void {
    h.writeFile('.claude/settings.json', JSON.stringify({ outputStyle: id }, null, 2) + '\n')
  }

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  // ── B1: Default remove (no --agent) ─────────────────────────────────────────

  describe('default remove (no --agent)', () => {
    it('removes the mask directory', () => {
      h.seedMask('senpai-rust')
      expect(h.exists('.persona/senpai-rust')).toBe(true)

      const { code } = h.run(['remove', 'senpai-rust'])

      expect(code).toBe(0)
      expect(h.exists('.persona/senpai-rust')).toBe(false)
    })

    it('removes the lock entry when one exists', () => {
      seedMaskWithLock('senpai-rust')
      expect(h.exists('.persona/.lock.json')).toBe(true)

      const { code } = h.run(['remove', 'senpai-rust'])

      expect(code).toBe(0)
      const lock = JSON.parse(h.readFile('.persona/.lock.json'))
      expect(lock.personas).not.toHaveProperty('senpai-rust')
    })

    it('succeeds and only removes the named mask entry from a multi-entry lock', () => {
      seedMaskWithLock('senpai-rust')
      // Add a second lock entry manually
      const lock = JSON.parse(h.readFile('.persona/.lock.json'))
      lock.personas['other-persona'] = {
        sourceType: 'local',
        sourceUrl: '/tmp/other',
        maskFolderHash: 'def456',
        importedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      }
      h.writeFile('.persona/.lock.json', JSON.stringify(lock, null, 2) + '\n')

      const { code } = h.run(['remove', 'senpai-rust'])

      expect(code).toBe(0)
      const updatedLock = JSON.parse(h.readFile('.persona/.lock.json'))
      expect(updatedLock.personas).not.toHaveProperty('senpai-rust')
      expect(updatedLock.personas).toHaveProperty('other-persona')
    })

    it('succeeds when there is no lock entry (manually placed mask)', () => {
      h.seedMask('senpai-rust')

      const { code } = h.run(['remove', 'senpai-rust'])

      expect(code).toBe(0)
      expect(h.exists('.persona/senpai-rust')).toBe(false)
    })

    it('exits non-zero when the persona mask does not exist and there is no lock entry', () => {
      const { code, stderr } = h.run(['remove', 'ghost'])

      expect(code).not.toBe(0)
      expect(stderr).toMatch(/not found/i)
    })

    it('outputs a confirmation message on success', () => {
      h.seedMask('senpai-rust')

      const { code, stdout } = h.run(['remove', 'senpai-rust'])

      expect(code).toBe(0)
      expect(stdout).toMatch(/removed.*senpai-rust/i)
    })

    it('exits 2 when the persona mask id is missing', () => {
      const { code, stderr } = h.run(['remove'])

      expect(code).toBe(2)
      expect(stderr).toMatch(/missing/i)
    })

    it('warns when a Claude Code Output Style for the removed mask still exists', () => {
      seedInstalledMask('senpai-rust') // mask + lock + output-styles artifact

      const { code, stderr } = h.run(['remove', 'senpai-rust'])

      expect(code).toBe(0)
      // Mask + lock are gone, but the agent artifact is deliberately left in place.
      expect(h.exists('.persona/senpai-rust')).toBe(false)
      expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(true)
      // The user is warned about the dangling artifact and told how to clean it.
      expect(stderr).toMatch(/output style/i)
      expect(stderr).toMatch(/--agent claude-code/)
    })

    it('notes the dangling style is active when it is the current outputStyle', () => {
      seedInstalledMask('senpai-rust')
      setActiveStyle('senpai-rust')

      const { code, stderr } = h.run(['remove', 'senpai-rust'])

      expect(code).toBe(0)
      expect(stderr).toMatch(/active output style/i)
    })

    it('does not warn when no agent artifact exists for the removed mask', () => {
      seedMaskWithLock('senpai-rust') // mask + lock, but no artifact

      const { code, stderr } = h.run(['remove', 'senpai-rust'])

      expect(code).toBe(0)
      expect(stderr).not.toMatch(/output style/i)
    })
  })

  describe('id path safety', () => {
    it.each(['../escape', '../../etc', 'foo/bar', '.hidden', 'a\\b'])(
      'rejects path-unsafe id %j before any destructive operation',
      (badId) => {
        const { code, stderr } = h.run(['remove', badId])

        expect(code).not.toBe(0)
        expect(stderr).toMatch(/invalid/i)
      },
    )

    it('does not delete a sibling directory via a traversal id', () => {
      // Sentinel lives next to ~/.persona; `../.persona-sentinel` from the
      // persona home would resolve to it. The guard must block the delete.
      h.writeFile('.persona-sentinel/keep.txt', 'do not delete')
      h.seedMask('safe')

      const { code } = h.run(['remove', '../.persona-sentinel'])

      expect(code).not.toBe(0)
      expect(h.exists('.persona-sentinel/keep.txt')).toBe(true)
    })
  })

  // ── B2: Targeted remove (--agent) ───────────────────────────────────────────

  describe('targeted remove (--agent)', () => {
    it('removes the output-styles artifact for claude-code', () => {
      seedInstalledMask('senpai-rust')
      expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(true)

      const { code } = h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(code).toBe(0)
      expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(false)
    })

    it('preserves the mask directory after targeted remove', () => {
      seedInstalledMask('senpai-rust')

      const { code } = h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(code).toBe(0)
      expect(h.exists('.persona/senpai-rust')).toBe(true)
    })

    it('preserves the lock entry after targeted remove', () => {
      seedInstalledMask('senpai-rust')

      const { code } = h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(code).toBe(0)
      const lock = JSON.parse(h.readFile('.persona/.lock.json'))
      expect(lock.personas).toHaveProperty('senpai-rust')
    })

    it('accepts "claude" as an alias for claude-code', () => {
      seedInstalledMask('senpai-rust')

      const { code } = h.run(['remove', 'senpai-rust', '--agent', 'claude'])

      expect(code).toBe(0)
      expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(false)
    })

    it('accepts --yes as targeted remove using the default agent', () => {
      seedInstalledMask('senpai-rust')

      const { code } = h.run(['remove', 'senpai-rust', '--yes'])

      expect(code).toBe(0)
      expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(false)
    })

    it('exits non-zero when the artifact does not exist', () => {
      h.seedMask('senpai-rust')

      const { code, stderr } = h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(code).not.toBe(0)
      expect(stderr).toMatch(/not found|artifact/i)
    })

    it('exits non-zero for an unknown --agent value', () => {
      seedInstalledMask('senpai-rust')

      const { code, stderr } = h.run(['remove', 'senpai-rust', '--agent', 'unknown-xyz'])

      expect(code).not.toBe(0)
      expect(stderr).toMatch(/not supported|unknown.*agent|agent.*unknown/i)
    })

    it('outputs a confirmation message on success', () => {
      seedInstalledMask('senpai-rust')

      const { stdout } = h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(stdout).toMatch(/removed.*senpai-rust/i)
    })
  })

  // ── B3: Active style guard ───────────────────────────────────────────────────

  describe('active style guard (targeted remove while style is active)', () => {
    it('hard-fails in non-interactive mode when the style is active (no --clear-active)', () => {
      seedInstalledMask('senpai-rust')
      setActiveStyle('senpai-rust')

      const { code, stderr } = h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(code).not.toBe(0)
      expect(stderr).toMatch(/active|--clear-active/i)
      // Artifact must NOT be deleted on failure
      expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(true)
    })

    it('succeeds with --clear-active in non-interactive mode and clears outputStyle', () => {
      seedInstalledMask('senpai-rust')
      setActiveStyle('senpai-rust')

      const { code } = h.run([
        'remove',
        'senpai-rust',
        '--agent',
        'claude-code',
        '--clear-active',
      ])

      expect(code).toBe(0)
      expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(false)
      const settings = JSON.parse(h.readFile('.claude/settings.json'))
      expect(settings).not.toHaveProperty('outputStyle')
    })

    it('preserves other settings keys when clearing outputStyle via --clear-active', () => {
      seedInstalledMask('senpai-rust')
      h.writeFile(
        '.claude/settings.json',
        JSON.stringify({ outputStyle: 'senpai-rust', theme: 'dark', verbose: true }, null, 2) +
          '\n',
      )

      h.run(['remove', 'senpai-rust', '--agent', 'claude-code', '--clear-active'])

      const settings = JSON.parse(h.readFile('.claude/settings.json'))
      expect(settings).not.toHaveProperty('outputStyle')
      expect(settings.theme).toBe('dark')
      expect(settings.verbose).toBe(true)
    })

    it('does not touch settings.json when the style is not active', () => {
      seedInstalledMask('senpai-rust')
      h.writeFile(
        '.claude/settings.json',
        JSON.stringify({ outputStyle: 'other-persona', theme: 'dark' }, null, 2) + '\n',
      )

      const { code } = h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(code).toBe(0)
      const settings = JSON.parse(h.readFile('.claude/settings.json'))
      // outputStyle for other-persona is preserved
      expect(settings.outputStyle).toBe('other-persona')
    })

    it('succeeds when there is no settings.json (no active style)', () => {
      seedInstalledMask('senpai-rust')
      expect(h.exists('.claude/settings.json')).toBe(false)

      const { code } = h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(code).toBe(0)
    })

    it('checks --project settings when --project is passed', () => {
      seedInstalledMask('senpai-rust')
      // Project-level settings has the active style; user-level does not
      const projectDir = h.home + '/myproject'
      h.writeFile('myproject/.keep', '')
      h.writeFile(
        'myproject/.claude/settings.json',
        JSON.stringify({ outputStyle: 'senpai-rust' }, null, 2) + '\n',
      )

      // Non-interactive hard-fail because active (no --clear-active)
      const { code, stderr } = h.run(
        ['remove', 'senpai-rust', '--agent', 'claude-code', '--project'],
        { cwd: projectDir },
      )

      expect(code).not.toBe(0)
      expect(stderr).toMatch(/active|--clear-active/i)
    })

    it('clears project-local outputStyle with --project --clear-active', () => {
      seedInstalledMask('senpai-rust')
      const projectDir = h.home + '/myproject'
      h.writeFile('myproject/.keep', '')
      h.writeFile(
        'myproject/.claude/settings.json',
        JSON.stringify({ outputStyle: 'senpai-rust', customKey: 42 }, null, 2) + '\n',
      )

      const { code } = h.run(
        ['remove', 'senpai-rust', '--agent', 'claude-code', '--project', '--clear-active'],
        { cwd: projectDir },
      )

      expect(code).toBe(0)
      const settings = JSON.parse(h.readFile('myproject/.claude/settings.json'))
      expect(settings).not.toHaveProperty('outputStyle')
      expect(settings.customKey).toBe(42)
    })
  })

  // ── B4: Stale lock guard ─────────────────────────────────────────────────────

  describe('stale lock guard (mask dir missing, lock entry present)', () => {
    function seedStaleLock(id: string): void {
      // Write only a lock entry — no mask directory
      h.writeFile(
        '.persona/.lock.json',
        JSON.stringify(
          {
            version: 1,
            personas: {
              [id]: {
                sourceType: 'local',
                sourceUrl: `/tmp/source/${id}`,
                maskFolderHash: 'abc123',
                importedAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
              },
            },
          },
          null,
          2,
        ) + '\n',
      )
    }

    it('hard-fails in non-interactive mode without --prune-lock', () => {
      seedStaleLock('ghost')

      const { code, stderr } = h.run(['remove', 'ghost'])

      expect(code).not.toBe(0)
      expect(stderr).toMatch(/--prune-lock/i)
    })

    it('removes the stale lock entry with --prune-lock in non-interactive mode', () => {
      seedStaleLock('ghost')

      const { code } = h.run(['remove', 'ghost', '--prune-lock'])

      expect(code).toBe(0)
      const lock = JSON.parse(h.readFile('.persona/.lock.json'))
      expect(lock.personas).not.toHaveProperty('ghost')
    })

    it('outputs a confirmation message when cleaning up stale lock', () => {
      seedStaleLock('ghost')

      const { stdout } = h.run(['remove', 'ghost', '--prune-lock'])

      expect(stdout).toMatch(/stale|ghost/i)
    })

    it('exits non-zero when neither mask dir nor lock entry exist', () => {
      const { code, stderr } = h.run(['remove', 'nobody'])

      expect(code).not.toBe(0)
      expect(stderr).toMatch(/not found/i)
    })
  })

  // ── B5: Non-destructive contract ─────────────────────────────────────────────

  describe('non-destructive contract', () => {
    it('default remove does not touch the output-styles artifact', () => {
      seedInstalledMask('senpai-rust')

      h.run(['remove', 'senpai-rust'])

      // Artifact remains (it was not targeted)
      expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(true)
    })

    it('targeted remove does not touch other mask directories', () => {
      seedInstalledMask('senpai-rust')
      h.seedMask('other-persona')

      h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(h.exists('.persona/other-persona')).toBe(true)
    })

    it('targeted remove does not touch other output-styles artifacts', () => {
      seedInstalledMask('senpai-rust')
      h.writeFile('.claude/output-styles/other-persona.md', '---\nname: other\n---\n')

      h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

      expect(h.exists('.claude/output-styles/other-persona.md')).toBe(true)
    })

    it('default remove does not touch settings.json', () => {
      seedMaskWithLock('senpai-rust')
      h.writeFile(
        '.claude/settings.json',
        JSON.stringify({ outputStyle: 'senpai-rust', theme: 'dark' }, null, 2) + '\n',
      )

      h.run(['remove', 'senpai-rust'])

      // settings.json is untouched — default remove only removes the mask dir and lock
      const settings = JSON.parse(h.readFile('.claude/settings.json'))
      expect(settings.outputStyle).toBe('senpai-rust')
      expect(settings.theme).toBe('dark')
    })

    it('default remove does not remove other personas lock entries', () => {
      seedMaskWithLock('senpai-rust')
      const lock = JSON.parse(h.readFile('.persona/.lock.json'))
      lock.personas['other-persona'] = {
        sourceType: 'local',
        sourceUrl: '/tmp/other',
        maskFolderHash: 'def456',
        importedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      }
      h.writeFile('.persona/.lock.json', JSON.stringify(lock, null, 2) + '\n')

      h.run(['remove', 'senpai-rust'])

      const updatedLock = JSON.parse(h.readFile('.persona/.lock.json'))
      expect(updatedLock.personas).toHaveProperty('other-persona')
    })
  })
})
