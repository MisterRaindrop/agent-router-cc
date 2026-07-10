# Multi-task dispatch: decompose, tier, and gate by dependency (design)

Date: 2026-07-10
Status: approved direction, pre-implementation

## Problem

The point of router is token economy: the expensive orchestrator model (Opus, the
main session) should spend tokens only on decomposition and review, while cheap
executors (Sonnet / codex) spend the execution tokens. Today `router plan` emits a
single task, there is no way to express "task B needs task A merged first", and
executor choice ignores the nature of the task. So a big goal cannot be fanned out
to cheap models with the orchestrator only reviewing results.

## Goal workflow (the user's mental model)

1. A big goal arrives. The main session (or `router plan`) decomposes it into tasks.
2. **Clear** tasks (well-bounded, mechanically checkable) are dispatched to a cheap
   executor. **Unclear** tasks (need judgment/design) are handed back to the main
   session -- they are exactly the work that needs interaction.
3. Tasks with no dependency run in parallel; dependent tasks wait until their
   dependencies are merged.
4. Each finished task is reviewed and merged by the main session (review-level gates
   only -- no environment-dependent commands inside worktrees).
5. When the batch is merged, the main session asks the user how to build/test the
   project and runs one integration verification in the user's real environment.
   Green -> tell the user the next step is ready.

## Design

### 1. Multi-task planning (`router plan`)

The planner prompt asks claude to decompose the goal into **1..N tasks** (one is
fine when the goal is small). Each proposed task carries the existing contract
fields plus two new ones:

- `clarity: "clear" | "unclear"` -- is the task well-bounded and mechanically
  verifiable?
- `depends_on: string[]` -- ids of other tasks in the batch that must be MERGED
  before this one may run.

Output shape: `{ "tasks": [ {task...}, ... ] }`.

### 2. Deterministic batch validation (pure core)

Every task passes the existing single-task checks (known refs, non-broad globs that
match tracked files, sane line caps). New batch-level checks, all pure:

- ids unique within the batch;
- every `depends_on` entry references an id in the batch (v1: no external deps);
- the dependency graph is acyclic;
- `clarity` is one of the two literals.

Any failure rejects the WHOLE batch; nothing is materialized.

### 3. Tiering: label -> executor (deterministic mapping)

The LLM only emits the `clarity` label. Policy owns the mapping:

```yaml
tiers:
  clear: { kind: claude, model: sonnet }   # optional; default = the policy worker chain
```

- `clear` tasks are materialized at DRAFT. If `tiers.clear` is set, that worker is
  written into the task's `task.yaml` (new optional field `worker`) and frozen with
  the contract at validate; at run time it becomes the head of the executor chain
  (the policy chain remains as quota fallbacks).
- `unclear` tasks are **not materialized**. They are returned in the plan report
  (id, title, why-unclear guidance) as a handback list for the main session to
  handle interactively -- clarify, split further, or do directly.

### 4. Dependency gate (deterministic, in `startRun`)

`task.yaml` gains optional `depends_on: string[]`. `router run` refuses to start a
task until every dependency is in state MERGED (checked in the same guard that
enforces caps). Tasks with no unmet dependencies run in parallel, bounded by
`max_concurrent_workers`.

New verb `router ready`: lists QUEUED tasks whose dependencies are all MERGED --
the main session drives waves by running whatever `ready` reports, merging PASSED
results, and repeating until the batch is done.

### 5. Verification placement (resolves the environment concern)

Worktrees only get review-level, environment-free checks by default: diff-applies,
scope, secret scan, contract hash -- the init template's build/test placeholders
(always-pass) stay as-is. Real build/test runs ONCE, at integration time, in the
user's real checkout:

- `/router:init` stays **zero-config**: scaffold, commit, done. It does not ask the
  user anything and requires no edits.
- The build/test conversation happens at the END: when a batch is fully merged, the
  main session asks the user how to build/test (or detects and confirms), runs it
  in the real environment, and reports. Optionally it offers to save the commands
  into `policy.verification` for projects whose tests are worktree-friendly.

This is encoded in the plugin command guidance (`commands/plan.md` and a new
`commands/dispatch.md` or extended flow text), not in the CLI: the CLI never runs
un-whitelisted commands.

### 6. Out of scope (YAGNI)

- A daemon that auto-runs the whole DAG (the main session drives waves).
- Dispatching `unclear` tasks to a headless opus executor.
- Cross-batch / external dependencies.
- Shared worktrees between tasks.

## Compatibility

- A single-task plan is just N=1; existing behavior and output remain valid.
- `depends_on`, `clarity`, and `worker` are optional in `task.yaml`; existing tasks
  are unaffected. Schema files extended accordingly.
- `tiers` is optional in policy; absent means the default worker chain for all.

## Touched surfaces

- `core/planPrompt.ts` (multi-task prompt), `core/planCheck.ts` (batch + DAG checks),
  new `core/depGate.ts` or extension of the startRun guard logic.
- `domain/types.ts` (+ clarity/depends_on/worker fields, batch types), `schema/*.json`.
- `app/plan.ts` (materialize batch, tier mapping, handback report).
- `app/worker.ts` (dependency gate in startRun; per-task worker at chain head).
- `cli/commands.ts` (`plan` output, new `ready` verb, help).
- `commands/plan.md` (+ wave-driving and integration-verification guidance),
  `commands/init.md` (drop any "edit policy now" ask), new `commands/ready.md`.
- Tests: pure DAG/tier checks, fake-planner multi-task e2e, dep-gate e2e, ready.

## Verification

- Pure: batch validation (dup ids, unknown dep, cycle, bad clarity), tier mapping.
- e2e (fake planner + fake executors): plan a 3-task batch with one dependency and
  one unclear task -> two DRAFT tasks + one handback; run wave 1 in parallel ->
  PASSED -> merge; `ready` then exposes the dependent task; dep gate refuses early
  runs; second wave completes.
- Gate: `npm run check` green, rebuilt `dist/router.js`, `selftest PASSED`.
