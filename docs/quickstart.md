# Quickstart

router routes coding subtasks to the cheapest capable model to save Opus tokens. You
plan with Opus; it dispatches the clear subtasks to a cheaper executor, gates each diff
(scope + secrets + exec bit), then reviews it and verifies the build/tests in your real environment;
you approve and merge. There is no `init`, no policy file, and no commit step -- router
auto-creates a gitignored `.router/` on first use.

## Prerequisites

- The `codex` CLI or the `claude` CLI, logged in (a plan subscription is fine; no API
  key). This is the executor router routes work to.
- `router` available as a Claude Code plugin (`/plugin install router@agent-router-cc`)
  or on your PATH as `node /path/to/agent-router-cc/dist/router.js`.

## The loop

Plan the change with Opus in normal conversation, then:

```
/router:go
```

Opus decomposes the plan you agreed on into tasks and drives them, pausing at three
points:

1. **Confirm the plan** -- Opus shows each clear task (its scope, and that it carries its
   own tests) and which tasks are unclear (it will do those with you directly). You say go.
2. **Unclear tasks** -- Opus handles these interactively; they are not sent to a cheap
   model.
3. **Review + land** -- Opus reviews each diff (and verifies anything risky in your real
   environment as it goes), then runs a mandatory full-chain CI in your real environment,
   **exactly as your CI invokes it and without fixing the environment to make it pass**.
   That is the *floor*: it shows you the diffs and the tokens saved, and hands the stage
   back to you. `/router:review` is the **next stage** -- a strict, independent review of
   the landed code -- so you can confirm the direction first instead of paying for a strict
   review of the wrong thing.

## The primitives

`/router:go` drives these; you can also call them directly:

```
/router:dispatch <id...> # run these tasks on quota-picked executors, concurrently, to
                         #   verified diffs (one call, so the wall clock is the slowest one)
/router:result <id>      # the per-check verifier report + log tail
/router:resume <id>      # send a failure back to that task's own executor session
/router:land <id...>     # merge PASSED dispatches into your branch
/router:gate <id...>     # verify in your own checkout, one at a time, when the real gate
                         #   needs Docker or a single build directory
```

Or from a shell (same thing): `router dispatch <id>`, `router land <id>`.

Claude executors run with worktree-scoped `Read`/`Edit`/`Write`, plus `Bash` limited to the
task's `verify` command when it declares one, so they can prove their own work. The CLI
applies environment-free gates to the diff (applies + scope + secrets + exec bit); the real
build/tests are either that `verify` command or a `/router:gate` run in your own checkout, and
the final full-chain verdict is always Opus's, in your actual environment.

## The task contract

Opus writes one per subtask at `.router/tasks/<id>/task.yaml`:

```yaml
schema_version: 1
id: add-validators
title: Add signup validators
plan_id: issue-4213                    # same on every task of one plan; groups its artifacts
allowed_globs: ["src/validators/**"]   # the ONLY paths the executor may change
max_changed_lines: 200                 # budget for the task's own tests too
tier: weak                             # how much capability: weak | strong | critical
risk: normal                           # how much review it earns: low | normal | high
verify: [["npm", "run", "check"]]      # the gate the executor must get to green itself
# depends_on: [migrate-schema]         # optional: must land before this one runs
# worker: { kind: claude, model: sonnet }   # optional: pin an executor
```

`router new <id>` scaffolds this skeleton if you want to author one by hand. Alongside it,
`TASK_CONTRACT.md` states the seven things that make a task dispatchable at all -- goal,
invariants, frozen interfaces, definition of done, blast radius, stop conditions, version
binding. **If those cannot be written down, it is a decision rather than a task**, and Opus
keeps it instead of handing it off.

`tier` and `risk` answer different questions: a mechanical change to an auth path is `weak`
**and** `high`. Set `verify` to a fast self-contained gate if one runs inside a worktree --
then the diff arrives already compiling and passing. If the real gate needs Docker or one
shared build directory, leave `verify: []` and use `/router:gate` instead.

## What each gate guarantees

A dispatched diff must clear the CLI's environment-free gates, in order:

| check | meaning |
|-------|---------|
| `diff_applies` | applies cleanly onto the base commit |
| `scope`        | only `allowed_globs` changed, under the line cap, no test deletion |
| `secret_scan`  | no leaked keys/secrets in the added lines |
| `exec_bit`     | a script added where its same-extension siblings are executable carries the executable bit (a test script created `100644` dies with "permission denied" in CI before running one assertion) |
| `verify`       | optional: any `verify` command(s) exit 0 (skipped when `verify: []`) |

These are the deterministic guarantees a cheap model can't fake. Each run also ends with a
**delivery report** (`.router/tasks/<id>/runs/<run>/DELIVERY.md`) whose header states whether
the gate actually ran -- read it before the diff; `gate_ran: false` means unproven, whatever
the prose says.

**The final verdict is Opus's**, in your actual environment (Docker and all): risk-driven per
task, and always as a mandatory full-chain gate before "done", because a per-task `verify`
proved each task in isolation and not the combination. Opus reviews every diff for
correctness/laziness and reads the full test output itself -- a cheap model never decides its
own pass/fail. **[docs/workflow.md](workflow.md)** has the whole protocol.

## Real-quota routing

router routes each task to the executor with more remaining quota. codex usage is read
from `~/.codex/sessions`; for claude, run `/router:setup-statusline` once -- it wires
`statusline/router-usage.mjs` into your `~/.claude/settings.json` (snapshotting usage to
`.router/usage.json`) and chains any existing statusline via `ROUTER_INNER_STATUSLINE`,
so your current HUD keeps rendering. This is the same mechanism claude-hud uses; restart
Claude Code afterward. Without it, routing uses codex quota + a reactive 429 fallover --
still correct, just less balanced on the claude side.
