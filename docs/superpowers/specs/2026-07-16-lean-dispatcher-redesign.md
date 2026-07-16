# Lean dispatcher redesign (spec)

Date: 2026-07-16
Status: approved, pre-implementation

## Context

Across a long design discussion the user narrowed router to its essence: **a task
router that dispatches simple, well-defined subtasks to cheaper models (codex /
sonnet / haiku) while the orchestrator (Opus, the main session) does the reasoning and
review -- to save Opus tokens.** The current v0.4.0 codebase still carries a large
production stack (event-sourced state machine, locks, detached supervision, recovery,
escalation, budget estimation, caps, gc, approval, stats) plus a `policy.yaml` config
file and a mandatory `init` step. That ceremony and weight is over-engineered for the
goal. This redesign strips router to a zero-ceremony dispatcher with a double
verification gate.

## Confirmed decisions

1. **Zero ceremony.** No `init` step: `.router/` auto-scaffolds on first use. No
   `policy.yaml` file. No `git commit` of router state -- `.router/` is gitignored and
   nothing is read from git objects.
2. **No policy file.** Router has built-in defaults: executors are `codex` + `claude`.
   Everything task-specific (scope, verify command, model hint) travels **with the
   task**, authored by the main session at dispatch time. Secret scanning is a
   built-in default (always on, not configured).
3. **Context-driven entry.** The user plans with Opus in normal conversation; when
   they say "go", **Opus decomposes the agreed plan into tasks itself** (it has the
   context) and dispatches them. No cold one-liner to a cheap `claude -p` planner in
   the interactive path.
4. **Double verification.**
   - Mechanical (deterministic): router runs the task's own verify command, plus scope
     enforcement and the built-in secret scan -> PASS/FAIL.
   - Semantic (main session): after mechanical PASS, **Opus re-reads the diff** to
     catch a cheap model being lazy or wrong-but-passing (hardcoding, skipped tests,
     misread intent). This MUST be the capable main session, never a cheap model.
     Automatic; not a human touchpoint.
5. **Executor balancing by real quota.** codex from `~/.codex/sessions/**/*.jsonl`
   (done), claude from a statusline snapshot at `.router/usage.json` (wrapper
   statusline that does not clobber the user's existing statusline). Reactive 429 is
   the backstop.
6. **Three human touchpoints:** (1) confirm the decomposition plan, (2) handle unclear
   tasks interactively, (3) final review of all diffs before land.

## Target task contract

A task no longer references a global policy. `task.yaml` carries everything:

```yaml
schema_version: 1
id: add-validators
title: Add signup validators
allowed_globs: ["src/validators/**"]     # blast radius (scope)
max_changed_lines: 200
verify: [["npm", "test"]]                 # the mechanical gate command(s); [] = none
model: sonnet                             # optional tier hint (else quota-balanced default)
depends_on: []
```

- `verify` replaces `build_ref`/`test_ref` + policy `verification`. `[]` means no
  mechanical command (diff/scope/secret only) -- the main session decides per task.
- No `base_sha`/`contract_hash` freeze ceremony; dispatch pins base_sha = HEAD at run
  time (single foreground process; the executor is isolated in a worktree, so the main
  tree can't be tampered with).

## Flow

```
converse + plan with Opus
 -> user: "go"
 -> Opus decomposes the agreed plan into tasks (writes task.yaml each)      [touchpoint 1: confirm]
 -> for each clear task in dep order:
      router dispatch: quota-pick executor -> run in worktree -> commit
        -> mechanical verify (verify cmd + scope + secret scan)
      Opus reads the diff and reviews it (semantic; re-dispatch once if lazy/wrong)
 -> Opus handles unclear tasks directly with the user                       [touchpoint 2]
 -> Opus presents all verified+reviewed diffs + token savings               [touchpoint 3: land]
 -> land each approved task
```

## Scope: keep / remove

**Keep (the dispatcher core):** `domain/types` (slimmed), `core/{planCheck (reused for
Opus-authored task validation), glob, scope, secrets, pickExecutor}`, `app/{dispatch,
verifier (task-verify based), codexLauncher, taskLoad}`, `io/{git, quota, store
(slim), paths, jsonl, atomicWrite, env, clock, supervisor, proc, exitTaxonomy}`.

**Remove (Layer 3 + policy machinery):** `core/{stateMachine, escalation, budget,
caps, gc, risk, stats, contractHash, budget/routing helpers}`; `app/{transition,
routing, recover, registry, worker (detached spine), policyLoad, plan (claude -p
planner becomes optional/headless-only), usage-as-policy}`; `io/{lock, signals}`;
`schema/policy.schema.json`; CLI verbs `new/validate/queue/run/_worker-run/merge/
status(sm)/approve/cancel/recover/reindex/stats/baseline/routing/ready/list` and their
slash commands. The verifier is rewritten to take the task's `verify` command directly
(no policy, no whitelist-from-git).

**Net:** CLI collapses to `dispatch`, `land`, and a headless-only `plan`; the plugin's
primary surface is `/router:go` (Opus-driven) + `/router:dispatch` + `/router:land`.

## Verification

- Pure unit tests for the kept core (pickExecutor, scope, secrets, task validation).
- App/CLI e2e (fake executors): dispatch runs the task's verify cmd -> PASS; a task
  with a failing verify -> FAIL; quota-order picks the higher-headroom executor;
  land merges a PASSED task; auto-scaffold works with no init and no policy.
- The Opus semantic-review step lives in the `/router:go` slash-command prompt (not
  deterministic code); documented and exercised by example, not unit-tested.
- `npm run check` green after each phase; rebuild `dist`; one real scratch run of the
  full loop (real codex). Bump to v0.5.0.

## Honest caveats

- Dropping the git-object policy read removes the anti-tamper guarantee that mattered
  for concurrent/detached runs; in the single-process foreground model the executor is
  worktree-isolated, so reading task/verify from disk is safe. Verify commands are now
  authored by the main session (Opus) rather than whitelisted in git -- acceptable
  because a human + Opus are in the loop at dispatch and review.
- claude-side real quota depends on the statusline wrapper being installed; without it,
  balancing uses codex real quota + reactive 429 (correct regardless).
- This removes ~half the current code and its tests; done in phases so `main` stays
  green throughout.
