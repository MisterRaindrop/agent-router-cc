---
description: List router tasks with their last status and whether a worktree remains
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" list`

Summarize the tasks above: each task's last verifier status, and flag any that still
have a worktree (dispatched but not yet landed) -- those hold uncommitted work and are
what a future `router clean` would target.
