---
description: Run the router self-test (3 canaries incl. the scope trap)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" selftest --json`

Confirm all three canaries behaved as expected — in particular that the scope-trap
canary was CAUGHT (FAILED). If selftest failed, the gates are not trustworthy.
