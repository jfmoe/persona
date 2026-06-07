# Persona Mask Layout

Use this reference after `$persona-mask-generator` triggers.

## Directory Layout

Default output:

```text
personas/<persona-id>/
|-- persona.md
|-- memory.md
|-- eval.md
`-- references/
    |-- source-audit.md
    `-- raw/
```

Preserve raw inputs with stable, readable names:

```text
references/raw/
|-- 001-url-<slug>.txt
|-- 002-local-<original-name>
`-- 003-inline-<slug>.md
```

Record enough metadata in `source-audit.md` to map every synthesized claim back to the raw material. Prefer concise summaries over long copied quotations.

## persona.md

Required frontmatter:

```yaml
---
id: <persona-id>
name: <display name>
description: <single-line summary>
self_address: <persona self-address>
user_address: <default user address>
---
```

Required body headings, exactly:

```markdown
## Linguistic Style

## Knowledge And Boundaries

## Personality

## Explanation Style

## Scenario Examples

## Expression Boundaries
```

Section intent:

- `Linguistic Style`: diction, rhythm, formality, signature phrases, self-address, user-address, emotional intensity, and interaction manners.
- `Knowledge And Boundaries`: what the persona may claim, what it must not claim, and how it says "I do not know" without breaking character.
- `Personality`: values, motivations, social posture, support/challenge balance, and behavior-driving traits.
- `Explanation Style`: how the persona explains reasoning, tradeoffs, corrections, refusals, uncertainty, and decisions.
- `Scenario Examples`: at least two blank-line-separated examples; at least one must demonstrate uncertainty, refusal to fabricate, or knowledge-boundary behavior.
- `Expression Boundaries`: where the persona voice applies and where it must not leak, especially code, generated files, factual claims, safety behavior, and target-agent configuration.

Rules:

- Keep `persona.md` compact and executable.
- Include only details that change expression or interaction behavior.
- Do not include long timelines, encyclopedic background, long quotes, appearance catalogs, stats tables, or weakly supported trivia.
- Do not include target-agent config, install steps, hook snippets, profile names, output-style paths, adapter settings, or tool safety rules.
- Do not declare safety guardrails as persona-specific. Safety is unconditional and outside the mask.

## memory.md

Use `memory.md` for stable background that improves role fidelity but should not bloat `persona.md`.

Suggested structure:

```markdown
# Memory

## Stable Background

## Relationships And Addressing

## Motivations And Values

## Recurring Context

## Notes Excluded From persona.md
```

Do not store current project facts, real user profiles, target-agent configuration, or unresolved high-impact conflicts as if they were stable truth.

## eval.md

Use `eval.md` as 评测材料. It can support human or semi-automatic review, but it is not a pass certificate.

Required statement:

```markdown
Human review is authoritative. Automatic scores, if used, are advisory signals only and do not prove this persona mask has passed evaluation.
```

Suggested structure:

```markdown
# Evaluation Material

## Rubric

## Evaluation Prompts

## Expected Signals

## Failure Signals

## Optional Automatic Scoring Suggestions
```

Failure signals should cover drift, fabrication, over-performance, generic assistant voice, missing boundaries, target-agent leakage, and contradictions with source evidence.

## references/source-audit.md

Use source audit for traceability, exclusions, conflicts, weak evidence, and provenance.

Suggested structure:

```markdown
# Source Audit

## Sources

| ID | Type | Original location | Fetch/status | Preserved raw path | Notes |
| --- | --- | --- | --- | --- | --- |

## Adopted Signals

## Excluded Or Low-Impact Details

## Conflicts And Resolutions

## Weak Evidence

## Open Questions
```

Conflict handling:

- Record conflicts instead of silently merging them.
- Ask the user before resolving conflicts that affect voice, core values, behavior posture, refusals, boundaries, or uncertainty behavior.
- Keep low-impact conflicts in the audit without blocking generation.

## Source Handling

For URLs:

- Fetch only URLs the user provided unless they explicitly request broader research.
- Preserve fetched text under `references/raw/`.
- Record URL, fetch status, raw path, access limitations, and date of capture in `source-audit.md`.
- If fetch fails, ask for a saved page, pasted content, or local export.

For local files:

- Copy the original file into `references/raw/` when practical.
- If conversion is needed for synthesis, keep the converted text as an additional raw capture and record the relationship.

For inline pasted text:

- Save the pasted text as a raw capture.
- If the user provides a source label or URL with the text, record it in the audit.

## Default Self-Check

Before finishing, verify:

- The generated directory contains `persona.md`, `memory.md`, `eval.md`, `references/source-audit.md`, and `references/raw/`.
- `persona.md` frontmatter contains `id`, `name`, `description`, `self_address`, and `user_address`.
- `id` is path-safe kebab-case and matches the directory name.
- `persona.md` contains all canonical headings exactly once.
- `Knowledge And Boundaries` explicitly says what the persona must not claim and how it behaves when uncertain.
- `Scenario Examples` has at least two blank-line-separated examples.
- At least one scenario demonstrates uncertainty or knowledge-boundary behavior.
- Detailed background is in `memory.md`, not `persona.md`.
- Source traceability, exclusions, conflicts, and weak evidence are in `references/source-audit.md`.
- Raw URL captures, local copies, and inline captures are preserved under `references/raw/`.
- `eval.md` states that human review is authoritative and automatic scores are advisory.
- No generated file includes target-agent configuration, hooks, profiles, output-style paths, install instructions, or adapter settings.
- The skill did not run repo CLI validation unless the user explicitly requested it.
