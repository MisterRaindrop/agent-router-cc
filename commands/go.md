---
description: Route a goal -- decompose, run clear subtasks on cheaper models, review, merge
argument-hint: <goal>
allowed-tools: Bash(node:*), Read
---
Drive the full routing loop for the user's goal, pausing at EXACTLY three points and
doing everything else automatically. The cheap models do the work; you only plan,
review, and merge -- that is how this saves the user's Opus tokens.

1. **Decompose:**
   !`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" plan "$ARGUMENTS" --json`

   **Touchpoint 1 -- confirm the plan.** Show the user each clear task (id, scope) and
   which unclear tasks you will handle yourself. Wait for their go-ahead.

2. **Run clear tasks** in dependency order. For each task whose dependencies are already
   landed:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" dispatch <id> --json`
   This picks the executor with more real remaining quota (codex vs sonnet), runs it
   synchronously, and mechanically verifies the diff. Report progress as you go (which
   model, pass/fail). Re-dispatch a FAILED task at most once; if it still fails, stop
   and tell the user.

3. **Touchpoint 2 -- handle the unclear (handback) tasks yourself**, interactively:
   clarify with the user, then either implement directly or re-plan that piece as its
   own goal. Do not dispatch them to a cheap model.

4. **Touchpoint 3 -- review + merge.** When all clear tasks are PASSED, show the user the
   combined diffs (`router result <id>` per task) and the token savings, and ask whether
   to merge. On approval only: `router land <id>` each. Never land a task the user has
   not reviewed.
