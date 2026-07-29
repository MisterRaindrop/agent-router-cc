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
/router:dispatch <id>   # run one task on the quota-picked executor, to a verified diff
/router:result <id>     # the per-check verifier report + log tail
/router:land <id>       # merge a PASSED dispatch into your branch
```

Or from a shell (same thing): `router dispatch <id>`, `router land <id>`.

Claude executors run with worktree-scoped `Read`/`Edit`/`Write` tools only. The CLI
applies environment-free gates to the diff (applies + scope + secrets + exec bit); the real
build/tests are run by Opus in your actual environment, not by the CLI.

## The task contract

Opus writes one per subtask at `.router/tasks/<id>/task.yaml`:

```yaml
schema_version: 1
id: add-validators
title: Add signup validators
allowed_globs: ["src/validators/**"]   # the ONLY paths the executor may change
max_changed_lines: 200
verify: []                             # usually empty -- Opus runs the real build/tests
# verify: [["npm", "test"]]            # optional: also run this in the CLI's minimal env
# worker: { kind: claude, model: sonnet }   # optional: pin an executor
```

`router new <id>` scaffolds this skeleton if you want to author one by hand. Under the
Opus-driven flow you leave `verify: []`; the real build/tests happen in your environment.

## What each gate guarantees

A dispatched diff must clear the CLI's environment-free gates, in order:

| check | meaning |
|-------|---------|
| `diff_applies` | applies cleanly onto the base commit |
| `scope`        | only `allowed_globs` changed, under the line cap, no test deletion |
| `secret_scan`  | no leaked keys/secrets in the added lines |
| `exec_bit`     | a script added where its same-extension siblings are executable carries the executable bit (a test script created `100644` dies with "permission denied" in CI before running one assertion) |
| `verify`       | optional: any `verify` command(s) exit 0 (skipped when `verify: []`) |

These are the deterministic guarantees a cheap model can't fake. **The real build/tests
are Opus's job**, run in your actual environment (Docker and all): risk-driven per task,
and always as a mandatory full-chain gate before "done". Opus also reviews every diff for
correctness/laziness and reads the full test output itself -- a cheap model never decides
its own pass/fail. Leave `verify: []` unless you want the CLI to also run a quick
environment-free check.

## Real-quota routing

router routes each task to the executor with more remaining quota. codex usage is read
from `~/.codex/sessions`; for claude, run `/router:setup-statusline` once -- it wires
`statusline/router-usage.mjs` into your `~/.claude/settings.json` (snapshotting usage to
`.router/usage.json`) and chains any existing statusline via `ROUTER_INNER_STATUSLINE`,
so your current HUD keeps rendering. This is the same mechanism claude-hud uses; restart
Claude Code afterward. Without it, routing uses codex quota + a reactive 429 fallover --
still correct, just less balanced on the claude side.
