---
description: Approve a high-risk router task for merge (records an approval)
argument-hint: <task-id>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" approve $1`

Confirm the approval was recorded and report the risk reasons it lists. The task can
now be merged with `/router:merge $1`. Only do this when the user has actually
reviewed the diff -- this is the human gate for high-risk changes.
