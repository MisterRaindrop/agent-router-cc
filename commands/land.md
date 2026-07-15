---
description: Merge a PASSED dispatch's verified diff into your branch
argument-hint: <task-id>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" land $1`

Confirm the run branch merged into the working tree. Only do this after the user has
reviewed the diff -- landing is the human's decision, not the router's.
