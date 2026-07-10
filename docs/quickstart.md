# Quickstart

router turns "have an LLM change my code" into a gated pipeline: an executor
(the `codex` or `claude` CLI) writes a diff inside an isolated git worktree, a
deterministic verifier checks that diff, and only a passing diff is offered for
merge. You write a small machine contract per task; router owns every gate.

> **What router does NOT do:** it does not invent tasks or decompose a vague goal.
> You (or an assistant) author the per-task contract below. router's job is to run
> an executor against that contract and enforce the gates deterministically.

## Prerequisites

- The `codex` CLI or the `claude` CLI, authenticated (a plan subscription is fine;
  no API key needed).
- `router` available as `node /path/to/agent-router-cc/dist/router.js` (the bundle
  is committed; no `npm install` required).
- Your project is a git repo with a real build and/or test command.

## The loop

Run this in your repo. The `examples/minimal/` directory has a complete, runnable
version (implement a `slugify()` function); the commands below mirror it.

### 1. Initialize and write a policy

```sh
router init            # creates .router/ with a template policy.yaml
```

`policy.yaml` is the trust boundary. It names the executor, the file scope an
executor may touch, and the exact verification commands. Every command is an argv
array run without a shell. Minimal, dependency-free example:

```yaml
schema_version: 1
max_concurrent_workers: 1
worker:
  kind: codex            # or: workers: [{kind: codex}, {kind: claude}]  (fallback chain)
scope:
  forbidden_globs: [".router/**", "**/*.lock"]
  test_globs: ["test/**"]        # tests can't be deleted/emptied to fake a pass
  max_changed_lines: 100
verification:
  build:
    - ["node", "--check", "src/slugify.mjs"]
  test:
    - ["node", "--test"]
```

**Commit `policy.yaml`.** router reads it from the frozen `base_sha` git object (not
your working tree), so a run cannot tamper with its own gates.

### 2. Create a task and write its contract

```sh
router new slugify --title "Implement slugify()"
```

This scaffolds `.router/tasks/slugify/{task.yaml,TASK_CONTRACT.md}`. Edit them:

- `task.yaml` -- `allowed_globs` (the ONLY paths the executor may change),
  `max_changed_lines`, and `build_ref`/`test_ref` pointing at the `verification`
  entries in your policy.
- `TASK_CONTRACT.md` -- the human-readable goal and definition of done handed to the
  executor.

Then commit them (`git add -A && git commit`).

### 3. Validate, queue, run

```sh
router validate slugify   # freezes base_sha = current HEAD, hashes the contract
router queue slugify
router run slugify         # spawns a detached, self-supervised worker
```

The worker runs the executor in a fresh git worktree under `.router/worktrees/`,
never in your checkout. It is supervised for wall-timeout, stalls, and crashes.

### 4. Watch, inspect, merge

```sh
router status slugify      # poll until PASSED or FAILED
router result slugify      # the verifier report (per check)
router merge slugify       # only allowed from PASSED; fast-forwards the diff in
```

The verifier runs these checks; any failure => FAILED, nothing merged:

| check | what it enforces |
|-------|------------------|
| `diff_applies`  | the diff applies cleanly to `base_sha` |
| `scope`         | only `allowed_globs` changed, under `max_changed_lines`, no test deletion |
| `secret_scan`   | no leaked keys/secrets in the added lines |
| `build`         | your `build` command exits 0 |
| `test`          | your `test` command exits 0 |
| `contract_hash` | the frozen contract was not altered mid-run |

## Resilience and safety (optional, all opt-in)

Add to `policy.yaml` as needed:

```yaml
workers: [{kind: codex}, {kind: claude}]   # fall over to claude on a quota/rate-limit hit
escalation:
  max_attempts: 2                          # FAILED -> retry -> rescue -> NEEDS_REPLAN
  rescue_worker: {kind: claude, model: claude-sonnet-5}
budget_caps: {max_cost_usd: 1.0}           # refuse new runs once spend passes a cap
```

- **Budget-aware routing:** give a worker a `budget` and router starts each run with
  the executor that has window headroom; see `router routing`. Details in
  `docs/budget-aware-routing.md`.
- **Approval gate:** tasks whose `allowed_globs` touch risky paths (lockfiles,
  `.github/**`, migrations) require `router approve <id>` or `router merge --approve`.
- **Housekeeping:** `router gc` rotates `metrics.jsonl` and removes worktrees for
  terminal tasks. `router stats` reports spend and savings.

## Verified

The deterministic half of this loop (init -> validate -> queue -> run -> verify ->
merge, with the executor stubbed) is exercised by `examples/minimal/` and the test
suite. The executor step itself uses your real `codex`/`claude` CLI.
