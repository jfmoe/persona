import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './harness.js'

describe('persona list', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it('lists a persona mask in the library', () => {
    h.seedMask('senpai-rust')

    const { stdout, code } = h.run(['list'])

    expect(code).toBe(0)
    expect(stdout.trim().split('\n')).toContain('senpai-rust')
  })

  it('presents imported and manually placed masks identically, and only lists dirs with persona.md', () => {
    // An imported mask: it has a lock-file entry recording its source.
    h.seedMask('senpai-rust')
    h.writeFile(
      '.persona/.lock.json',
      JSON.stringify({ version: 1, personas: { 'senpai-rust': { sourceType: 'github' } } }),
    )
    // A manually placed mask: no lock entry, but still a first-class local mask.
    h.seedMask('kouhai-go')
    // A directory that is NOT a mask: it has no persona.md.
    h.writeFile('.persona/scratch/notes.md', 'just notes')

    const { stdout, stderr, code } = h.run(['list'])

    expect(code).toBe(0)
    // Both masks appear, sorted, with no managed/unmanaged grouping or markers.
    expect(stdout.trim().split('\n')).toEqual(['kouhai-go', 'senpai-rust'])
    // The non-mask directory and the lock file are not listed.
    expect(stdout).not.toContain('scratch')
    expect(stdout).not.toContain('.lock.json')
    // No source/managed vocabulary leaks into the default output.
    expect(stdout.toLowerCase()).not.toMatch(/managed|unmanaged|imported|source/)
    expect(stderr).toBe('')
  })

  it('exits cleanly with an empty stdout and a hint when the library is empty', () => {
    // No masks seeded: ~/.persona/ does not even exist yet.
    const { stdout, stderr, code } = h.run(['list'])

    expect(code).toBe(0)
    expect(stdout.trim()).toBe('')
    expect(stderr).toMatch(/no persona masks/i)
  })
})
