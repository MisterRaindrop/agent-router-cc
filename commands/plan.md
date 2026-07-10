---
description: Draft and validate a task contract from a goal (claude proposes, router validates)
argument-hint: <goal>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" plan "$ARGUMENTS" --json`

claude proposed a task contract and router validated it deterministically (or
rejected it). If it succeeded, summarize the proposed task id, its `allowed_globs`
scope, and risk level, then tell the user to review `.router/tasks/<id>/` and run
`/router:run <id>` to execute it. If it was rejected, show the reasons -- claude's
proposal failed a deterministic check (unknown build/test ref, too-broad scope, a
glob matching no file, etc.) and no task was created.
