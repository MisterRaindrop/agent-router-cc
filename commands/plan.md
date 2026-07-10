---
description: Decompose a goal into router tasks (claude proposes, router validates)
argument-hint: <goal>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" plan "$ARGUMENTS" --json`

router validated claude's proposed task batch deterministically (or rejected it all).

If it succeeded:
- Summarize each created task (id, scope, risk, dependencies).
- HANDBACK tasks were NOT dispatched -- they need judgment. Handle them here in the
  main session: clarify with the user, split further, or do them directly.
- Drive the batch: `/router:run <id>` for every task `/router:ready` reports, review
  and merge PASSED results (`/router:result`, `/router:merge`), then check
  `/router:ready` again for the next wave, until the batch is done.
- When the whole batch is merged: ask the user how to build and test this project
  (do not assume), run those commands in the user's real checkout, and report the
  integration result. Offer to save the commands into `.router/policy.yaml`
  `verification` for future runs.

If it was rejected, show the reasons -- the proposal failed a deterministic check
(unknown build/test ref, too-broad scope, duplicate ids, a dependency cycle) and
nothing was created.
