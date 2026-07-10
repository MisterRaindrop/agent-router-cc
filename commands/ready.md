---
description: List router tasks whose dependencies are merged and can run now
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" ready --json`

Report which tasks are ready to run (`/router:run <id>`) and which are still blocked
on unmerged dependencies. Drive the batch wave by wave: run everything ready, review
and merge PASSED results, then check ready again until nothing is left.
