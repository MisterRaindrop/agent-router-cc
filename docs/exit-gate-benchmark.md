# Exit-gate benchmark (controlled, token proxy)

A larger, controlled shake-out of the exit gate on a self-contained, dependency-free
project (a `toolkit` library with a real `node --test` suite). Ten genuinely
verifiable tasks — 7 bug-fixes and 3 implementations, each with a failing test that
only goes green if the task is actually done — were run through router with real
codex; five of them were also run Opus-direct as a baseline.

This is a **controlled benchmark, not the real DB-kernel gate** (the tasks are far
easier than kernel work). It establishes the method and the shape of the numbers.
Cost is a token proxy: codex is logged in via ChatGPT (no per-token price).

## Method (reproducible on any repo)

1. A repo whose `build`/`test` run in a fresh git worktree with no install
   (`node --check` / `node --test <file>`).
2. `router init`, whitelist the real build/test in `.router/policy.yaml`, commit it.
3. For each task: `router new/validate/queue/run`, tight `allowed_globs`, a clear
   `TASK_CONTRACT.md`; poll to PASSED/FAILED.
4. Baseline: run the same tasks Opus-direct and record token usage.
5. Compare with `router stats` (token proxy here; real USD via `ROUTER_PRICE_*`).

No task touched anything outside its isolated worktree; nothing was merged.

## Results

### router + real codex — 10 tasks

| metric | value |
|---|---|
| verified (verifier PASSED) | **10 / 10** |
| first-pass rate | **100%** |
| env errors | 0 |
| codex tokens / task | ~54,116 in + ~1,036 out (~55.2k total) |
| wall / task | ~31 s |
| Opus tokens in the loop | **0** (deterministic CLI + codex) |

codex input is heavily cached (~80% `cached_input_tokens` in observed `turn.completed`
usage), so effective *billable* input is well below the raw 54k.

### Opus-direct baseline — 5 tasks (subtract, maxOf, factorial, clamp, uniq)

All 5 PASS. Tokens/task (as reported by the runner): 18,586 / 18,604 / 18,611 /
18,912 / 18,931 → **avg ~18,729 tokens/task**, ~20 s/task. (Very flat — dominated
by fixed agent + repo-read overhead, which is exactly the per-task tax router shifts
off Opus.)

## Verdict — favorable structurally; $ still needs list prices

Raw tokens are **not** a like-for-like cost (different models, different accounting),
so on tokens alone this is inconclusive as dollars. But the structural picture is
clear and favorable:

- **Opus is fully offloaded** — 0 Opus tokens per task; all execution runs on the
  cheaper codex/ChatGPT quota.
- **100% first-pass verified** — no retry/escalation tax in this set.
- **The gates held** — `router selftest` passes (scope trap caught); every run
  cleared all five mechanical checks.

The go/no-go reduces to a price ratio. With per-token prices `Pc` (codex, blended,
crediting cached input) and `Po` (Opus, blended), router wins per verified task iff:

```
55.2k * Pc_effective   <   18.7k * Po
```

i.e. router is cheaper whenever codex's effective $/token is below ~1/3 of Opus's —
and codex's heavy input caching pushes `Pc_effective` down further. For a real
figure, set `ROUTER_PRICE_INPUT_PER_MTOK` / `ROUTER_PRICE_OUTPUT_PER_MTOK` to current
list prices (accounting for cached-input pricing) and read `router stats`
`spentUsdPerVerifiedTask`, then compare to the Opus-direct dollar cost.

## Caveats

- Controlled, easy tasks → 100% first-pass is optimistic; a real repo will have a
  lower first-pass rate and some escalation, which raises router's cost per verified
  task. Re-run on the target repo before trusting the number.
- Token accounting differs between the two runners; treat the comparison as
  directional, not exact.
- Wall-clock is advisory (network-bound, shared machine).
