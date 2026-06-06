import type { ParsedMask } from './persona-md.js'

/** Required frontmatter scalars. A persona mask is unusable without all of them. */
export const REQUIRED_FRONTMATTER = [
  'id',
  'name',
  'description',
  'self_address',
  'user_address',
] as const

/**
 * The four 结构保真 (role-fidelity) sections, in render order. Their canonical
 * English headings are the only ones the validator accepts; section bodies may
 * be written in any language.
 */
export const FIDELITY_SECTIONS = [
  'Linguistic Style',
  'Knowledge And Boundaries',
  'Personality',
  'Explanation Style',
] as const

export const SCENARIO_SECTION = 'Scenario Examples'
export const EXPRESSION_BOUNDARIES_SECTION = 'Expression Boundaries'

/** Every required body section, in render order. */
export const REQUIRED_SECTIONS = [
  ...FIDELITY_SECTIONS,
  SCENARIO_SECTION,
  EXPRESSION_BOUNDARIES_SECTION,
] as const

/**
 * Signals that a passage states a knowledge boundary or uncertainty behaviour —
 * what the persona must not claim, or how it acts when it does not know. Covers
 * the two project languages (EN + ZH) per CONTEXT.md. Detection is keyword-based
 * by design: persona bodies are free prose in any language, so this is a
 * pragmatic heuristic, not semantic understanding.
 */
const BOUNDARY_SIGNALS = [
  // English
  'uncertain',
  'unsure',
  'not sure',
  "don't know",
  'do not know',
  'cannot confirm',
  "can't confirm",
  'not certain',
  'boundary',
  'boundaries',
  'fabricate',
  'make up',
  'do not invent',
  "don't invent",
  'verify',
  'out of scope',
  // 简体中文
  '不确定',
  '不知道',
  '不清楚',
  '不能确定',
  '无法确认',
  '无法确定',
  '不编造',
  '不会编造',
  '不杜撰',
  '凭印象',
  '拿不准',
  '边界',
  '查文档',
  '官方文档',
  '为准',
  '不保证',
  '范围之外',
  '超出',
] as const

function hasBoundarySignal(text: string): boolean {
  const haystack = text.toLowerCase()
  return BOUNDARY_SIGNALS.some((signal) => haystack.includes(signal))
}

/**
 * Patterns for obviously malicious instructions a persona mask must not carry:
 * bypassing permissions, exfiltrating secrets, overriding tool safety, and
 * prompt-injection ("ignore previous instructions"). Like {@link BOUNDARY_SIGNALS}
 * this is a deliberately conservative heuristic — it catches blatant abuse, not
 * every adversarial phrasing.
 */
const MALICIOUS_PATTERNS: readonly RegExp[] = [
  // English
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|earlier|above)\s+(instructions|system prompt|rules)/i,
  /exfiltrat/i,
  /bypass\w*\s+(the\s+)?(permission|safety|guardrail|tool|security)/i,
  /(leak|steal|reveal|disclose|send|upload|exfiltrate)[\s\S]{0,40}(secret|credential|api[\s-]?key|token|password|private key|\.env)/i,
  /(override|disable|turn off|circumvent|defeat|ignore)\s+\w*\s*(tool|safety|guardrail|permission|security)/i,
  // 简体中文
  /绕过[\s\S]{0,8}(权限|安全|工具|检查|限制)/,
  /(外泄|泄露|窃取|上传|发送|盗取)[\s\S]{0,12}(密钥|密码|凭证|令牌|secret|api[\s-]?key|token)/,
  /(覆盖|关闭|禁用|绕过|无视|解除)[\s\S]{0,8}(工具安全|安全限制|安全|护栏|权限)/,
  /无视[\s\S]{0,8}(指令|系统提示|以上规则)/,
]

function hasMaliciousInstruction(text: string): boolean {
  return MALICIOUS_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Count scenario examples in the `## Scenario Examples` section. Examples are
 * blank-line-separated blocks — no structural marker is required of authors.
 */
function countScenarioExamples(section: string): number {
  return section
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '').length
}

/** A single hard-fail reason that blocks rendering a persona mask. */
export interface ValidationError {
  /** Stable machine code for the failed check. */
  readonly code: string
  /** Human-facing, actionable message. */
  readonly message: string
}

/**
 * Validate a parsed persona mask against the hard requirements that protect
 * 结构保真 and safety. Returns every failure found (not just the first) so the
 * user can fix them in one pass. An empty array means the mask may be rendered.
 *
 * This is content-only validation: it judges the parsed `persona.md`, not the
 * mask directory on disk. `use` runs it before rendering; `add` reuses it after
 * import. Source-path and symlink safety belong to `add`, not here.
 */
export function validateMask(parsed: ParsedMask): ValidationError[] {
  const errors: ValidationError[] = []

  for (const field of REQUIRED_FRONTMATTER) {
    const value = parsed.frontmatter[field]
    if (value === undefined || value.trim() === '') {
      errors.push({
        code: 'missing_frontmatter',
        message: `missing required frontmatter field: ${field}`,
      })
    }
  }

  for (const heading of REQUIRED_SECTIONS) {
    if (!parsed.sections.has(heading)) {
      errors.push({
        code: 'missing_section',
        message: `missing required section: ## ${heading}`,
      })
    }
  }

  const fullText = [
    ...Object.values(parsed.frontmatter),
    ...parsed.sections.values(),
  ].join('\n')
  if (hasMaliciousInstruction(fullText)) {
    errors.push({
      code: 'malicious_instruction',
      message:
        'persona mask contains an obviously malicious instruction (e.g. bypassing permissions, exfiltrating secrets, or overriding tool safety)',
    })
  }

  const knowledge = parsed.sections.get('Knowledge And Boundaries')
  if (knowledge !== undefined && !hasBoundarySignal(knowledge)) {
    errors.push({
      code: 'missing_knowledge_boundary',
      message:
        '## Knowledge And Boundaries states no explicit boundary: say what the persona must not claim and how it behaves when uncertain',
    })
  }

  const scenarios = parsed.sections.get(SCENARIO_SECTION)
  if (scenarios !== undefined) {
    if (countScenarioExamples(scenarios) < 2) {
      errors.push({
        code: 'too_few_scenario_examples',
        message: `## ${SCENARIO_SECTION} must contain at least two scenario examples (blank-line separated)`,
      })
    }
    if (!hasBoundarySignal(scenarios)) {
      errors.push({
        code: 'no_uncertainty_example',
        message: `## ${SCENARIO_SECTION} must include at least one example where the persona respects a knowledge boundary or refuses to fabricate uncertain information`,
      })
    }
  }

  return errors
}
