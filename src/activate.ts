/**
 * Pure logic for `persona activate` — 面具启用 (face-mask activation).
 *
 * Activation is a pure settings-state switch: it updates the `outputStyle`
 * field in a Claude Code settings JSON document and nothing else. It does
 * NOT render or write Output Style artifacts — that is `persona install`'s
 * sole responsibility (ADR-0001).
 *
 * This module exports only `mergeOutputStyle` so both the CLI layer and unit
 * tests can reach the merge logic through the same public interface.
 */

/**
 * Merge `outputStyle` into a Claude Code settings JSON document.
 *
 * - `existingContent` is the raw text of the settings file, or `null`/`""`
 *   when the file does not yet exist.
 * - Returns the updated settings JSON serialised with 2-space indentation.
 * - Throws if `existingContent` is non-empty but contains invalid JSON, or
 *   if the top-level value is not a plain object. The caller must not
 *   overwrite the file in that case.
 *
 * Only `outputStyle` is changed; all other keys and their values are preserved.
 */
export function mergeOutputStyle(existingContent: string | null, styleId: string): string {
  let settings: Record<string, unknown>

  if (existingContent === null || existingContent.trim() === '') {
    settings = {}
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(existingContent)
    } catch (cause) {
      throw new Error(`settings.json contains invalid JSON: ${String(cause)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `settings.json is not a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
      )
    }
    settings = parsed as Record<string, unknown>
  }

  settings.outputStyle = styleId
  return JSON.stringify(settings, null, 2) + '\n'
}
