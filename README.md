# router

Wrap an AI coding agent (the `codex` or `claude` CLI) in a deterministic pipeline.
The agent writes its diff in an isolated git worktree; nothing reaches your branch
until mechanical checks -- **build, tests, scope, secret scan** -- all pass. You review
and merge. The LLM only produces artifacts; the CLI owns every gate.

## With router vs. without

|                        | Prompting the agent directly            | With router                                             |
| ---------------------- | --------------------------------------- | ------------------------------------------------------- |
| **Change scope**       | bounded only by the prompt              | enforced on the diff: allowed globs + changed-line cap  |
| **Correctness**        | you check by hand afterward             | build + tests + scope + secret scan must pass to PASS   |
| **Where edits land**   | your working tree, immediately          | an isolated worktree; your tree changes only on `merge` |
| **A failed attempt**   | you retry manually                      | escalation ladder: retry -> stronger model -> hand back |
| **Quota / rate limit** | the run stalls                          | automatic fallover to the next executor                 |
| **A runaway run**      | burns until you notice                  | wall timeout + stall watchdog + budget caps             |
| **Secrets in a diff**  | can slip into a commit                  | scanned; a hit fails verification                       |
| **Cost visibility**    | none                                    | `router stats`: tokens, spend, and savings              |

router **never auto-merges**. The mechanical gate decides PASS/FAIL; you decide merge.

## Requirements

- **Node.js >= 18** (`node --version`)
- **git**
- One executor CLI, logged in: [codex](https://github.com/openai/codex) **or** `claude`.
  A plan subscription is fine -- **no API key needed**.

router itself has **no install step**: `dist/router.js` is a committed, dependency-
free bundle. Clone and run.

## Install

```sh
git clone https://github.com/MisterRaindrop/agent-router-cc
# optional convenience alias (add to your shell profile):
alias router='node "$(pwd)/agent-router-cc/dist/router.js"'
router --help
```

### As a Claude Code plugin

One-click install from inside Claude Code:

```
/plugin marketplace add MisterRaindrop/agent-router-cc
/plugin install router@agent-router-cc
```

Or, for local development (no marketplace, picks up your edits):

```sh
claude --plugin-dir /path/to/agent-router-cc
```

This adds the `/router:*` slash commands (`/router:delegate`, `/router:status`,
`/router:result`, `/router:stats`, ...), the `reviewer` / `summarizer` subagents, and
a hook that reconciles crashed runs on session start. Run `/reload-plugins` to
activate.

## Quickstart (about a minute)

```sh
cd your-repo
router init                                    # scaffolds .router/policy.yaml
# edit .router/policy.yaml: set your project's real build + test commands, and scope
git add .router/policy.yaml && git commit -m "router policy"

# let the agent draft + validate a task contract, then run it:
router plan "implement X in src/" --execute    # omit --execute to review the plan first
router status <id>                             # poll until PASSED or FAILED
router result <id>                             # see the per-check verifier report
router merge <id>                              # you merge the verified diff
```

Prefer to write the task yourself? Use `router new <id>` instead of `router plan`.
Full walkthrough (with what each gate guarantees): **[docs/quickstart.md](docs/quickstart.md)**.
A complete, dependency-free runnable task: **[examples/minimal/](examples/minimal/)**.

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

The full command list is in `router --help`; resilience and safety knobs (executor
fallback, escalation, budget caps, approval gate, `router gc`) are documented in
[docs/quickstart.md](docs/quickstart.md).

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
