# router

A Claude Code plugin that routes coding subtasks to the cheapest capable model to save
Opus tokens. You plan with the main session (Opus); it decomposes the plan, dispatches
the clear subtasks to a cheaper executor (the `codex` or `claude` CLI) running in an
isolated git worktree, mechanically verifies each diff, and reviews it; you approve and
merge. The cheap models do the execution; Opus only plans, reviews, and merges.

> **Status: beta (0.x).** Commands may still change before 1.0.

## With router vs. without

|                        | Prompting the agent directly       | With router                                                    |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------- |
| **Who executes**       | Opus (expensive)                   | the cheaper executor with more quota (codex / sonnet)          |
| **Change scope**       | bounded only by the prompt         | enforced on the diff: allowed globs + changed-line cap         |
| **Correctness**        | you check by hand                  | mechanical verify (your `verify` cmd + scope + secret scan)... |
| **...and laziness**    | trust the model's word             | ...**plus** the main session reviews the diff for lazy/wrong work |
| **Where edits land**   | your working tree, immediately     | an isolated worktree; your tree changes only on `land`         |
| **Quota / rate limit** | the run stalls                     | balances codex vs claude by real remaining quota; 429 fallover |

router **never auto-merges**. The gates decide PASS/FAIL; you decide land.

## Requirements

- **Claude Code**
- **Node.js >= 18** and **git**
- One executor CLI, logged in: [codex](https://github.com/openai/codex) **or** `claude`.
  A plan subscription is fine -- **no API key needed**.

No install step, no config: `dist/router.js` is a committed, dependency-free bundle, and
router auto-creates a gitignored `.router/` on first use. **No `init`, no policy file,
no commit.**

## Install

From inside Claude Code:

```
/plugin marketplace add MisterRaindrop/agent-router-cc
/plugin install router@agent-router-cc
/reload-plugins
```

## Use it

Just talk to Opus, plan the change together, then:

```
/router:go
```

`/router:go` executes the plan you both just agreed on, pausing at exactly **three
points**: (1) confirm the decomposition into tasks, (2) handle any unclear tasks with
you directly, (3) review all the verified diffs before merge. In between, for each clear
task it: picks the cheaper executor with more remaining quota, runs it in an isolated
worktree, mechanically verifies the diff, **and reviews it itself** (a cheap model can
pass the tests while being lazy or wrong). You only decide and merge.

Primitives (what `/router:go` drives, also usable directly):

```
/router:dispatch <id>   # run one task on the quota-picked executor to a verified diff
/router:land <id>       # merge a PASSED dispatch's diff into your branch
/router:result <id>     # the per-check verifier report
```

A task's contract lives in `.router/tasks/<id>/task.yaml` (`allowed_globs`, an optional
`verify` command like `[["npm","test"]]`, and an optional `worker` to pin an executor).
Opus authors these from your conversation; there is no global policy file.

See **[docs/quickstart.md](docs/quickstart.md)** and a runnable task in
**[examples/minimal/](examples/minimal/)**.

## How it works

- **Task-scoped, no policy.** Each task carries its own scope and `verify` command;
  there is no global `policy.yaml` and nothing is read from git. Executors default to
  codex + claude.
- **Isolated execution.** The executor runs in a fresh `git worktree` under `.router/`,
  supervised with a wall timeout and a stall watchdog; its output never enters the
  orchestrator's context. Your working tree is untouched until you `land`.
- **Double verification.** Mechanical (deterministic): the diff must apply, stay within
  `allowed_globs`, leak no secrets, and pass the task's `verify` command. Semantic: the
  main session (Opus) then reviews the diff to catch a cheap model being lazy or wrong.
- **Real-quota balancing.** codex usage is read from `~/.codex/sessions`, claude usage
  from a statusline snapshot (`statusline/router-usage.mjs`, optional); the executor
  with more headroom goes first, and a real 429 switches to the other.

## Development

```sh
npm ci
npm run check     # tsc --noEmit + core-purity guard + node --test
npm run build     # bundle src/ -> dist/router.js (commit the result)
```

`src/` is layered `domain -> core -> io -> app -> cli`. `core/` is pure (no fs,
child_process, process, clock, or randomness -- enforced by `npm run check:deps`), which
keeps the gate logic deterministic and unit-testable.

## License

Apache-2.0.
