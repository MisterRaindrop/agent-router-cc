---
description: Initialize router in this repo -- scaffold .router/ and a policy.yaml template
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" init`

Confirm `.router/` was created. The default `policy.yaml` works out of the box
(placeholder build/test that always pass), so the only required step is to commit
`.router/` -- router reads the policy from the committed base_sha, not the working
tree. Tell the user: for a real correctness gate, replace the `verification`
commands in `.router/policy.yaml` with their project's actual build + test; the file
has commented examples for pricing, budgets, and escalation when they want to tune.
