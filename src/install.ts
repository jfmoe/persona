/**
 * `persona install` — Claude Code Output Style adapter.
 *
 * Renders a persona mask (`人格面具`) as a Claude Code Output Style artifact
 * and writes it to `~/.claude/output-styles/<id>.md`. The adapter reuses the
 * agent-neutral body produced by `compilePersonaPrompt` and wraps it with the
 * fixed Claude Code Output Style frontmatter.
 *
 * Responsibility boundary (ADR-0001): this module only writes the Output Style
 * file. It does not write CLAUDE.md, AGENTS.md, subagent definitions, hooks,
 * or settings.json. `install` is "面具安装" — it makes the mask available as a
 * main-session expression entry point; it does not "面具启用" (enable/activate)
 * the style.
 */
import type { ParsedMask } from './persona-md.js'
import { compilePersonaPrompt, type CompiledPrompt } from './renderer.js'

/** The full rendered content of a Claude Code Output Style file. */
export interface RenderedOutputStyle {
  /**
   * The complete Output Style markdown: YAML frontmatter + agent-neutral body.
   * This is the content written verbatim to `~/.claude/output-styles/<id>.md`.
   */
  readonly content: string
  /** Non-fatal warnings forwarded from the underlying renderer. */
  readonly warnings: string[]
}

/**
 * Render a parsed persona mask as a Claude Code Output Style artifact.
 *
 * Reuses `compilePersonaPrompt` for the agent-neutral CORE BODY (sections,
 * guardrails, mask source) and prepends the fixed Claude Code Output Style
 * YAML frontmatter. `keep-coding-instructions: true` is always set to preserve
 * Claude Code's coding behaviour while the persona expression layer is active.
 *
 * @param parsed  A mask that has already passed `validateMask`.
 * @param maskDir Absolute path to `~/.persona/<id>` — passed through to the
 *                renderer so the body can disclose it as the stable source for
 *                optional extended material.
 */
export function renderOutputStyle(parsed: ParsedMask, maskDir: string): RenderedOutputStyle {
  const { prompt: body, warnings }: CompiledPrompt = compilePersonaPrompt(parsed, maskDir)

  const fm = parsed.frontmatter
  const frontmatter = [
    '---',
    `name: ${JSON.stringify(fm.name ?? fm.id ?? 'unknown')}`,
    `description: ${JSON.stringify(fm.description ?? '')}`,
    'keep-coding-instructions: true',
    '---',
  ].join('\n')

  const content = `${frontmatter}\n\n${body}`

  return { content, warnings }
}
