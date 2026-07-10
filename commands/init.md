---
description: Initialize router in this repo -- scaffold .router/ (zero-config)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" init`

Confirm `.router/` was created, then commit it (router reads policy from the
committed base_sha, not the working tree). Nothing else is required: the default
policy works as-is. Do not ask the user to configure anything now -- the build/test
conversation happens later, at integration time, after a batch is merged.
