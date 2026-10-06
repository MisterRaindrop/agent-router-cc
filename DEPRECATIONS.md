# Deprecations

What is on the way out, when it goes, and how to fall back while it is still here.

Everything listed here is **refused by default**. That is deliberate: a deprecated path that
still runs silently gives you two execution models with different behaviour and no way to tell
which one produced a result — and that is far harder to debug six months later than an error
message is today.

## Current state

Current version: **0.16.x**.

**0.15.0 removed the executor model itself**, and with it everything the older entries below
describe: per-task worktrees, the `run` dimension, `--max-parallel`, the dispatch flow, the lock,
the gates and the queue. Those entries stay as a record of what the names used to mean, so a reader
meeting them in an old document or commit can look them up -- none of them describes code that
still exists. The 0.15.0 entry at the end is the one that matters now.

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

## `/router:spec`

**Removed** in 0.10.0, with no stub. Replaced by `/router:design` then `/router:workplan`.

**Why no stub, when `/router:plan` got one:** the two had very different windows. `plan` was
renamed in that same release, so muscle memory for it was current and a stub costs three lines.
`spec` had been marked deprecated since 0.7 and had been pointing at its replacement for many
versions -- by 0.10.0 anyone still typing it was not going to be surprised by it being gone.

Recorded because the asymmetry was decided in passing and never written down, which is how a
reasonable judgement later reads as an oversight. It also breaks one acceptance criterion of the
design/plan-flow plan (`/router:spec` must return a deprecation pointer); that plan's closeout
notes the supersession.

**Fallback:** none. Use `/router:design`.

## The work-plan stage: `/router:workplan`, `/router:plan` and `WORKPLAN.md`

**Removed** in 0.14.0, with no stub.

**Replaced by:** nothing, for the breakdown -- it is agreed in conversation at `/router:go`,
once per feature, and never written to disk. The verification matrix moved into `DESIGN.md` as
its last section.

**Why:** measured over the five plans that used the stage, the document's core deliverable --
the approved package list -- did not survive contact with execution. 28 of 35 listed "work
packages" were main-session steps, which a package contract (`allowed_globs`, line caps, stop
conditions) does not constrain at all; and of 17 real dispatches, 10 were authored outside the
approved list during review rounds and retro-fitted into the document afterwards. The premise
`go` relied on -- "the list was approved at workplan, so skip Touchpoint 1" -- held for under
half the work, while the document itself cost 240-536 lines of main-session drafting plus an
approval round, and carried a four-state machine and a revision binding that had already rotted
(`done` was a status no stage could write until `b616f2f`; the page still pointed at the
`/router:gate` command removed in 0.10.0).

The token argument that first motivated this is **not** among the reasons, because it did not
survive checking: the contract carried the whole work plan verbatim, but at ~21k tokens against
a 3.76M median dispatch input that is 0.6%. Merging dispatches to save cold starts was measured
too and is not established either -- burn rate rises with run length (median 3,172 tok/s under 5
minutes, 4,516 over 10), so a saved cold start trades against a fatter context. **Dispatch
granularity is deliberately unchanged.**

| Item | State |
|---|---|
| `/router:workplan`, `/router:plan` | **gone**, no stub. `plan` was already three versions past its own removal date |
| `WORKPLAN.md` / `PLAN.md` | nothing writes one. `paths.planMd` still **reads** one, so historical plan directories keep reporting the stage they finished in |
| `plan_draft` / `plan_approved` / `executing` / `done` | legacy vocabulary, read-only, in `LEGACY_PLAN_STATUSES` |
| `design_implemented` | **new** terminal design status, written only by `/router:review` -- it replaces `done` |
| `router plans` `revision` column | renamed `workplan`, renders `-` when there is no work plan (now the normal case) |
| `plan_revision` (task.yaml, contract header, delivery header, metrics) | **kept, and keeps its name**: it now pins a task to the `DESIGN.md` revision it was dispatched against. Delivery headers and `metrics.jsonl` are append-only, and a field meaning one thing in old rows and another in new ones is harder to read than a name that is merely imprecise -- the same reasoning that kept `run_id` and `t_worktree` |

**Fallback:** none. An existing `WORKPLAN.md` is no longer read by `/router:go`; the Design is
the bar, and anything the work plan still said that the Design does not must move into it.

## Thin CLI wrappers: `/router:init`, `/router:list`, `/router:result`, `/router:usage`, `/router:models`, `/router:setup-statusline`

