---
description: List router tasks with their last status and whether the task branch remains
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" list`

Summarize the tasks above: each task's last verifier status, and flag any whose task branch
is still present -- that branch holds work which has been verified but not merged, so it is
either waiting for review or was forgotten. `router land <id>` merges and deletes one;
`git branch -D <branch>` discards it.

A `-` in the branch column on an old task is expected rather than a problem: runs from before
the branch model used `router/<id>/run-001`, which no longer matches the `router/<id>` name.
