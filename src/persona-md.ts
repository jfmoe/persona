/**
 * A parsed persona mask (`人格面具`) source file.
 *
 * Parsing is deliberately format-only: it splits a `persona.md` into its
 * frontmatter scalars and its `##` body sections without judging whether the
 * mask is valid. Quality judgements (结构保真 requirements, safety) live in the
 * validator so that both `use` and `add` can reuse the same parse step.
 */
export interface ParsedMask {
  /** Frontmatter `key: value` scalars, in file order. */
  readonly frontmatter: Readonly<Record<string, string>>
  /** Body sections keyed by their `##` heading text, in file order. */
  readonly sections: ReadonlyMap<string, string>
}

const FRONTMATTER_DELIMITER = '---'

/**
 * Parse a `persona.md` document into frontmatter scalars and `##` sections.
 *
 * Frontmatter is the leading `---`-delimited block of simple `key: value`
 * lines. Section content is everything between one `## Heading` and the next,
 * trimmed. Missing frontmatter yields an empty frontmatter map rather than an
 * error — reporting that as a hard failure is the validator's job.
 */
export function parsePersonaMd(content: string): ParsedMask {
  const normalized = content.replace(/\r\n/g, '\n')
  const { frontmatterBlock, body } = splitFrontmatter(normalized)

  return {
    frontmatter: parseFrontmatter(frontmatterBlock),
    sections: parseSections(body),
  }
}

function splitFrontmatter(content: string): { frontmatterBlock: string; body: string } {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    return { frontmatterBlock: '', body: content }
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  )
  if (closingIndex === -1) {
    return { frontmatterBlock: '', body: content }
  }
  return {
    frontmatterBlock: lines.slice(1, closingIndex).join('\n'),
    body: lines.slice(closingIndex + 1).join('\n'),
  }
}

function parseFrontmatter(block: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf(':')
    if (separator === -1) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (key !== '') result[key] = value
  }
  return result
}

function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string>()
  const lines = body.split('\n')
  let heading: string | null = null
  let buffer: string[] = []

  const flush = (): void => {
    if (heading !== null) sections.set(heading, buffer.join('\n').trim())
  }

  for (const line of lines) {
    const match = /^##\s+(?!#)(.+?)\s*$/.exec(line)
    if (match && match[1] !== undefined) {
      flush()
      heading = match[1].trim()
      buffer = []
    } else if (heading !== null) {
      buffer.push(line)
    }
  }
  flush()
  return sections
}
