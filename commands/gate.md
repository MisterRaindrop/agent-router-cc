---
description: Verify dispatched commits in the project's real environment, one at a time (serial queue)
argument-hint: <task-id> [<task-id> ...] | --status
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" gate $ARGUMENTS --json`

For a project whose real gate needs Docker, a single build directory, or live services, that
environment exists **once** -- so verification is a serial queue, and it runs in the project's
own checkout rather than a run worktree. A worktree is a different source path with no build
directory and no warm cache, and Docker is mounted on a fixed host path, so a gate run there
would prove nothing.

Each task is verified **on top of the current integration head**, not on its own older base:
once one task merges, every later task's base is stale, and "verified" would be a claim about
code nobody will ship. A pass leaves the commit on the integration branch; a failure rolls the
tracked files back and **keeps every build artifact**, so the next run is still incremental.
Either way the user's original branch is checked out again and the lock released.

Report per task: verified or not, the reason when not, and **the path to the evidence** --
never the build output itself. Read a log only when you need to act on a specific failure.

Handle each outcome as what it is:
- `gate_failed` -> a real defect. Send a **precise error summary** (not a log dump) back to
  that task's executor with `/router:resume`, which keeps its session context.
- `apply_conflict` -> the task was written against a base that has since moved; it goes back to
  its executor to redo on the new head.
- `checkout_dirty` -> the user has uncommitted work. Say so and stop. **Never** stash, discard,
  or "tidy up" their tree.
- `lock_unavailable` -> another verification holds the environment; the output names the
  holder. Wait, or ask the user whether that holder is stale.
- `reset_failed` -> the environment could not be returned to a clean baseline, so the gate did
  not run. The gate log is empty on purpose; `reset_log` has the reason.
- `contract_conflict` / `verifier_not_passed` -> nothing to verify yet; go back to the dispatch.

`--status` shows the gate mode and whether anything currently holds the checkout. On a project
that verifies inside the worktree (`mode: worktree`), this command refuses and tells you so:
there each task's own `verify` is the gate, and nothing needs a queue.

## When there is no `.router/gate.yaml` yet

**Work out how this project builds and tests -- do not ask the user to write YAML from
scratch.** Read `package.json` scripts, `Makefile` / `justfile` targets, the CI workflow (the
most reliable source: it is what the project actually runs), `Dockerfile` / `compose.yaml`,
and the build section of `README`/`CONTRIBUTING`. Note whether a build directory, a compile
database, or a virtualenv already exists, and where.

Then settle the mode **empirically, once**: run the candidate gate inside a run worktree. If it
passes there, this project is `mode: worktree` and each task's own `verify` is the gate --
there is nothing to queue. If it cannot run there (no build directory, a compile database
keyed to another path, Docker bound to a fixed host path, one shared database), it is
`mode: queue`.

**Propose the config, then let the user confirm it before it is written.** Show the whole file
and say where each command came from ("this is what the CI workflow runs"). The point is that
the user does not hand-author YAML -- not that router silently decides: a wrong gate command
does not fail, it **passes something that was never the real gate**, and reports the change as
verified. That failure is invisible, which is why a human agrees to it once.

**Never infer `reset`.** It is the command that wipes business state between runs, and a guess
like `docker compose down -v` destroys volumes. Leave it empty unless the user states it.
Likewise propose `clean_gate` only from a command the project already documents.

Once written, the file is explicit and stable: this discovery happens once per project, not
per dispatch.
