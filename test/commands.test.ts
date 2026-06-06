import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VALID_PERSONA_MD } from './fixtures.js'
import { createHarness, type Harness } from './harness.js'

describe('persona remove (multi-agent command shape)', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it('recognizes `remove` with a --agent option (not an unknown command)', () => {
    // Mask not installed → artifact not found, but the command IS recognised.
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    const { stderr, code } = h.run(['remove', 'senpai-rust', '--agent', 'claude-code'])

    // Recognised (not "unknown command")
    expect(stderr).not.toMatch(/unknown command/i)
    // Hard-fails because the artifact has not been installed
    expect(code).not.toBe(0)
  })
})

describe('activate command (face-mask activation)', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it('is not reported as an unknown command', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    // Not installed yet — fails, but not with "unknown command"
    const { stderr } = h.run(['activate', 'senpai-rust', '--agent', 'claude-code'])
    expect(stderr).not.toMatch(/unknown command/i)
  })

  it('alias "claude" is resolved to "claude-code" in error messages', () => {
    // Mask exists but not installed — the error message should name the
    // canonical agent id, not the user-supplied alias.
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    const { stderr } = h.run(['activate', 'senpai-rust', '--agent', 'claude'])
    expect(stderr).toContain('claude-code')
  })
})

describe('persona install (multi-agent command shape)', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it('is not reported as an unknown command', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    const { stderr } = h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    expect(stderr).not.toMatch(/unknown command/i)
  })

  it('accepts `claude` as an alias for the claude-code agent target', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    const { code } = h.run(['install', 'senpai-rust', '--agent', 'claude'])

    // claude resolves to claude-code — install succeeds
    expect(code).toBe(0)
    expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(true)
  })
})
