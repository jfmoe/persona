---
name: land-issues
description: Orchestrate subagents to implement and merge a whole set of tracker issues end-to-end, respecting their dependency graph. Use this whenever the user has a batch of issues to land — especially right after `to-issues` produces them — or says things like "implement all the issues", "land the tracker", "orchestrate subagents to build these out", "ship issues #4-#8", or "drive these to merged PRs". Use it even when the user only implies a multi-issue build-out rather than naming this skill.
---

# Land Issues

Take a set of tracker issues — typically the slices `to-issues` just created — and drive every one to a reviewed, merged PR. You are the **orchestrator**: you do not write the feature code. Your leverage is dispatching one implementation subagent per issue, reviewing each PR hard, confirming and fixing what's wrong, and merging in dependency order.

The single most important mindset: a subagent reporting "all tests green" is **necessary, not sufficient**. The highest-value defects — injection, path traversal, dangling state, unmet acceptance criteria — routinely pass the implementer's own tests. Your independent review is where that gets caught. Treat every PR as guilty until reviewed.

## When this fits

- A batch of issues exists on the tracker, each with acceptance criteria and (usually) a `Blocked by` dependency list.
- `gh` CLI is authenticated; `main` is clean; the test suite runs locally.
- The repo has enough scaffolding (skeleton, test harness, shared modules) that issues are *vertical slices to build on*, not a blank page.

If issues don't exist yet, that's `to-issues`' job — run that first.

## Mental model: dependency-graph waves

Build the graph from each issue's `Blocked by`. Then work in **waves**:

- **Wave 1**: every currently-unblocked issue, dispatched in parallel.
- Merging an issue **unlocks** its dependents → dispatch those next.
- Independent chains run concurrently; within a chain, strictly serial (downstream branches from the *merged* result of upstream).

Example from a real run: `#4→#5` and `#6→#7→#8` were two chains. Wave 1 = `#4` + `#6` in parallel. When `#4` merged, `#5` started; when `#6` merged, `#7`; `#7` merged → `#8`. The two chains advanced concurrently.

## Step 0 — Read specs and find reuse points (once, up front)

Before dispatching anything, read the things every subagent will need so you can hand them precise instructions instead of making each one rediscover the repo:

- `gh issue view <N>` for **every** issue — acceptance criteria and `Blocked by`.
- Domain docs: `CONTEXT.md` / glossary, `docs/adr/*` (architectural decisions the code must honor), `CLAUDE.md`/`AGENTS.md`, and the parent **PRD/epic** issue (it usually states *testing decisions* — e.g. "CLI-boundary integration tests as the main axis, unit tests for pure logic").
- The existing **skeleton, test harness, and shared modules**. Note the concrete reuse points (validators, renderers, a temp-HOME test harness, path helpers, a lock/ledger module). This list is the biggest quality lever you have — telling each subagent *exactly which existing code to reuse instead of rebuild* prevents divergent, duplicated implementations.

## Step 1 — Dispatch one implementation subagent per issue

Use the Agent tool: **model `sonnet`**, **`isolation: "worktree"`** (each issue gets its own branch/worktree so parallel work can't collide on shared files), branched from the **latest `main`**. Dispatch independent issues in a single message so they run concurrently; for very long runs use `run_in_background`.

Fill in and send the template in `references/implementer-prompt.md`. It bakes in the non-negotiables: read the issue + domain docs first, reuse the named existing modules, TDD red-green-refactor with at least one test per acceptance criterion, terminology/ADR compliance, run the full suite, open a PR with `Closes #N`, and return PR number / branch / one-line summary.

## Step 2 — Review every returned PR (this is the job)

For each PR, do all three:

1. **Run a code-reviewer subagent** on the diff (`references/reviewer-prompt.md`). Point it at the worktree path and the issue. Tell it the focus areas: security (injection, path traversal, deletion safety), correctness, **each acceptance criterion actually satisfied**, ADR/terminology compliance, and any change to **shared infrastructure** (test harness, build config, command registry) which can silently break other slices.
2. **Run the test suite yourself in that worktree**, and skim the key implementation files. Don't outsource your eyes entirely.
3. **Confirm the findings.** Classify each as blocking or non-blocking. Record explicitly what you choose **not** to fix and **why** (out of MVP scope; the "fix" would introduce worse behavior — e.g. a version-gate that drops data; a latent issue that can't fire given current constraints). Stating the non-fixes is part of a faithful review.

## Step 3 — Fix the blocking findings

Two modes — pick per the user's preference (ask once if unsure; some users want you hands-on, some want the subagent to redo it):

- **Send it back to the implementer subagent.** If you can continue the same agent (e.g. a SendMessage/continue capability), give it specific, itemized feedback. If you *can't* continue it, spawn a fresh `sonnet` subagent pointed at the **existing worktree path** (plain Agent call, **not** `isolation: worktree`, which would create a new one) and have it push to the same branch/PR.
- **Fix it yourself** directly in the worktree.

Either way: re-run `npm test`/the suite **and** typecheck after fixing, and add a test for each fix (every bug becomes a regression test).

## Step 4 — Merge, then unlock downstream

Merge **one PR at a time**:

1. Check mergeability (`gh pr view <N> --json mergeable,mergeStateStatus`).
2. If the branch diverged from `main` (common when several branches touch a shared file — command dispatcher, `package.json`, a module one branch extracted), **rebase onto latest `main`** and resolve conflicts (see playbook below), re-run the suite + typecheck, then `git push --force-with-lease`.
3. `gh pr merge <N> --squash` (the PR body's `Closes #N` closes the issue). Pull `main` locally.
4. Clean up the merged worktree and branch (`git worktree remove --force`, `git worktree prune`, `git branch -D`).
5. **Only now** dispatch the issues this one unblocked — those subagents branch from the freshly-updated `main`.

## Conflict-resolution playbook (greenfield / shared files)

Multiple slices on a young codebase will collide. The reliable resolution: **take the already-merged mainline structure, then re-apply only the incoming branch's unique semantic change.** Specific traps seen in practice:

- **Command registry / dispatcher**: keep both command registrations; the conflict is usually just adjacent lines.
- **Extracted shared module**: if one branch pulled `lock`/`config`/etc. into its own file, the shared module's types must accommodate **every** variant other branches added (e.g. widen a `LockEntry` to a `local | github` union). Make the extracted module the single source of truth and have callers import from it.
- **Name collisions**: a local variable can shadow a newly-imported helper of the same name (e.g. `const lockPath = …` vs an imported `lockPath()` function) — rename the local.
- **Dropped braces**: when you delete a whole conflict region, it's easy to remove a function's closing `}`. After resolving, grep for leftover markers AND run typecheck before trusting it.

## Closing out

- Verify: all issues `CLOSED`, no open PRs, a single clean `main`, full suite green, merged worktrees pruned.
- Offer to close the parent **PRD/epic** once all child issues land — it's a one-shot delivery tracker, and leaving it open with all children done is just noise (trivially reopened if they want a living board).

## Principles (the "why")

- **Stay the orchestrator.** Your value is dispatch + review + merge discipline, not hand-writing features. Resist the urge to implement.
- **Reuse beats rebuild.** The biggest lever on quality and consistency is naming, in each dispatch, exactly which existing modules/harness/validators to reuse.
- **Independent review catches what tests miss.** Always review for security and acceptance-criteria coverage even when the suite is green.
- **Serialize merges, rebase downstream.** One merge at a time; downstream always branches from the latest `main`.
