---
description: Initialize router in this repo -- scaffold .router/ (zero-config)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" init`

Confirm `.router/` was created. Nothing else is required: router is policy-free and
each task carries its own scope and optional `verify` command. `.router/` is runtime
state and is fully gitignored, so do NOT stage or commit it. Do not ask the user to
configure anything.
