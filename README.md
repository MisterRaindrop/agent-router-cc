# router

A Claude Code plugin and deterministic CLI for orchestrating coding tasks. The
LLM produces artifacts - a task contract, a plan, a patch, a summary - and the
`router` CLI owns every gate: the task state machine, locks, git-worktree
isolation, worker process supervision, diff-side scope enforcement, a mechanical
verifier, and metrics. An executor model (codex) does the work in a sandboxed
worktree; nothing merges until the deterministic checks pass.

## Requirements

- Node.js >= 18. **No install step** - `dist/router.js` is a committed, dependency-
  inlined bundle. Clone and run.
- `git` on PATH. For real execution, the [codex CLI](https://github.com/openai/codex)
  logged in (or an API key).

## Quickstart

```sh
# in your target git repo
node /path/to/router/dist/router.js init          # scaffold .router/ (+ policy.yaml)
# edit .router/policy.yaml: whitelist your real build/test commands, set scope
git add .router/policy.yaml && git commit -m "router policy"

node .../router.js new fix-thing --title "Fix thing"
# edit .router/tasks/fix-thing/{task.yaml,TASK_CONTRACT.md}: scope + goal
# ...or let claude draft + router validate the contract for you:
#   node .../router.js plan "fix thing in src/"   (add --execute to chain the run)
node .../router.js validate fix-thing              # freeze base_sha + contract hash
node .../router.js queue fix-thing
node .../router.js run fix-thing                   # launches a detached worker
node .../router.js status fix-thing                # poll until PASSED / FAILED
node .../router.js result fix-thing                # verifier checks + log tail
node .../router.js merge fix-thing                 # approval gate: merge the run branch
```

`router stats` reports cost per verified task; `router recover` reconciles
crashed runs; `router selftest` runs three canaries (including a scope trap that
must be caught) as a fast integrity check.

For a step-by-step walkthrough (with what each gate guarantees) see
[docs/quickstart.md](docs/quickstart.md), and a complete runnable task in
[examples/minimal/](examples/minimal/).

## As a Claude Code plugin

Install the plugin to get `/router:*` slash commands (`/router:delegate`,
`/router:status`, `/router:result`, `/router:stats`, `/router:selftest`, ...), the
`reviewer`/`summarizer` subagents, and hooks that run `router recover` on session
start and block direct edits to router-managed state under `.router/`.

## How the gates work

- **State is event-sourced.** Every transition goes through one lock-guarded
  primitive; `events.jsonl` is the source of truth and `state.json` / `registry.json`
  are rebuildable projections. A tampered log is rejected on fold.
- **Scope is enforced on the diff, not the prompt.** `git diff` against the frozen
  `base_sha` is checked against allowed/forbidden globs, a test-deletion guard, and
  a line cap.
- **Commands are whitelisted.** Verification commands must match argv templates in
  `policy.yaml`, which is read from the `base_sha` git object (not the worktree),
  so a worker can't loosen the rules. Everything runs `shell:false`.
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
child_process, process, clock, or randomness - enforced by `npm run check:deps`),
which is what makes the gate logic unit-testable and keeps the LLM out of state
transitions. Tests run on `node:test` against synthetic git-repo fixtures.
