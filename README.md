# router

**English** | [中文](README.zh-CN.md)

A Claude Code plugin that routes coding subtasks to the cheapest capable model to save
Opus tokens. You plan with the main session (Opus); it decomposes the plan, dispatches
the clear subtasks to a cheaper executor (the `codex` or `claude` CLI) running in an
isolated git worktree, gates each diff (scope + secrets + exec bit), then reviews it and verifies
the build/tests in your real environment; you approve and merge. The cheap models do the
execution; Opus plans, reviews, verifies, and merges.

> **Status: beta (0.x).** Commands may still change before 1.0.

## With router vs. without

|                        | Prompting the agent directly       | With router                                                    |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------- |
| **Who executes**       | Opus (expensive)                   | the cheaper executor with more quota (codex / sonnet)          |
| **Change scope**       | bounded only by the prompt         | enforced on the diff: allowed globs + changed-line cap         |
| **Correctness**        | you check by hand                  | CLI gates the diff (scope + secret scan + exec bit); Opus runs the build/tests in your real env |
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

## Update

router ships as a committed, dependency-free bundle, so updating just means pulling the
latest version from the marketplace. First refresh the catalog from the git repo (in
Claude Code):

```
/plugin marketplace update agent-router-cc
```

Then update the installed plugin — open the `/plugin` menu and update **router** from the
**Installed** tab, or run this in your terminal:

```
claude plugin update router@agent-router-cc
```

Finally reload so the new version is active in the current session:

```
/reload-plugins
```

## Use it

Just talk to Opus, plan the change together, then:

```
/router:go
```

`/router:go` is the **top-level command** — the one you normally type. It executes the
plan you both just agreed on and drives all the lower-level commands for you. It pauses
at exactly **three points**:

1. **Confirm the task breakdown.** Opus splits the plan into the smallest well-defined
   subtasks and shows you each one (its file scope and target model) before anything runs.
2. **Handle the unclear tasks.** Anything needing real judgment or design, Opus does
   with you directly instead of handing it to a cheap model.
3. **Approve before merge.** Nothing lands in your branch without your say-so.

For each *clear* task in between, the work is split between two actors:

- **The router CLI** runs the task on the quota-picked executor inside an isolated
  worktree — several independent tasks at once, each in its own worktree — and applies
  **fast, environment-free gates** to the resulting diff: it applies cleanly, stays within
  its allowed file scope, leaks no secrets, and a script added where its siblings are
  executable carries the executable bit. It runs a build or tests only if that task's
  contract sets a `verify` command, and even then the answer is mechanical: *did it run and
  pass*, never *is it right*.
- **Opus** then **reads and reviews the diff** for laziness or wrong work — hardcoded
  values, skipped or hollow tests, misread intent (a cheap model can clear a shallow gate
  while still being wrong). And **Opus owns verification**: for anything risky it runs the
  real build/tests itself in *your* environment (it has Docker and the full toolchain; the
  sandboxed executor doesn't), reading the complete output and judging pass/fail. If the
  review is clean and low-risk, that worktree merges back and Opus moves to the next task;
  if not, it re-dispatches with a sharper contract or takes it over.

At the end Opus does a **mandatory acceptance pass** — it works out how to build and test
the project, makes sure every change is covered by tests, and runs the full-chain CI in
your real environment (reading the whole output itself) before reporting done — and lands
only on your approval. The cheap models do the execution; Opus plans, reviews, verifies,
and merges — that is the token saving.

### The lower-level commands

`/router:go` drives these for you, but you can also run them directly. Each takes a
**task id** — the short name Opus assigns a subtask; its contract lives at
`.router/tasks/<id>/task.yaml`.

```
/router:dispatch <id...> # run each task on the quota-picked executor, producing a
                         #   mechanically-verified diff on its own worktree branch.
                         #   Several ids run concurrently (--max-parallel <n> caps it),
                         #   so the wall clock is the slowest task, not the sum
/router:land <id...>     # merge those tasks' verified diffs into your working branch
/router:gate <id...>     # for a project whose real gate needs Docker or one build directory:
                         #   verify each commit in your own checkout, one at a time, on the
                         #   integration head -- keeping the build cache warm (--status shows
                         #   whether anything currently holds it)
/router:result <id>      # show task <id>'s per-check verifier report and log tail
```

A task's contract (`.router/tasks/<id>/task.yaml`) carries `allowed_globs` (its file
scope), an optional `verify` command like `[["npm","test"]]`, and an optional `worker`
to pin an executor. Opus authors these from your conversation; there is no global policy
file.

See **[docs/quickstart.md](docs/quickstart.md)** and a runnable task in
**[examples/minimal/](examples/minimal/)**.

## How it works

- **Task-scoped, no policy.** Each task carries its own scope and `verify` command;
  there is no global `policy.yaml` and nothing is read from git. Executors default to
  codex + claude.
- **Isolated execution.** The executor runs in a fresh `git worktree` under `.router/`,
  supervised with a wall timeout and a stall watchdog; its output never enters the
  orchestrator's context, and no MCP server from your own session is inherited. Codex uses
  its `workspace-write` sandbox. Claude receives `Read`/`Edit`/`Write` in normal
  `acceptEdits` mode (never `bypassPermissions`), plus `Bash` **only** when the task
  declares a `verify` command, so it can prove its own work. Two real runs measured what that
  means: `acceptEdits` auto-approves **read-only** Bash on its own, so reading is open, while
  anything that *does* something must match the grant — which is the exact gate command plus
  its program+subcommand prefix, so the executor can iterate without being handed a shell.
  Reading is bounded by the worktree and the stripped environment; codex's sandbox is still
  the tighter of the two, and a task with no `verify` gets no Bash at all. Your working tree is untouched until you `land`.
- **Credential separation.** Executor CLIs receive only the login-session/network
  context needed for plan authentication plus an explicitly configured provider key —
  never the full parent environment (which might hold unrelated `AWS_*`, proxy, or API
  credentials).
- **Verification you own.** The CLI applies fast, *environment-free* gates to every diff
  (applies cleanly, within `allowed_globs`, no secrets, executable bit on new scripts) — the deterministic guarantees a
  cheap model can't fake. The real build/tests are run by the main session (Opus) in
  *your* actual environment (Docker and all): risk-driven per task, and always as a
  mandatory full-chain gate before "done". Opus reads the complete output and judges it —
  a cheap model never decides its own pass/fail, and logs are never compressed away.
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
