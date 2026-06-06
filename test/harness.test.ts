import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './harness.js'

describe('integration test harness', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it('captures stdout, stderr, and the exit code', () => {
    const { stdout, stderr, code } = h.run(['definitely-not-a-command'])

    expect(code).toBe(2)
    expect(stderr).toMatch(/unknown command/i)
    expect(stdout).toBe('')
  })

  it('runs commands under a temp HOME so the real ~/.persona is never touched', () => {
    expect(realpathSync(h.home).startsWith(realpathSync(tmpdir()))).toBe(true)
    expect(h.personaDir).toBe(`${h.home}/.persona`)

    // The CLI only ever sees masks seeded into this temp HOME — proof that HOME
    // is redirected and the developer's real library is invisible.
    h.seedMask('only-mask')
    const { stdout } = h.run(['list'])
    expect(stdout.trim().split('\n')).toEqual(['only-mask'])
  })

  it('can seed masks and assert filesystem side effects relative to HOME', () => {
    h.seedMask('senpai-rust', { 'persona.md': '# stub', 'memory.md': 'mask memory' })

    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
    expect(h.readFile('.persona/senpai-rust/memory.md')).toBe('mask memory')
    expect(h.exists('.persona/senpai-rust/eval.md')).toBe(false)
  })
})
