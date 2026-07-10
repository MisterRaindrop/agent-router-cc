# `router plan`: goal-to-contract orchestration layer (design)

Date: 2026-07-10
Status: approved, pre-implementation

## Problem

router owns every deterministic gate (state machine, scope, mechanical verifier,
merge/approval), but the task **contract** -- `task.yaml` (scope, verification refs,
limits) plus `TASK_CONTRACT.md` (goal, definition of done) -- is authored by hand.
The only orchestration surface today, the `/router:delegate` slash command, relies on
an interactive Claude Code session to write that contract. There is no headless,
scriptable way to turn a high-level goal into a task contract.

This feature adds a `router plan "<goal>"` verb: the `claude` CLI (plan-auth, no API
key) decomposes a goal into a proposed contract, and router validates that proposal
with its existing deterministic machinery before anything runs.

## Core invariant (the whole point)

claude produces **only data**: one JSON contract proposal. It never mutates router
state, never validates itself, never executes. router treats the proposal as
untrusted input and validates it deterministically. **The LLM cannot widen its own
blast radius** -- an over-broad or malformed proposal is rejected by pure code, and
even an accepted proposal still passes through the mechanical verifier and merge/
approval gates when run.

## Scope (v1)

- **In:** a single `router plan "<goal>"` producing one task contract; static repo
  digest as context; one headless `claude -p` call; deterministic validation of the
  proposal; materialize at DRAFT by default; `--run` chains validate/queue/run.
- **Out (YAGNI):** multi-task DAG decomposition; planner auto-retry on rejection;
  agentic repo exploration by claude; any change to the existing gates.

## Architecture (rings: domain -> core -> io -> app -> cli)

### domain
- `ProposedContract` type: the JSON shape claude must emit --
  `{ id, title, allowed_globs, forbidden_globs?, max_changed_lines, build_ref,
  test_ref, contract_md }`.
- `RepoDigest` type: `{ files: string[], verificationRefs: string[],
  readmeHead?: string, scopeDefaults?: {...} }`.
- `PlanCheckResult` type: `{ ok: true, contract } | { ok: false, errors: string[] }`.

### core (PURE, unit-tested without claude)
- `planPrompt.ts` -- `buildPlannerPrompt(digest, goal): string`. Deterministic prompt
  telling claude to emit ONLY the JSON contract, listing the legal `build_ref`/
  `test_ref` values and the scope constraints (smallest scope, no bare `**`).
- `planCheck.ts` -- `parseAndCheck(rawText, { policyRefs, trackedFiles }):
  PlanCheckResult`. Extracts the JSON, then deterministically checks:
  1. JSON parses and matches `ProposedContract` (reuse/extend `domain/validate.ts`
     against a task-shaped schema).
  2. `build_ref` and `test_ref` are members of `policyRefs` (the policy's
     `verification` keys).
  3. `allowed_globs` is non-empty, contains no bare `**` / `**/*` catch-all, and every
     glob matches at least one entry in `trackedFiles`.
  4. `max_changed_lines` is a positive integer within a sane ceiling.
  5. Risk is computed via the existing `core/risk.ts` `classifyRisk(allowed_globs)`
     and surfaced (not itself a hard failure; the merge approval gate handles high
     risk downstream).
  Any failure -> `{ ok: false, errors }`, no partial acceptance.

### io
- Repo digest inputs come from existing `io/git.ts` (`git ls-files`) and the on-disk
  policy via `app/policyLoad.ts`. A thin helper lists tracked files (capped, e.g.
  first N, with a note when truncated -- never silently).
- The claude call is a single one-shot: `claude -p "<prompt>" --output-format json`
  (`ROUTER_CLAUDE_BIN` override for tests), reading the final text from the `.result`
  field of the JSON envelope. Unlike the executor, the planner needs **no** file or
  tool permissions (no `--add-dir`, no `bypassPermissions`): it only consumes the
  prompt and returns text, so it cannot touch the repo at all.