**Removed** in 0.14.0, with no stub.

**Replaced by:** the CLI verbs of the same name, which are unchanged -- `router list`,
`router result <id>`, `router usage`, `router models`, `router setup-statusline`. `init` has no
replacement because it never did anything: `.router/` is created on first use by every verb.

**Why:** each one took a slot in the command menu without adding a capability. Five ran one CLI
verb and summarized its output; the sixth printed that it was optional. Eight commands remain,
and each of them does something only a command file can -- drive a multi-step flow, or carry
instructions the main session must follow.

**Fallback:** the plugin does not put `router` on `PATH`. Resolve the bundle in the plugin
cache (its directory is named after the version, so it moves on every update):

```bash
alias router='node "$(ls -d ~/.claude/plugins/cache/agent-router-cc/router/*/ | sort -V | tail -1)dist/router.js"'
```

## The executor model: dispatch, quota routing, gates, metrics, the statusline

**Removed** in 0.15.0, with no stub and no fallback.

**Replaced by:** the main session writing the code itself, and `router write` / `router resume`
launching codex for a part of it when the user names it (`references/codex-writer.md`).

**Why:** this project's own records showed where defects were actually caught -- the main session
reading the whole diff, the main session running the real build, and an independent review -- and
none of that depended on a different process writing the code. Meanwhile the premise the machinery
existed for had already gone: dispatches had drifted to the strongest model (cheap-tier runs went
5 -> 1 -> 0 from July to September 2026), so quota balancing served a goal the tool no longer
pursued, and the dispatch machinery (lock, reclaim, process groups, state guards) was the largest
and most bug-prone part of the repository -- most of the 21 findings in the 0.11.0 review rounds
were in it.

| Removed | Notes |
|---|---|
| CLI: `new`, `dispatch`, `land`, `gate`, `result`, `list`, `usage`, `orchestrator-usage`, `setup-statusline`, `init` | `router resume` is kept but now resumes a `router write`, not a dispatch |
| `.router/tasks/`, `task.yaml`, `TASK_CONTRACT.md`, `DELIVERY.md`, `metrics.jsonl`, `gate.yaml` | ignored if present; nothing reads them |
| quota balancing, weak / strong / critical tiers | `models.yaml` now has `writer:` and `review:`; an old file's `codex.critical` row still sets the writer |
| environment-free gates (scope, secret scan, exec bit), the project gate runner, the queue gate | the main session reads the diff and runs the project's own build |
| the checkout lock, rescue commits, task branches | `router write` commits on your branch and refuses to start over uncommitted work |
| `plan_revision` | there is no task to pin; `/router:go` notes the Design revision it builds against and stops if it moves |
| the PreToolUse guard hook | it protected executor run records, which no longer exist |
| the statusline (quota snapshot and background-activity display) | Claude Code wakes the session when a background command ends; the supervisor's watchdog kills one that stalls. `router supervise` still accepts `--label`, and ignores it |
| `ajv`, `schema/task_contract.schema.json` | the task schema had nothing left to validate |

**If you configured the statusline**, `~/.claude/settings.json` still points at
`statusline/router-usage.mjs` inside an older plugin version. Remove that `statusLine` entry, or
set it back to the command it chained (it was kept in `ROUTER_INNER_STATUSLINE`).

## `/router:go`'s own procedure: Touchpoint 1/2/3 and the floor check

**Removed** in 0.16.0, with no fallback.

**What went:** the slicing confirmation before any code (Touchpoint 1), the instruction to commit
one functional unit at a time, the "search the repository for an existing answer first" rule, and
the closing floor check (read the whole diff, run the full CI chain, a test for every changed line,
never touch the environment, then recommend `/router:review`). The plan-mode gate went with them.

**Replaced by:** nothing. `/router:go` now builds the way the main session would without router. It
still reads an approved `DESIGN.md` and still hands a part to codex when the user names it.

**Why:** measured, and it bought nothing. On real ClickHouse bugs -- the upstream fix reverted, the
upstream issue text as the prompt, the upstream test held out as the oracle -- plain Claude Code and
`/router:go` fixed the same bugs (3 of 4 on the hard tier, all on the easy tier; two runs per cell),
and `/router:go` took about 1.4x the time and cost. Where neither could reproduce the bug, both said
so plainly, so the floor check did not even buy honesty that was otherwise missing.

