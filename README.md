# router

A Claude Code plugin that wraps an AI coding agent (the `codex` or `claude` CLI) in a
deterministic pipeline. The agent writes its diff in an isolated git worktree; nothing
reaches your branch until mechanical checks -- **build, tests, scope, secret scan** --
all pass. You review and merge. The LLM only produces artifacts; the plugin owns every
gate.

> **Status: beta (0.x).** Usable today; the policy schema and commands may still change
> before 1.0.

## With router vs. without

|                        | Prompting the agent directly            | With router                                             |
| ---------------------- | --------------------------------------- | ------------------------------------------------------- |
| **Change scope**       | bounded only by the prompt              | enforced on the diff: allowed globs + changed-line cap  |
| **Correctness**        | you check by hand afterward             | build + tests + scope + secret scan must pass to PASS   |
| **Where edits land**   | your working tree, immediately          | an isolated worktree; your tree changes only on merge   |
| **A failed attempt**   | you retry manually                      | escalation ladder: retry -> stronger model -> hand back |
| **Quota / rate limit** | the run stalls                          | automatic fallover to the next executor                 |
| **A runaway run**      | burns until you notice                  | wall timeout + stall watchdog + budget caps             |
| **Secrets in a diff**  | can slip into a commit                  | scanned; a hit fails verification                       |
| **Cost visibility**    | none                                    | `/router:stats`: tokens, spend, and savings             |

router **never auto-merges**. The mechanical gate decides PASS/FAIL; you decide merge.

## Requirements

- **Claude Code**
- **Node.js >= 18** and **git**
- One executor CLI, logged in: [codex](https://github.com/openai/codex) **or** `claude`.
  A plan subscription is fine -- **no API key needed**.

The plugin ships a committed, dependency-free bundle -- **no `npm install`**.

## Install

From inside Claude Code:

```
/plugin marketplace add MisterRaindrop/agent-router-cc
/plugin install router@agent-router-cc
/reload-plugins
```

You now have the `/router:*` slash commands, the `reviewer` / `summarizer` subagents,
and a hook that reconciles crashed runs on session start.

## Quickstart

In the repo you want to work in:

```
/router:init                         # scaffolds .router/ with a ready-to-use policy
```

Commit `.router/` (router reads the policy from git, not the working tree). It works
out of the box; to make a PASS also mean "your build and tests pass", set your real
commands under `verification` (see below). Then let the agent do a task:

```
/router:plan implement X in src/     # claude drafts a contract; router validates it -> DRAFT
/router:run <id>                     # validate + queue + run in a supervised worker
/router:status <id>                  # poll until PASSED or FAILED
/router:result <id>                  # the per-check verifier report
/router:merge <id>                   # you merge the verified diff (high-risk: /router:approve first)
```

Prefer to write the contract yourself instead of having claude draft it? Use
`/router:delegate <id> <description>`. Full walkthrough and the resilience/safety
knobs are in **[docs/quickstart.md](docs/quickstart.md)**; a complete runnable task is
in **[examples/minimal/](examples/minimal/)**.

## `.router/policy.yaml`

The per-repo rulebook, committed to git and read from the frozen `base_sha` (so a
worker cannot loosen its own rules). Three parts:

```yaml
schema_version: 1
worker: { kind: codex }              # or workers: [{kind: codex}, {kind: claude}] for fallback
scope:
  forbidden_globs: [".router/**", "**/*.lock"]
  test_globs: ["test/**"]            # tests can't be deleted/emptied to fake a pass
  max_changed_lines: 400
verification:                        # the commands the gate runs (argv arrays, no shell)
  build: [["npm", "run", "build"]]   # init ships a placeholder that always passes;
  test:  [["npm", "test"]]           # replace with your real commands for a true gate
```

A task references these by `build_ref` / `test_ref`. Optional blocks add resilience and
safety, and cost visibility: `escalation`, `budget_caps`, `secret_scan`, `routing`, and
`pricing` (per-model USD, so `/router:stats` reports spend and savings). The `router
init` template includes commented examples of each. See docs/quickstart.md.

## How the gates work

- **State is event-sourced.** Every transition goes through one lock-guarded
  primitive; `events.jsonl` is the source of truth and `state.json` / `registry.json`
  are rebuildable projections. A tampered log is rejected on fold.
- **Scope is enforced on the diff, not the prompt.** `git diff` against the frozen
  `base_sha` is checked against allowed/forbidden globs, a test-deletion guard, and a
  changed-line cap.
- **Commands are whitelisted.** Verification commands must match argv templates in
  `policy.yaml`, read from the `base_sha` git object (not the worktree), so a worker
  cannot loosen its own rules. Everything runs `shell:false`.
- **Workers are supervised.** Each run is a detached process group with a wall
  timeout, stall watchdog, and SIGTERM->SIGKILL escalation; its output goes to a log,
  never the orchestrator's context.

## Development

```sh
npm ci
npm run check     # tsc --noEmit + core-purity guard + node --test
npm run build     # bundle src/ -> dist/router.js (commit the result)
```

`src/` is layered `domain -> core -> io -> app -> cli`. `core/` is pure (no fs,
child_process, process, clock, or randomness -- enforced by `npm run check:deps`),
which is what makes the gate logic unit-testable and keeps the LLM out of state
transitions. Tests run on `node:test` against synthetic git-repo fixtures.

## License

Apache-2.0.
