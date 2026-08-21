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

(For a **large feature** — cross-module work, real approach trade-offs — you can opt into the
design flow first: `/router:brainstorm` questions the idea itself when the goal is not settled
yet — comparing it with how other products solve the same problem, arguing the case against
building it, and proposing the option you did not offer; `/router:design` clarifies and
researches, producing a `DESIGN.md` you approve section by section; `/router:design-review`
optionally gets an independent adversarial second opinion where you adjudicate every objection;
`/router:workplan` turns the approved Design into a `WORKPLAN.md` with the task breakdown, which
`/router:go` then executes verbatim. Whether a change deserves that is your call — router never
judges task size.)

(**One run, one package, one executor** — Opus by default, explicitly overridable — while your
session stays free: dispatch runs detached in the background, the statusline shows live
phase/activity/stall-countdown, and the session is woken only at terminal states. The executor
works in *your* checkout on a `router/<task>` branch, so it can build; the plan, review and merge
verdict stay with the main session.)

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
/router:result <id>      # the per-check verifier report + log tail
/router:resume <id>      # send a failure back to that task's own executor session
/router:list             # tasks, their last status, and whether the task branch is still there
```

`dispatch`, `land` and `gate` are CLI subcommands rather than slash commands — `/router:go`
drives them. From a shell: `router dispatch <id>`, `router land <id>`, `router gate <id>`.

Claude executors get `Read`/`Edit`/`Write` plus a **`Bash` allowlist, not a shell**: the task's
own `verify` command and a narrow set of git subcommands (`add`, `commit`, `status`, `diff`,
`log`, `rev-parse`) so the executor can commit its own work one functional unit at a time.
`checkout`, `reset`, `rebase`, branch deletion and `push` are unreachable, and a nested `router`
invocation refuses outright so orchestration state cannot be touched. The CLI applies
environment-free gates to the diff (applies + scope + secrets + exec bit) and runs the project's
own build gate; the final full-chain verdict is always Opus's, in your actual environment.

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
**and** `high`. Set `verify` to the project's fast gate and the diff arrives already compiling
and passing -- the executor works in your checkout, so it has the environment to run it. For a
project whose build is expensive or configuration-heavy, put the commands in `.router/gate.yaml`
instead (`gate`, `clean_gate`, `clean_triggers`, `reset`) and the dispatch flow runs them,
escalating to the full rebuild when a trigger -- or any deletion -- appears in the diff.

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
**delivery report** (`.router/tasks/<id>/DELIVERY.md`) whose header states whether
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
