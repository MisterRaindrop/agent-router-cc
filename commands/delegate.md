---
description: Delegate a coding task to a router worker (create → validate → queue → run)
argument-hint: <task-id> <short description>
allowed-tools: Bash(node:*), Read, Edit, Write
---

You are delegating a coding task to the deterministic `router` orchestrator. The
router CLI owns every gate; you only produce the contract and pick options.

Steps:

1. Scaffold the task (creates `.router/tasks/$1/`):

   !`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" new $1 --title "$ARGUMENTS"`

2. Edit `.router/tasks/$1/task.yaml` and `TASK_CONTRACT.md`:
   - `allowed_globs` / `forbidden_globs` — the smallest scope that can satisfy the goal.
   - `build_ref` / `test_ref` — must name templates that exist in `.router/policy.yaml`.
   - `max_changed_lines`, `max_wall_minutes`.
   - Write a crisp Goal and Definition of Done in `TASK_CONTRACT.md`.

3. Freeze and enqueue:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" validate $1
   node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" queue $1
   node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" run $1
   ```

4. Poll `/router:status $1` until PASSED or FAILED. On PASSED, review the diff and
   (for high-risk tasks) merge with `router merge $1`.

Never edit files under `.router/` other than `task.yaml`, `TASK_CONTRACT.md`,
`PLAN.md`, and `policy.yaml` — everything else is router-managed state.
