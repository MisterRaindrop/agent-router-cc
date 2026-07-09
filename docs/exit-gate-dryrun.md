# Exit-gate dry run (token proxy)

A harness shake-out on a small **real** repo (a `calc` library with dependency-free
`node --test` / `node --check` build+test). Two genuinely-verifiable tasks were run
both ways. Cost is token-proxy: codex is logged in via ChatGPT (no per-token
price), so `cost_usd` is null and we compare token counts.

## Setup

`src/calc.mjs` shipped with a bug and a gap, each covered by a failing test:
- `subtract` missing → `test/subtract.test.mjs` red
- `multiply` returns `a+b` → `test/multiply.test.mjs` red

A task passes only if, editing `src/**` only, its test goes green.

## Results

### router (codex executor under the deterministic harness)

| task | verifier | tokens in / out | wall |
|------|----------|-----------------|------|
| impl-subtract | PASSED (5/5 checks) | 51,652 / 938 | 35 s |
| fix-multiply  | PASSED (5/5 checks) | 49,827 / 1,251 | 35 s |
| **total (2 tasks)** | **2/2 verified, first-pass 100%** | **≈101,479 / 2,189 codex** | 70 s |

Opus in the execution loop: **≈0** — the router path is deterministic CLI + codex;
Opus is not invoked during a run. Both edits were correct (`subtract = a-b`,
`multiply = a*b`).

### Opus-direct baseline (Opus does the work itself)

Both tasks in one session: **18,523 Opus tokens**, 3 tool calls, 18 s.

## Reading it — verdict: inconclusive on token proxy alone

This is exactly the case the runbook warns about: the two paths use **different
models**, so raw token counts are not comparable as cost.

- router shifts the work **off Opus (expensive) onto codex (cheaper executor)** and
  keeps Opus out of the loop entirely.
- It spends **~5.5× more tokens**, but on a model that should be materially cheaper
  per token.

Whether router is cheaper **per verified task** therefore hinges on the codex-vs-Opus
price ratio: router wins iff codex's effective $/token is more than ~5.5× below
Opus's (before counting that router's first-pass rate here was 100%, i.e. no retry
tax). That number cannot be decided from token counts alone.

## To make it a real go/no-go

Run the **real-USD mode** from `M1-exit-gate.md`: API-billed codex with
`ROUTER_PRICE_INPUT_PER_MTOK` / `ROUTER_PRICE_OUTPUT_PER_MTOK` set, plus an Opus
price, then compare `router stats` `costPerVerifiedTask` against the Opus-direct
dollar cost — on ~10 tasks in a real target repo. What this dry run establishes is
only that the harness produces those numbers end-to-end, on a real repo, with real
codex, and that the gates hold (`router selftest` — scope trap caught).
