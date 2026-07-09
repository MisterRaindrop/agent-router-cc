---
description: Reconcile crashed/stale router runs
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" recover --json`

Report which runs were recovered (marked STALE) and which are still running.
