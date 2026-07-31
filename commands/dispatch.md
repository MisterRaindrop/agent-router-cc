---
description: Run one or more tasks on the quota-picked executor to a scope-gated diff (several run concurrently)
argument-hint: <task-id> [<task-id> ...] [--max-parallel <n>]
allowed-tools: Bash, Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" dispatch $ARGUMENTS --json`

Each task ran in the foreground on whichever executor had more real remaining quota
(codex vs claude), in its own isolated worktree, and its diff cleared the CLI's
*environment-free* gates (applies cleanly + scope + secret scan). **Several task ids run
concurrently** -- one worktree and run branch each -- so the wall clock is the slowest task
rather than the sum; `--max-parallel <n>` caps how many are in flight. Passing ids that
depend on each other, or whose `allowed_globs` overlap, is a mistake: land the prerequisite
first instead.

The CLI ran a build or tests only if that task's `task.yaml` set `verify` -- and even then
it answered "did it run and pass", never "is it right". Now **read each diff and review
it**: is it correct? did it drift from the intended change? are the tests real assertions
(not hollow/hardcoded), and is the changed code covered? A cheap model can clear a shallow
gate while being lazy or wrong. If it is low-risk and clean, tell the user to
`/router:land <task-id> [<task-id> ...]`. If it is high-risk or you are unsure, **verify it
yourself in the real environment first** -- run the build/tests with Bash, read the full
output, and judge it (don't compress it, don't trust the mechanical gate alone) -- then
land. If it is wrong, prefer `/router:resume <task-id>` with feedback (its session keeps
its context), re-dispatch with a sharper contract, or take it over.
