---
description: Run one task synchronously on the quota-picked executor to a verified diff
argument-hint: <task-id>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" dispatch $1 --json`

The task ran in the foreground on whichever executor had more real remaining quota
(codex vs sonnet), and its diff was mechanically verified. Report the executor used,
each verifier check's pass/fail, and tokens/cost. On PASSED, tell the user to review
the diff (`/router:result $1`) and then `/router:land $1` to merge; on FAILED, show
why. Nothing is merged until the user lands it.
