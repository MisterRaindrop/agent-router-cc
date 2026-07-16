---
description: Run one task synchronously on the quota-picked executor to a verified diff
argument-hint: <task-id>
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" dispatch $1 --json`

The task ran in the foreground on whichever executor had more real remaining quota
(codex vs claude), and its diff was mechanically verified (the task's `verify` command
+ scope + secret scan). Now **read the diff yourself and review it** -- a cheap model
can pass the tests while being lazy or wrong; do not trust a mechanical PASS alone.
If it is good, tell the user to `/router:land $1`; if not, re-dispatch or take it over.
