# Code-reviewer subagent prompt template

Spawn one per PR (Agent tool, `subagent_type: feature-dev:code-reviewer` if available, else a `sonnet` general agent; **no** worktree isolation — it reads the existing worktree). Replace `<…>`. The point of this pass is to find what the implementer's own green tests didn't: security holes, unmet acceptance criteria, and shared-infra breakage.

---

Review the git diff for a feature implementation. Worktree: `<absolute worktree path>`.

See the change: `git -C <worktree path> diff main...HEAD`

This implements **issue #<N>: <title>**. Read the acceptance criteria with `gh issue view <N>`, and read `<CONTEXT.md>` + `<relevant ADRs>` in that worktree for the domain rules it must obey.

Focus on **high-confidence** findings in these areas:

1. **Security** (highest priority): command/shell injection (args passed to a shell string instead of an argv array), path traversal / unsafe ids feeding `join` + `rm`/write, deletion of files the CLI doesn't own, secret handling. For any destructive op, ask: can a hostile input reach it before validation?
2. **Correctness**: edge cases, off-by-one in any discovery/recursion, overwrite/merge semantics (does "replace" actually replace, or silently merge and leave stale state?), error handling on malformed input (does a structurally-valid-but-wrong file crash it?).
3. **Acceptance criteria**: go criterion by criterion — is each one *actually* satisfied by the code, or only stubbed/claimed? Flag any that are unmet (e.g. an interactive branch that just prints and exits instead of prompting).
4. **ADR / terminology compliance**: does it stay within the documented architectural boundaries and use the glossary terms correctly?
5. **Shared-infrastructure changes**: if the diff touches the test harness, build config, or a shared module, scrutinize whether the change is correct, necessary, and can't break sibling slices. Explain the risk.

Report concrete findings as `file:line — what's wrong — why it matters`, with a rough confidence. Don't nitpick style. Be concise; a short "verified correct" list is fine for things you checked and cleared. **Do NOT modify any files** — review only.
