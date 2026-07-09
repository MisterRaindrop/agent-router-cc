---
description: Cancel a router task (kills its worker if running)
argument-hint: <task-id>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" cancel $1 --json`
