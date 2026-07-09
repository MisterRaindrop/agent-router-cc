---
description: Show router metrics (cost per verified task, first-pass rate, escalation rate)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" stats --json`

Report the honest headline: cost per verified task vs the Opus-direct baseline.
