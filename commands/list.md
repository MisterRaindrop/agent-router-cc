---
description: List all router tasks and their states
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" list --json`

Present the tasks grouped by state.
