---
description: Merge a PASSED router task's verified diff into your branch
argument-hint: <task-id>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" merge $1`

If the merge succeeded, confirm the run branch was merged. If it was blocked because
the task is high-risk (its scope touches sensitive paths), do NOT bypass the gate --
tell the user to review the diff (`/router:result $1`) and, if they accept it,
`/router:approve $1` before merging again.
