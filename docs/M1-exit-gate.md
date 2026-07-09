# M1 Exit Gate - runbook

> The single most important check in M1. **If router does not lower the cost per
> verified task versus Opus running the task directly, stop and redesign** - no
> later milestone can fix a wrong premise.

## What we measure

The honest headline metric is **cost per verified task** = sum cost / number of runs
whose mechanical verifier PASSED. Supporting metrics: first-pass verifier rate,
escalation rate, wall-clock, and env-error rate. All are produced by
`router stats` from `.router/metrics.jsonl` (one record per run).

### Cost measurement modes

- **Token proxy (default under ChatGPT-auth codex):** codex logged in via ChatGPT
  has no per-token price, so `cost_usd` is null. Compare **input+output token
  totals** (and wall-clock, first-pass rate) instead. Good enough to see whether
  router is in the right ballpark.
- **Real USD (API-billed codex):** run codex with an API key and set
  `ROUTER_PRICE_INPUT_PER_MTOK` / `ROUTER_PRICE_OUTPUT_PER_MTOK` (dollars per
  million tokens). `router stats` then reports real `costPerVerifiedTask`. This is
  the faithful form of the gate.

## Procedure

1. **Pick a real repo** whose `build` and `test` commands actually run in a fresh
   `git worktree` checkout. Dependency-free commands (e.g. `node --test`,
   `node --check`, a checked-in `bench/run.sh`) avoid per-worktree install cost;
   otherwise pre-warm a shared cache (ccache / per-task `CARGO_TARGET_DIR`), and
   never share a target dir between concurrent runs of the same crate.

2. **`router init`** in the repo, then edit `.router/policy.yaml`:
   - `verification.build` / `verification.test` = the real whitelisted commands.
   - `scope.forbidden_globs` (org bans), `scope.test_globs`, `scope.max_changed_lines`.
   - Commit `.router/policy.yaml` (the verifier reads it from the base_sha git
     object, not the worktree).

3. **Author ~10 tasks** that are genuinely verifiable - the repo's tests must go
   green only if the task is actually done. Good sources: a currently-failing test
   to make pass, a bug with a reproducing test, a small feature with a test.
   For each: `router new <id>`, fill `task.yaml` (tight `allowed_globs`,
   `build_ref`/`test_ref`) and `TASK_CONTRACT.md` (Goal + Definition of Done),
   then `router validate <id> && router queue <id> && router run <id>`.
   Poll `router status <id>` (or `/router:status`) until PASSED/FAILED.

4. **Record the Opus-direct baseline.** Run 2-3 of the same tasks with Opus doing
   the work directly (no router), and record its token/cost + wall for each. This
   is the denominator. Keep the tasks identical so the comparison is fair.

5. **Compare.** `router stats --json`. Gate passes only if
   `costPerVerifiedTask` (or the token proxy) is meaningfully **below** the
   Opus-direct baseline, at an acceptable first-pass/verifier rate.

## Go / no-go

- **Go (proceed to M2):** router's cost per *verified* task is clearly lower, and
  the verifier is catching bad diffs (confirm with `router selftest` - the scope
  trap must FAIL). Orchestration overhead + retries are paid back by cheap
  executor models doing verified work.
- **No-go (stop, redesign):** router costs the same or more once you count retries
  and orchestration, or first-pass rate is so low that escalation dominates. The
  premise ("cheap models under a deterministic harness beat Opus-direct") is wrong
  for this workload - fix that before building M2/M3.

## Notes

- `router selftest` is a fast, free proxy for gate integrity (no real codex) - run
  it in CI. A green exit-gate with a leaking selftest is meaningless.
- Laptop/thermal noise makes wall-clock advisory; run the gate on a quiet machine.
