---
description: Continue a task's prior executor session with feedback (no cold restart)
argument-hint: <task-id> --feedback "<what to fix>"
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" resume $ARGUMENTS`

Confirm the resume **re-attached to the same executor session** (context retained) rather
than cold-restarting, and report the new verifier result. If it says "RESUME DID NOT
RE-ATTACH", the executor started a fresh session and nothing was committed -- re-dispatch
the task instead. Then read the diff and review it as usual before landing.
