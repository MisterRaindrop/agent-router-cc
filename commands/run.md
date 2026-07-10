---
description: Validate, queue, and run a drafted router task in a detached worker
argument-hint: <task-id>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" validate $1 && node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" queue $1 && node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" run $1`

This froze the task's base_sha, queued it, and launched a detached, supervised
worker. Tell the user to poll `/router:status $1` until PASSED or FAILED, then
`/router:result $1` to see the verifier report. Nothing merges until they run
`/router:merge $1`.
