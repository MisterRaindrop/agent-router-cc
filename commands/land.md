---
description: Merge one or more PASSED dispatches' verified diffs into your branch
argument-hint: <task-id> [<task-id> ...]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" land $ARGUMENTS`

Confirm the run branches merged into the working tree. Several ids merge sequentially in
the order given; if one fails, that merge is aborted and the tree restored, while the ids
already merged stay merged -- the output says which. Only do this after the user has
reviewed the diffs -- landing is the human's decision, not the router's.
