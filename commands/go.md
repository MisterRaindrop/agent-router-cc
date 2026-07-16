---
description: Execute the plan we just discussed -- dispatch clear subtasks to cheaper models, verify, review, merge
allowed-tools: Bash(node:*), Read, Edit, Write
---
The user has finished planning WITH YOU in this conversation and now wants router to
execute. Do NOT re-plan from scratch or shell a separate planner -- YOU decompose the
plan you both just agreed on, using the full context you already have.

1. **Decompose** the agreed plan into the smallest well-defined subtasks. For each,
   decide **clear** (an average cheaper model could finish it from the contract alone)
   vs **unclear** (needs judgment/design). Author each CLEAR task:

   !`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" new <id> --title "<title>"`

   then edit `.router/tasks/<id>/task.yaml`: set `allowed_globs` (smallest scope) and
   `verify` (the real command that proves it, e.g. `[["npm","test"]]`, or `[]` if none).
   For a genuinely simple task, pin the cheapest capable model with
   `worker: { kind: claude, model: haiku }` (or `sonnet`); leave `worker` unset to let
   router quota-balance codex vs claude.

   **Touchpoint 1:** show the user the task list (each clear task with its scope and
   target model, each unclear task) and wait for their go-ahead.

2. **Run** the clear tasks in the order their dependencies require (you sequence them;
   there is no `depends_on` gate -- land a prerequisite before dispatching its dependent):
   `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" dispatch <id> --json`
   router picks the cheaper executor with more real remaining quota, runs it in an
   isolated worktree, and mechanically verifies (the task's `verify` cmd + scope +
   secret scan). **Then YOU read the diff and review it yourself** -- a cheap model can
   pass the tests while being lazy or wrong (hardcoding, skipped cases, misread intent).
   If unsatisfied, re-dispatch once with a sharper contract; if still bad, take it over
   yourself. This double check (mechanical + your review) is the point.

3. **Touchpoint 2:** handle the unclear tasks directly with the user (clarify, then
   implement yourself). Do NOT dispatch them to a cheap model.

4. **Touchpoint 3:** once every clear task passes BOTH mechanical verify AND your
   review, show the user the combined diffs and roughly the tokens saved, and land on
   their approval only: `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" land <id>` each.

You planned, decomposed, reviewed, and merged; the cheap models did the execution --
that is the token saving. Never land what the user has not approved.