### app
- `plan.ts` -- `runPlan(deps, goal, opts): PlanOutcome`:
  1. Load on-disk policy; build `RepoDigest` (tracked files + verification refs +
     README head).
  2. `buildPlannerPrompt` (core).
  3. Invoke claude headless; capture text.
  4. `parseAndCheck` (core) with `policyRefs` + `trackedFiles`.
  5. On `ok: false` -> return the errors (CLI exits nonzero, nothing materialized).
  6. On `ok: true` -> materialize: create the task (reuse `createTask` scaffolding),
     write the proposed `task.yaml` (with `base_sha: null`) and `TASK_CONTRACT.md`.
     Task is at DRAFT.
  7. If `opts.run` -> chain the existing `validate` -> `queue` -> `run` handlers.

### cli
- `router plan "<goal>" [--id <id>] [--run] [--json]`.
  - default: generate + validate proposal + materialize at DRAFT + print contract and
    risk for human review.
  - `--id`: task id (else derive a slug from the title/goal deterministically).
  - `--run`: chain validate/queue/run after materializing.
  - `--json`: machine-readable output.
- Register in `HANDLERS`; add `plan` to help text; add any new value flags to
  `cli/args.ts`.

## Data flow

```
goal + repo
  -> app: build RepoDigest (io/git ls-files + policy verification refs + README)
  -> core: buildPlannerPrompt
  -> io:  claude -p --output-format json (one shot) -> .result text (JSON contract)
  -> core: parseAndCheck(raw, {policyRefs, trackedFiles})
        ok:false -> print errors, exit 1, materialize nothing
        ok:true  -> app: materialize task (task.yaml + TASK_CONTRACT.md) at DRAFT
                    --run? -> validate -> queue -> run (existing gates)
```

## Error handling

- Malformed / non-conforming claude output -> `{ ok:false, errors }`; CLI prints each
  reason and exits 1; no task created.
- `claude` binary missing / non-zero -> a clear env-style error (mirrors how the
  worker path reports `env_error`); no task created.
- Truncated repo digest -> logged explicitly (never silently dropped), per the
  project's "no silent caps" convention.
- `--run` after a successful plan uses the existing failure handling of
  validate/queue/run unchanged.

## Testing

- **Pure (`node:test`, no claude):**
  - `planPrompt`: digest + goal -> prompt contains the goal, the legal refs, and the
    scope constraints.
  - `planCheck`: valid JSON -> ok; each failure mode distinctly -> errors: unknown
    build/test ref, bare `**` scope, glob matching zero tracked files, non-positive /
    oversized `max_changed_lines`, unparseable JSON, missing field.
- **App/CLI (fake bin):**
  - `router plan` with `ROUTER_CLAUDE_BIN` = a fake emitting a canned valid contract
    -> task materialized at DRAFT with correct `task.yaml` + `TASK_CONTRACT.md`.
  - Fake emitting an invalid contract (bad ref / bare `**`) -> exit 1, no task created.
  - `--run` with fake claude planner + fake codex executor -> reaches PASSED.
- **Gate:** `npm run check` green, `npm run build` regenerates `dist/router.js`,
  `node dist/router.js selftest` green. `core/` stays pure (planPrompt/planCheck take
  all inputs as arguments; no fs/clock/spawn).

## Files

- New: `src/core/planPrompt.ts`, `src/core/planCheck.ts`, `src/app/plan.ts`,
  `test/core-plan.test.ts`, `test/cli-plan.test.ts`, `testkit/fakeClaudePlanner.mjs`.
- Changed: `src/domain/types.ts` (new types), `src/cli/commands.ts` (verb + help),
  `src/cli/args.ts` (flags), possibly `src/domain/validate.ts` / a small schema for
  the proposed-contract shape, `README.md` + `docs/quickstart.md` (document `plan`).
- Regenerated: `dist/router.js`.
