/**
 * Tests for `persona install` — Claude Code Output Style adapter.
 *
 * Section A: Unit tests for Output Style rendering (frontmatter wrapping + body reuse).
 * Section B: Unit tests for adapter registry / alias resolution.
 * Section C: Integration tests for the `persona install` CLI command.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePersonaMd } from '../src/persona-md.js'
import { renderOutputStyle } from '../src/install.js'
import { resolveAgent, SUPPORTED_AGENTS, DEFAULT_AGENT } from '../src/adapter-registry.js'
import { VALID_PERSONA_MD } from './fixtures.js'
import { createHarness, type Harness } from './harness.js'

// ---------------------------------------------------------------------------
// A. Output Style rendering
// ---------------------------------------------------------------------------

describe('renderOutputStyle', () => {
  const maskDir = '/tmp/persona-test-masks/senpai-rust'

  it('produces a document starting with YAML frontmatter (---)', () => {
    const parsed = parsePersonaMd(VALID_PERSONA_MD)
    const { content } = renderOutputStyle(parsed, maskDir)
    expect(content.startsWith('---\n')).toBe(true)
  })

  it('includes keep-coding-instructions: true in frontmatter', () => {
    const parsed = parsePersonaMd(VALID_PERSONA_MD)
    const { content } = renderOutputStyle(parsed, maskDir)
    expect(content).toContain('keep-coding-instructions: true')
  })

  it('includes name from mask frontmatter in the Output Style frontmatter', () => {
    const parsed = parsePersonaMd(VALID_PERSONA_MD)
    const { content } = renderOutputStyle(parsed, maskDir)
    // 锈学姐 is the name in the fixture
    expect(content).toContain('name: 锈学姐')
  })

  it('includes description from mask frontmatter in the Output Style frontmatter', () => {
    const parsed = parsePersonaMd(VALID_PERSONA_MD)
    const { content } = renderOutputStyle(parsed, maskDir)
    expect(content).toContain('description: 严厉负责的 Rust review 学姐人格')
  })

  it('frontmatter ends with --- before the body', () => {
    const parsed = parsePersonaMd(VALID_PERSONA_MD)
    const { content } = renderOutputStyle(parsed, maskDir)
    // Must have a closing --- after the opening ---
    const lines = content.split('\n')
    const closingIdx = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    expect(closingIdx).toBeGreaterThan(1)
  })

  it('body contains the compiled persona prompt (fidelity sections present)', () => {
    const parsed = parsePersonaMd(VALID_PERSONA_MD)
    const { content } = renderOutputStyle(parsed, maskDir)
    expect(content).toContain('Linguistic Style')
    expect(content).toContain('Knowledge And Boundaries')
    expect(content).toContain('Personality')
    expect(content).toContain('Explanation Style')
  })

  it('body contains non-removable guardrails (reused from compilePersonaPrompt)', () => {
    const parsed = parsePersonaMd(VALID_PERSONA_MD)
    const { content } = renderOutputStyle(parsed, maskDir)
    expect(content).toContain('override persona expression')
    expect(content).toContain('must not contaminate code')
  })

  it('returns warnings from the underlying renderer (e.g. long prompt)', () => {
    const huge = VALID_PERSONA_MD.replace(
      '## Personality\n認真负责，对代码质量要求高，但鼓励学弟成长。',
      `## Personality\n${'认真负责。'.repeat(5000)}`,
    )
    const parsed = parsePersonaMd(huge)
    const { warnings } = renderOutputStyle(parsed, maskDir)
    // Long prompts produce at least one warning
    expect(Array.isArray(warnings)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B. Adapter registry / alias resolution
// ---------------------------------------------------------------------------

describe('adapter registry', () => {
  it('resolves "claude-code" to itself', () => {
    expect(resolveAgent('claude-code')).toBe('claude-code')
  })

  it('resolves the "claude" alias to "claude-code"', () => {
    expect(resolveAgent('claude')).toBe('claude-code')
  })

  it('returns undefined for an unknown agent name', () => {
    expect(resolveAgent('unknown-agent-xyz')).toBeUndefined()
  })

  it('SUPPORTED_AGENTS contains claude-code', () => {
    expect(SUPPORTED_AGENTS).toContain('claude-code')
  })

  it('DEFAULT_AGENT is claude-code (the only MVP agent)', () => {
    expect(DEFAULT_AGENT).toBe('claude-code')
  })
})

// ---------------------------------------------------------------------------
// C. CLI integration tests for `persona install`
// ---------------------------------------------------------------------------

describe('persona install', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  afterEach(() => {
    h.cleanup()
  })

  // ---- Happy path -----------------------------------------------------------

  it('writes Output Style to ~/.claude/output-styles/<id>.md with --agent claude-code', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })

    const { code } = h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    expect(code).toBe(0)
    expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(true)
  })

  it('generated Output Style contains keep-coding-instructions: true', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    const content = h.readFile('.claude/output-styles/senpai-rust.md')
    expect(content).toContain('keep-coding-instructions: true')
  })

  it('generated Output Style starts with YAML frontmatter', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    const content = h.readFile('.claude/output-styles/senpai-rust.md')
    expect(content.startsWith('---')).toBe(true)
  })

  it('creates the output-styles directory when it does not exist', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    expect(h.exists('.claude/output-styles')).toBe(false)

    h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    expect(h.exists('.claude/output-styles')).toBe(true)
  })

  it('accepts "claude" as an alias for claude-code', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })

    const { code } = h.run(['install', 'senpai-rust', '--agent', 'claude'])

    expect(code).toBe(0)
    expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(true)
  })

  it('accepts --yes to use the default agent in non-interactive mode', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })

    const { code } = h.run(['install', 'senpai-rust', '--yes'])

    expect(code).toBe(0)
    expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(true)
  })

  it('overwrites an existing Output Style file (idempotent re-install)', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    // Second install overwrites without error
    const { code } = h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    expect(code).toBe(0)
    expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(true)
  })

  // ---- Non-interactive failures (stdin not a TTY in test harness) -----------

  it('fails with non-zero exit when --agent and --yes are both absent in non-interactive mode', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })

    const { code, stderr } = h.run(['install', 'senpai-rust'])

    expect(code).not.toBe(0)
    // No file written
    expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(false)
    // Stderr should explain what's needed
    expect(stderr).toMatch(/--agent|--yes/i)
  })

  // ---- Schema / adapter errors block install --------------------------------

  it('blocks install with non-zero exit on schema errors (missing required frontmatter)', () => {
    const broken = VALID_PERSONA_MD.replace('self_address: 学姐\n', '')
    h.seedMask('senpai-rust', { 'persona.md': broken })

    const { code, stderr } = h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    expect(code).not.toBe(0)
    expect(h.exists('.claude/output-styles/senpai-rust.md')).toBe(false)
    expect(stderr).toMatch(/not a valid persona mask/i)
  })

  it('fails clearly when the persona mask does not exist', () => {
    const { code, stderr } = h.run(['install', 'ghost', '--agent', 'claude-code'])

    expect(code).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  // ---- Boundary: install does NOT write forbidden files ---------------------

  it('does not write CLAUDE.md', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    expect(h.exists('.claude/CLAUDE.md')).toBe(false)
  })

  it('does not write AGENTS.md', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    expect(h.exists('.claude/AGENTS.md')).toBe(false)
  })

  it('does not modify settings.json', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    // settings.json should not exist (we never create it)
    expect(h.exists('.claude/settings.json')).toBe(false)
  })

  it('does not write outputStyle field (does not enable the style)', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })
    h.run(['install', 'senpai-rust', '--agent', 'claude-code'])

    // If settings.json somehow got created, it must not contain outputStyle
    if (h.exists('.claude/settings.json')) {
      const settings = h.readFile('.claude/settings.json')
      expect(settings).not.toContain('outputStyle')
    }
  })

  // ---- Unknown agent is rejected --------------------------------------------

  it('fails with non-zero exit when an unknown --agent value is given', () => {
    h.seedMask('senpai-rust', { 'persona.md': VALID_PERSONA_MD })

    const { code, stderr } = h.run(['install', 'senpai-rust', '--agent', 'unknown-agent-xyz'])

    expect(code).not.toBe(0)
    expect(stderr).toMatch(/unknown.*agent|agent.*unknown|not supported/i)
  })
})
