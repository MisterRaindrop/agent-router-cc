# Lean Dispatcher Redesign -- Implementation Plan

> **For agentic workers:** implement phase by phase; keep `npm run check` green at the end of every phase so `main`/CI stay green. Steps use `- [ ]`.

**Goal:** Collapse router to a zero-ceremony task dispatcher with a double verification gate. Spec: `docs/superpowers/specs/2026-07-16-lean-dispatcher-redesign.md`.

## Global constraints

- Node 22 type-stripping: `.ts` imports; no enum / param props / namespace; `exactOptionalPropertyTypes` (conditional spread, never pass `undefined`).
- Rings `domain -> core -> io -> app -> cli`; `core` pure (`scripts/check-deps.mjs`).
- ASCII only; Apache-2.0 SPDX header on new files; no `Co-Authored-By`.
- Gate each phase: `npm run check`; rebuild `dist/router.js`; `selftest` (or its replacement) green.
- Branch `feat-lean-dispatcher`; main is protected (CI `check` must pass); land via PR.

## Phasing (each phase ends green)

### Phase 1 -- Policy-free, task-carried verify + auto-scaffold

Make the lean path (`dispatch`/`land`) independent of `policy.yaml`, `init`, and git.

**Files:** `src/domain/types.ts`, `src/app/verifier.ts`, `src/app/dispatch.ts`, `src/app/taskLoad.ts`, `schema/task_contract.schema.json`, `src/cli/commands.ts` (init auto-scaffold + gitignore), tests.

- [ ] `TaskYaml`: add `verify?: string[][]` and `model?: string`; mark `build_ref`/`test_ref`/`base_sha`/`verification_params` optional/deprecated (kept for back-compat this phase). Update task schema (`verify` array-of-argv; `model` string).
- [ ] `verifier.ts`: add a task-verify mode -- run `task.verify` argv(s) directly for the build/test checks instead of resolving `policy.verification[build_ref]`. Keep diff/scope/secret/`contract_hash`->drop-to none. New `VerifyRequest` variant takes `verify: string[][]` + `allowedGlobs` + no policy. Scope check uses the task's `allowed_globs`/`max_changed_lines` directly (no `EffectiveScope` from policy).
- [ ] `dispatch.ts`: stop calling `loadPolicyFromGit`. Executors default to `[{kind:'codex'},{kind:'claude'}]` unless the task pins `model`/kind. Read `verify` + scope from `task.yaml` (disk). Secret scan always on. base_sha = HEAD (already).
- [ ] `dispatch.ts`: auto-scaffold -- if `.router/` (or task dir) missing, create dirs on the fly; never require `init`.
- [ ] `init` handler: keep as an optional convenience but (a) write no `policy.yaml`, (b) write `.gitignore` = `*` (ignore ALL of `.router/`). `dispatch` no longer needs anything init produced.
- [ ] Tests: `app-dispatch` + `cli-dispatch` updated -- a task with `verify: [["node","--test"]]` passes; `verify: [["node","-e","process.exit(1)"]]` fails; a task with `verify: []` passes on diff/scope/secret only; dispatch works in a repo with **no `.router/policy.yaml` and no init**.
- [ ] Gate + commit.

### Phase 2 -- `/router:go` orchestration: Opus decomposes + reviews

No cold planner in the interactive path; Opus decomposes from context and semantically reviews each diff.

**Files:** `commands/go.md`, `commands/dispatch.md`, `commands/land.md`; a CLI helper to create a task from an Opus-authored contract if not already present (reuse `router new` writing `task.yaml` with the new fields, or a `router task add --file`).

- [ ] Rewrite `commands/go.md`: the prompt instructs the main session to (1) decompose the ALREADY-DISCUSSED plan into tasks itself, writing each `task.yaml` (id/title/allowed_globs/verify/model/depends_on) -- NOT shell a `claude -p` planner; (2) confirm the task list with the user [touchpoint 1]; (3) `router dispatch <id>` each clear task in dep order; (4) after each mechanical PASS, **read the diff (`router result`/diff) and review it**, re-dispatching once if the cheap model was lazy/wrong; (5) handle unclear tasks directly [touchpoint 2]; (6) present all reviewed diffs + savings and land on approval [touchpoint 3].
- [ ] Add a way for the session to author a task without the old `new` scaffold if `new` is being removed: e.g. `router task <id> --title ... --globs ... --verify ...` OR keep a minimal `new` that just writes a `task.yaml` skeleton. Decide during impl; simplest is a `new` that writes the slim `task.yaml`.
- [ ] Update `dispatch.md`/`land.md` wording to the policy-free model.
- [ ] Gate + commit (mostly docs/prompts; no test regressions).

