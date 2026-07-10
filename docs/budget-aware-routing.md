# Budget-aware executor routing (design, M2)

## Problem

Under a plan (codex/ChatGPT), the provider exposes **no scriptable quota** — you
cannot read the remaining limit before a run (confirmed: no `codex usage`/`status`;
the weekly-limit % is interactive-TUI only). But router **does** record per-run token
usage. So: estimate consumption locally against a calibrated rolling-window budget,
pick the executor per run to stay under the limit, and use a real limit error as the
ground-truth backstop AND the calibration signal.

Note: under a plan, "cost" is really a **quota fraction**, not dollars. Selection
optimizes quota headroom. Real USD appears only for priced executors (list price via
`ROUTER_PRICE_*`, or an API executor with real per-token pricing).

## Signals available

- `metrics.jsonl` — per run: `{ ts, model, tokens_input, tokens_output, exit_class }`
  (already recorded).
- API executors only: `anthropic-ratelimit-*` response headers = real remaining
  requests/tokens + reset (the API path can be checked proactively; a plan path cannot).

## Components

1. **Rolling ledger** — `consumed[executor]` = sum of tokens in `[now - window, now]`
   from `metrics.jsonl` (a sliding sum over timestamps; model 5h and/or weekly windows).
2. **Budget model per executor** — `{ window, budget_tokens, switch_at }` in policy
   (e.g. `window: 5h`, `switch_at: 0.9`). `budget_tokens` is seeded from a guess and
   self-calibrated (below).
3. **Cost model** —
   - plan executor: `cost = consumed / budget_tokens` (a quota fraction).
   - priced executor: `cost_usd = tokens * price` (from `ROUTER_PRICE_*` or API).
4. **Per-task estimate** — `E` = trailing average tokens/task (optionally by a
   size/risk class), from the ledger.
5. **Selection (each run — cheapest that fits)** — over the ordered executor chain,
   pick the first whose projected `consumed + E <= switch_at * budget_tokens` AND that
   satisfies routing constraints (risk / verifiability). Otherwise the next executor.
   If none fit: wait for the window to roll off, or fail `budget_exhausted`.
6. **Record** — emit the decision (chosen executor, `E`, ledger snapshot, projected
   headroom) into events/metrics for audit and calibration.

## Self-calibration (the key part)

The plan's real limit is opaque and can change, so don't trust a static guess:

- Ground truth = a real limit error (HTTP 429 / usage-limit) => classify as
  `quota_exhausted` (does NOT count as an escalation attempt).
- On that event, snapshot the window's consumed tokens at that moment =>
  `observed_ceiling`.
- Move `budget_tokens` toward `observed_ceiling` (EMA), minus a safety margin.

=> the budget **learns** the real ceiling over time instead of trusting the seed.

## Honest limits

- The local ledger only counts router's own usage; other consumers (interactive
  codex, ChatGPT elsewhere) make it undercount — keep a conservative margin and
  always keep the reactive backstop.
- Cache metering is unknown (codex input is ~80% cached); track raw and cached
  separately and calibrate against observed 429s (which reflect however the plan
  actually meters).
- The window is a sliding sum; 5h and weekly are both modelable (take the binding one).

## Fits existing seams

`WorkerKind` + `WorkerLauncher` abstraction, `policy.worker` (extend to an ordered
chain), `MetricRecord.model`, `exitTaxonomy` (add non-counting `quota_exhausted`),
and the state-machine escalation transitions. The mechanical verifier + escalation
ladder remain the correctness backstop that makes "try the cheapest executor first"
safe: a wrong cheap output is caught by the gate, never merged.

## Status

M2. Order of implementation:
1. Reactive `quota_exhausted` detection + executor fallback chain (correctness; the
   prerequisite). **DONE** — `policy.workers` is an ordered chain; a worker that fails
   with a quota/rate-limit signature (`policy.quota_error_pattern`, default covers
   429 / rate limit / usage limit / quota) is reclassified `quota_exhausted` (and,
   like `env_error`, does not count as an attempt); the run resets the worktree and
   falls through to the next executor. See `reclassifyQuota` (core) and the fallback
   loop in `runWorkerBody`. Two real plan-auth executors exist: `codex` (`codex exec
   --json`) and `claude` (`claude -p --output-format stream-json --permission-mode
   bypassPermissions`); each parses its own log for usage/model/cost, and claude
   reports `total_cost_usd` directly. Neither needs an API key. e.g.
   `workers: [{kind: codex}, {kind: claude}]`.
2. Rolling-window ledger + per-task estimate + budget-aware selection (proactive
   layer on top). *(next)*
3. Self-calibration of `budget_tokens` from observed limit errors.
