# Quickstart

router routes coding subtasks to the cheapest capable model to save Opus tokens. You
plan with Opus; it dispatches the clear subtasks to a cheaper executor, verifies and
reviews them; you approve and merge. There is no `init`, no policy file, and no commit
step -- router auto-creates a gitignored `.router/` on first use.

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

1. **Confirm the plan** -- Opus shows each clear task (its scope + `verify` command) and
   which tasks are unclear (it will do those with you directly). You say go.
2. **Unclear tasks** -- Opus handles these interactively; they are not sent to a cheap
   model.
3. **Review + land** -- once every clear task passes both the mechanical gate and Opus's
   own review of the diff, Opus shows you the diffs and the tokens saved; you approve
   and it lands each.

## The primitives

`/router:go` drives these; you can also call them directly:

```
/router:dispatch <id>   # run one task on the quota-picked executor, to a verified diff
/router:result <id>     # the per-check verifier report + log tail
/router:land <id>       # merge a PASSED dispatch into your branch
```

Or from a shell (same thing): `router dispatch <id>`, `router land <id>`.

## The task contract

Opus writes one per subtask at `.router/tasks/<id>/task.yaml`:

```yaml
schema_version: 1
id: add-validators
title: Add signup validators
allowed_globs: ["src/validators/**"]   # the ONLY paths the executor may change
max_changed_lines: 200
verify: [["npm", "test"]]              # the mechanical gate; [] = diff/scope/secret only
# worker: { kind: claude, model: sonnet }   # optional: pin an executor
```

`router new <id>` scaffolds this skeleton if you want to author one by hand.

## What each gate guarantees

For a dispatched task, the diff must clear, in order:

| check | meaning |
|-------|---------|
| `diff_applies` | applies cleanly onto the base commit |
| `scope`        | only `allowed_globs` changed, under the line cap, no test deletion |
| `secret_scan`  | no leaked keys/secrets in the added lines |
| `verify`       | the task's `verify` command(s) exit 0 (skipped if `verify: []`) |

Then the main session (Opus) reviews the diff for correctness/laziness. Both must pass
before you land. `verify: []` means the mechanical gate only proves "applied, in scope,
no secrets" -- give a real command to make PASS mean "your tests pass".

## Real-quota routing

router routes each task to the executor with more remaining quota. codex usage is read
from `~/.codex/sessions`; for claude, run `/router:setup-statusline` once -- it wires
`statusline/router-usage.mjs` into your `~/.claude/settings.json` (snapshotting usage to
`.router/usage.json`) and chains any existing statusline via `ROUTER_INNER_STATUSLINE`,
so your current HUD keeps rendering. This is the same mechanism claude-hud uses; restart
Claude Code afterward. Without it, routing uses codex quota + a reactive 429 fallover --
still correct, just less balanced on the claude side.
