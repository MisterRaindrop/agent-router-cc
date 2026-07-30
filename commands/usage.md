---
description: Show token/cost usage across recent router dispatches (last 7 days)
argument-hint: "[--all] [--explain-savings]"
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" usage $ARGUMENTS`

Present the usage report above: the per-dispatch tokens and cost, the `opt` column
(✓ = ran on a model cheaper than the strong baseline, — = ran on the baseline, ? =
unknown model), the TOTAL, the by-executor split, the estimated savings versus an
all-strong-model baseline, and the **Suggestions** section (signal-derived hints
like "sharpen the contract" or "route this to a cheaper tier" -- never fabricated).
If a **By plan** section is present, that is the intuitive view: per plan it shows each
executor task (tokens, cost, real wall time), the executors subtotal, the orchestrator
(main model) row when measured -- or an explicit "not measured" note when it is not --
and then `actual total` vs `if all on <baseline> (est)` and `saved (est)`. Read the
orchestrator figure as **approximate** and the "if all on baseline" / "saved" as
**estimates**, never bills. (The orchestrator row is populated by
`/router:go`'s end-of-run `orchestrator-usage` step; without it, the comparison is
execution-side only.)
Be clear that the savings figure is a **list-price estimate, not a bill** -- the cheap
executors run on plan subscriptions, so the real marginal cost is often lower. The
default window is the last 7 days; mention `/router:usage --all` for older runs and
`/router:usage --explain-savings` for the estimate's assumptions. Costs without a `$`
(plan-auth codex) are token-only, never `$0.00`.
