import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VALID_PERSONA_MD } from './fixtures.js'
import { createHarness, type Harness } from './harness.js'

describe('reserved multi-agent commands (activate, remove)', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it.each(['activate', 'remove'])(
    'recognizes `%s` with a --agent option but reports it is not yet implemented',
    (command) => {
      const { stderr, code } = h.run([command, 'senpai-rust', '--agent', 'claude-code'])

      // Recognized command (not an "unknown command" error) ...
      expect(stderr).not.toMatch(/unknown command/i)
      // ... but the behavior is reserved for a later slice.
      expect(code).not.toBe(0)
      expect(stderr).toMatch(/not yet implemented/i)
    },
  )

  it('activate: shows the resolved target agent in the not-yet-implemented message', () => {
    const { stderr } = h.run(['activate', 'senpai-rust', '--agent', 'claude'])

    // The alias `claude` must be resolved to `claude-code` in the message.
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
