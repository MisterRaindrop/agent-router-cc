---
description: Run one task synchronously on the quota-picked executor to a scope-gated diff
argument-hint: <task-id>
allowed-tools: Bash, Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" dispatch "$ARGUMENTS" --json`

The task ran in the foreground on whichever executor had more real remaining quota
(codex vs claude), in an isolated worktree, and its diff cleared the CLI's
*environment-free* gates (applies cleanly + scope + secret scan). The CLI did **not**
run a build or tests -- that is yours. Now **read the diff and review it**: is it
correct? did it drift from the intended change? are the tests real assertions (not
hollow/hardcoded), and is the changed code covered? A cheap model can clear a shallow
gate while being lazy or wrong. If it is low-risk and clean, tell the user to
`/router:land <task-id>`. If it is high-risk or you are unsure, **verify it yourself in
the real environment first** -- run the build/tests with Bash, read the full output, and
judge it (don't compress it, don't trust the mechanical gate alone) -- then land. If it
is wrong, re-dispatch with a sharper contract or take it over.
