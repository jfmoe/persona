# Implementation subagent prompt template

Send this to each per-issue implementation subagent (Agent tool, `model: sonnet`, `isolation: "worktree"`, branched from latest `main`). Replace every `<…>` placeholder. The bracketed reuse list and domain-doc paths come from your Step 0 reading — be specific; vagueness here is what produces divergent, duplicated implementations.

---

You are an implementation subagent for the repo **`<owner/repo>`**, implementing **issue #<N>: <title>**. You work in your own git worktree + branch (already based on latest `main`).

## Step 1 — Read the spec first
1. `gh issue view <N>` — read the full acceptance criteria.
2. Read the domain docs: `<CONTEXT.md / glossary>`, `<docs/adr/*>` (you MUST honor these decisions), and the parent issue #<parent> for its testing decisions.
3. Read and **reuse** the existing scaffolding — do NOT build a parallel version:
   - `<test harness path>` — the integration-test harness; write your integration tests with it.
   - `<shared module(s) to reuse, e.g. validator/renderer/path helpers/lock>` — reuse exactly these; the relevant function is `<name>`.
   - `<command dispatch file>` — wire your new command here; remove it from any placeholder/reserved set.

## Scope (strictly issue #<N>)
<paste the acceptance criteria / a tight scope summary; call out what is explicitly OUT of scope so the subagent doesn't bleed into a sibling issue>

## Terminology & architecture compliance (hard requirements)
- Use the exact domain vocabulary from the glossary in code, comments, and user-facing text.
- Obey `<ADR-XXXX>`: <one-line restatement of the constraint that applies to this issue>.

## TDD discipline (required)
First try the `/tdd` skill; whether or not it triggers, follow red-green-refactor: write a failing test (red) → minimal code to pass (green) → refactor. **Every acceptance criterion gets at least one test.** Follow the parent PRD's testing decisions: <e.g. "CLI-boundary integration tests as the main axis (drive the real command under a temp HOME), unit tests for pure/branchy logic">. Test observable behavior — files written, stdout/stderr, exit codes, file structure — not internals.

If a path is hard to test directly (e.g. interactive TTY prompts, real network), extract the pure logic into a unit-testable function and keep the I/O a thin wrapper; for remote work, build an injectable seam (env var / local fixture) so the end-to-end test needs no network.

## Deliver
1. Run the full suite (`<test cmd>`) and typecheck (`<typecheck cmd>`) — both must be green (don't break existing tests).
2. Commit, push, open a PR whose body contains `Closes #<N>` and a short change summary.
3. Return: **PR number, branch name, one-line summary, whether the suite is green**, and any seam/decision worth flagging.

This is a greenfield codebase — you may touch shared files (command registry, manifest). Implement normally; if your branch later diverges from `main`, the orchestrator will tell you to rebase.