### Phase 3 -- claude quota via wrapper statusline

**Files:** `statusline/router-usage.mjs` (new), docs.

- [ ] `statusline/router-usage.mjs`: read Claude Code statusline JSON on stdin; best-effort extract `rate_limits` (defensive: `primary/secondary.used_percent/resets_at` or `used_percentage`); if found and a `.router/` exists in the cwd, write `.router/usage.json` = `{used_percent, resets_at, reached}` (the shape `io/quota.readClaudeQuota` already consumes). Then exec/print the user's prior statusline command if configured via `ROUTER_INNER_STATUSLINE` (chain, don't clobber). If nothing found, no-op.
- [ ] Document opt-in: set `statusLine` to this script (one line), optionally point `ROUTER_INNER_STATUSLINE` at claude-hud. Note it's best-effort.
- [ ] Test: feed a sample stdin JSON to the script -> asserts `.router/usage.json` written with the right shape (node child test or a unit around an extracted pure `extractUsage(json)` helper -- prefer the pure helper in `core` + a thin io script).
- [ ] Gate + commit.

### Phase 4 -- Remove Layer 3 (the actual slim-down)

Delete the machinery the lean path no longer uses. Do it after 1-3 so removal is mechanical.

**Remove files:** `core/{stateMachine,escalation,budget,caps,gc,risk,stats,contractHash}.ts`, `app/{transition,routing,recover,registry,worker,policyLoad,plan}.ts`, `io/{lock,signals}.ts`, `schema/policy.schema.json`, and their `test/*` files. Trim `domain/types.ts` (drop `TaskState` graph, `Policy`, escalation/caps/budget/tiers/pricing/routing types, event/registry/lease types) to what the lean path uses.

- [ ] Remove the cut CLI verbs from `commands.ts` `HANDLERS` + imports + help; keep `dispatch`, `land`, optional headless `plan` (if retained) and `new` (slim), `result`, `selftest` (or replace selftest with a lean canary).
- [ ] Delete `store` functions tied to removed state (events/registry/lease/baseline/routing/metrics-for-stats); keep result + a minimal metrics append for savings if still surfaced.
- [ ] Delete the removed modules' test files; keep/port the pure-core tests still relevant.
- [ ] `scripts/check-deps.mjs` still green (core shrank).
- [ ] Gate + commit. Expect the test count to drop substantially; that's the point.

### Phase 5 -- Docs, version, real run, PR

- [ ] README + `docs/quickstart.md`: rewrite to "install -> talk to Opus -> go", the double gate, no init/policy/commit. Remove references to cut verbs.
- [ ] `router --help`: only the lean verbs.
- [ ] Bump `package.json` + `.claude-plugin/plugin.json` to `0.5.0`.
- [ ] `npm run check` green; rebuild `dist/router.js`; a real scratch run: no init, no policy, author a task, `dispatch` on real codex -> PASS -> `land`.
- [ ] Update `.claude-plugin/marketplace.json` description if needed. Open PR.

## Verification (end state)

- `npm run check` green; representative tests: pickExecutor (pure), scope/secrets (pure), task validation, dispatch-with-task-verify (fake), quota order (fixture), land (fake), auto-scaffold no-init/no-policy (fake).
- Real: fresh repo, no init/policy, task authored, real codex dispatch -> verify PASS -> land; codex quota read live.
- Manual: `/router:go` drives the 3-touchpoint loop with Opus decomposition + review (exercised by example).

## Notes

- Keep each phase independently green and PR-mergeable if the user wants to land incrementally; otherwise one PR at the end.
- The `claude -p` planner (`plan`/`planPrompt`/`invokeClaudePlanner`) may be retained as a headless-only convenience or removed -- decide in Phase 4 based on whether a no-session entry is still wanted (default: keep `plan` as optional headless, drop it from the primary docs).
