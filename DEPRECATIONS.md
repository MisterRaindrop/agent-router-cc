# Deprecations

What is on the way out, when it goes, and how to fall back while it is still here.

Everything listed here is **refused by default**. That is deliberate: a deprecated path that
still runs silently gives you two execution models with different behaviour and no way to tell
which one produced a result — and that is far harder to debug six months later than an error
message is today.

## Removal window

Current version: **0.9.x**. Everything below is removed in **0.11.0**.

It goes early if either is true:

- **Ten consecutive real tasks** complete on the branch execution model with no fallback used.
- **2026-10-01** passes.

"Kept for one version" means *the code is still here and the escape hatch still works*. It does
**not** mean the path is maintained: bugs in it are not fixed, and it is not covered by new
tests. If you need it, you need it to get unstuck, not to keep working in.

## Per-task git worktrees

**Replaced by:** the repository root plus a dedicated `router/<task-id>` branch.

**Why:** a fresh worktree has no dependencies, no build objects and no configure output, so a
real project cannot compile in one. This repository only got away with it because the worktree
sat under `.router/worktrees/`, inside the repo, where Node's upward module resolution found the
root's `node_modules` by accident. A C project has no such fallback — a new worktree is a full
rebuild — and the build has to happen in the main checkout anyway, which then adds a "carry the
code back" step. The isolation was never the point; being able to build was.

| Item | State |
|---|---|
| `io/git.ts` `worktreeAdd` | refuses unless `ROUTER_ALLOW_WORKTREE_MODE=1` |
| `io/paths.ts` `worktree(id, run)` | `@deprecated`; still returns a path |
| `.router/worktrees/` scaffolding | no longer created |
| `hooks/guard-router-state.mjs` worktree exemption | dead while the branch model is in use; kept so the fallback still works |

**Not deprecated:** `worktreeAddDetached`. The verifier makes a throwaway detached worktree to
check whether the patch applies onto `base_sha`. That is scratch space for one command, not an
executor's working copy, and it stays.

**Fallback:** `ROUTER_ALLOW_WORKTREE_MODE=1`. Note that only the git helper comes back; the
dispatch flow itself no longer has a worktree path, so this is a way to unblock a script that
calls the helper directly, not a way to restore the old execution model. To restore that, revert
to before the branch-model commits.

## The `run` dimension

**Replaced by:** run artifacts directly under `.router/tasks/<id>/`.

**Why:** `runs/run-001/` was a directory level over a constant. Dispatch has been one attempt
per task since the synchronous model landed, so the dimension only ever held one value while
making every path two segments deeper than the thing it described.

| Item | State |
|---|---|
| `io/paths.ts` `runId(n)` | `@deprecated`; still formats `run-001` |
| `io/paths.ts` `runBranch(id, run)` | `@deprecated`; use `taskBranch(id)` |
| `runs/run-001/result.json` | **read-only fallback** in `store.readResult`, via `legacyResultJson` |
| `MetricRecord.run_id` | kept, not deprecated — see below |

The read fallback is not on the removal schedule above: it exists so upgrading does not make an
existing task's history vanish, and it costs one `existsSync`. It goes when the artifacts it
reads are no longer plausibly on anyone's disk.

`MetricRecord.run_id` stays because `metrics.jsonl` is append-only history. A field that means
one thing in the old rows and another in the new ones is harder to read than a constant, and
nothing branches on it. The same reasoning keeps the `t_worktree` timing name even though that
phase now rescues work and cuts a branch: renaming a timing field mid-file would split the
history it records.

## `--max-parallel`

**Removed already** — refused by name rather than ignored, because silently accepting a dead
flag is how a caller ends up believing four executors ran when one did.

**Why:** parallel dispatch cost almost nothing to run (measured: 0.26s of orchestration against
393s of executor time) and a great deal to supervise. Several executors editing at once means
tracking who changed what, in what order things merge, and whether merging them breaks each
other — and every result still needs reviewing one at a time, so review was the bottleneck the
parallelism kept feeding.

**Fallback:** none. Run the tasks in sequence.
