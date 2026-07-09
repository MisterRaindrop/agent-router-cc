---
description: Show a router task's status, current run, and recent events
argument-hint: <task-id>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" status $1 --json`

Summarize the task's state, current run, and the recent event history.
