import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './harness.js'

describe('reserved multi-agent commands', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  it.each(['install', 'activate', 'remove'])(
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

  it('accepts `claude` as an alias for the claude-code agent target', () => {
    const { stderr } = h.run(['install', 'senpai-rust', '--agent', 'claude'])

    expect(stderr).toContain('claude-code')
  })
})
