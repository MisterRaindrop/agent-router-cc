---
description: Show token/cost usage across recent router dispatches (last 7 days)
argument-hint: "[--all] [--explain-savings]"
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" usage $ARGUMENTS`

Present the usage report above: the per-dispatch tokens and cost, the TOTAL, the
by-executor split, and the estimated savings versus an all-strong-model baseline.
Be clear that the savings figure is a **list-price estimate, not a bill** -- the cheap
executors run on plan subscriptions, so the real marginal cost is often lower. The
default window is the last 7 days; mention `/router:usage --all` for older runs and
`/router:usage --explain-savings` for the estimate's assumptions. Costs without a `$`
(plan-auth codex) are token-only, never `$0.00`.
