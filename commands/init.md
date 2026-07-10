---
description: Initialize router in this repo -- scaffold .router/ and a policy.yaml template
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" init`

Confirm `.router/` was created. Then tell the user to edit `.router/policy.yaml` --
set the real build + test commands under `verification`, and the `scope` limits
(`forbidden_globs`, `test_globs`, `max_changed_lines`) -- and commit it, since router
reads the policy from the committed base_sha, not the working tree.
