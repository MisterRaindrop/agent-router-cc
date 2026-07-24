---
description: Show a router run's verifier result and log tail
argument-hint: <task-id>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" result "$ARGUMENTS" --json`

Summarize the exit class, each verifier check, and anything notable in the log tail.
