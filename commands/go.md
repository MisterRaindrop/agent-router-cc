---
description: Execute the plan we just discussed -- dispatch clear subtasks to cheaper models, then YOU review and verify in the real environment before merge
allowed-tools: Bash, Read, Edit, Write, Task, ExitPlanMode
---
The user has finished planning WITH YOU in this conversation and now wants router to
execute. Do NOT re-plan from scratch or shell a separate planner -- YOU decompose the
plan you both just agreed on, using the full context you already have.

**Division of labor.** The **router CLI** owns only the mechanism it alone can provide:
isolated `git worktree`s, process supervision (one executor or several at once), and fast
*environment-free* gates on the diff (it applies cleanly, stays within `allowed_globs`,
leaks no secrets, and a script added where its siblings are executable carries the
executable bit). **YOU (Opus)** own every judgment -- how to split the work, what may run
concurrently, whether a diff is correct, whether it needs verifying, and, crucially,
**running the real build/tests yourself in this session's real environment** (you have
Bash, Docker, and the full toolchain; the sandboxed executor does not). A cheap model can
clear a shallow gate while being lazy or wrong, so verification -- and the pass/fail
verdict -- stays with you, never with the executor and never compressed.

**Wall clock is dominated by YOUR turns, not by the executors.** Measured on a real plan:
five executor runs took 12.8 minutes of executor time in total, while the plan as a whole
took about three hours across roughly 317 orchestrator turns -- and five cold starts
re-explored the same repository five times (1.88M executor input tokens for a ~400-line
feature). So the rules below are not stylistic: **fewer and larger packages, concurrent
where independent, one CLI call instead of several, and no turn spent on what a mechanical
gate can decide.**

**Plan-mode gate (check this FIRST).** `/router:go` executes: it authors task files and
dispatches, and both mutate -- so both are BLOCKED while the session is in plan mode.
Therefore:
- **If you are in plan mode:** do the read-only decomposition below (work out the packages,
  scopes, and tiers in your head -- but do NOT run `router new` or edit any file yet;
  those writes are blocked). Then present the package list via **`ExitPlanMode`** as the
  approval gate. That single approval both exits plan mode and authorizes execution -- it
  **IS Touchpoint 1**, so do not ask again. Only AFTER the user approves and plan mode
  exits do you run `router new`, edit `task.yaml`, and dispatch. **Never attempt `router
  new`/`dispatch` while still in plan mode** -- it will fail and leave the user unsure
  whether anything ran.
- **If you are not in plan mode:** proceed normally; Touchpoint 1 is a plain confirmation.

1. **Decompose the plan into as FEW work packages as its dependency structure allows** --
   typically one to three for a feature, not one per file. A **work package** is the largest
   coherent chunk one executor can finish in one session from its contract alone, carrying a
   test story of its own. Mechanical steps that belong to the same change go **inside one
   package as ordered steps of its contract**, never split across dispatches: every extra
   package costs a fresh executor cold start (it re-reads the same code from scratch) plus a
   review round trip of yours. Split only where you must -- a genuine dependency, an
   unrelated area of the codebase, or a package too large for one session.

   Author each package by running this with a real id/title substituted in (`<id>`/`<title>`
   are placeholders -- do NOT run it verbatim):

   `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" new <id> --title "<title>"`

   then edit `.router/tasks/<id>/task.yaml`:
   - `allowed_globs`: the smallest scope that still covers the whole package.
   - `tier`: `weak` for mechanical work, `strong` for a package that needs more capability.
     Router then picks the executor by real quota and the model + reasoning effort from the
     tier config (`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models` shows it) -- router
     never judges difficulty itself; that judgment is yours. Tier efforts are matched to the
     work (mechanical at `medium`, capable at `high`) because effort buys latency on the
     critical path; escalate only for genuinely high-risk work (concurrency, security, an
     architectural invariant) with an explicit `worker: { kind, model, effort }` pin, which
     also overrides the tier.
   - `max_wall_minutes`: fit the package -- a bigger package needs a bigger budget.
   - `verify`: see **the deterministic gate** below.
   - `plan_id`: **the same short slug on every package of this plan** (e.g. the feature
     name), so `router usage` can group the plan and show main-vs-executor cost. Also
     **note the current ISO timestamp now** (`date -u +%Y-%m-%dT%H:%M:%SZ`) as the plan's
     start -- you will pass it to `orchestrator-usage` at the end.

   Make each package's Definition of Done include **writing tests for the code it changes**
   (the cheap model produces a first cut; you vet them).

   **The deterministic gate (`verify`).** Decide once per plan: does this project have a
   fast, self-contained gate -- a build/test command that runs from a clean checkout in
   seconds to a few minutes, with no Docker and no network? Check it **empirically, once**: a
   run worktree lives under the repo (`.router/worktrees/<id>/<run>`), so ancestor dependency
   resolution (`node_modules`, a venv) usually just works. If it does, put that command in
   `verify:` for every package (e.g. `verify: [["npm", "run", "check"]]`). The executor's
   diff then arrives already proven to compile and pass, a failure returns as FAILED with a
   log tail instead of costing you turns to discover, and your review goes on judgment
   instead of on breakage. If the project's real gate needs Docker or CI (a large C++ build,
   say), leave `verify: []` and run it yourself at the stage gate. Either way `verify` is
   mechanical: it answers "did it run and pass", never "is it right".

   **Touchpoint 1:** show the user the package list -- each package with its scope, its tier,
   whether it carries a deterministic `verify`, which packages you intend to run
   concurrently, and the note that each carries its own tests -- plus any unclear work. Then
   wait for their go-ahead. (In plan mode this gate is the `ExitPlanMode` approval above --
   one approval exits plan mode AND authorizes execution; do not double-ask.)

2. **Dispatch. Run independent packages CONCURRENTLY, in ONE call.**
   `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" dispatch <id> [<id> ...] [--max-parallel <n>] --json`
   Router gives each package its own worktree and run branch, picks each executor by real
   remaining quota, supervises them, and clears the environment-free gates (diff applies +
   scope + secret scan + exec bit) plus any `verify` you set.

   **Two packages may run concurrently exactly when (a) neither needs the other's output and
   (b) their `allowed_globs` are disjoint.** That judgment is yours -- router does not
   second-guess it, and if you get it wrong the merge in `land` is fail-close (it aborts and
   restores the tree). Pass every independent package in a single `dispatch` call: it
   supervises them in parallel and returns all results together, so the wall clock is the
   slowest package rather than the sum, and it costs you one turn instead of one per package.
   Never fan out with background shells you then poll -- each poll is a full orchestrator
   turn, the expensive thing here. Packages that DO depend on each other stay serial: land
   the prerequisite, then dispatch the next.

   **Then YOU read the diffs and review them** -- in as few turns as you can: read, judge,
   and land in the same turn where nothing forces a split, and never re-read a file already
   in your context. For each package: is the implementation correct? did it drift from the
   change you specified? **are the tests real assertions rather than hollow or hardcoded
   stubs?** is the changed code actually covered? Judge the risk. Then branch:
   - **Low-risk and the review is clean** ->
     `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" land <id> [<id> ...]`
     merges them into your working branch in the order given -- batch the lands you have
     approved into one call. (Don't run its build/tests now -- the mandatory final gate in
     step 4 covers low-risk work.)
   - **Review is doubtful, the change is high-risk, or it drifted** -> verify it now,
     yourself, in the real environment: run the relevant build/tests with Bash (invoke
     Docker/CI exactly as this project requires). **Read the entire output yourself and judge
     it -- do not compress it, and do not let a cheap model decide pass/fail.** Pass -> land.
     Fail -> find the root cause and prefer
     `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" resume <id> --feedback "<what is wrong>"`,
     which continues that executor's session with its context intact instead of paying
     another cold start; re-dispatch only when the contract itself was wrong (once -- if it
     still fails, take the package over yourself). For correctness-critical paths, write or
     harden the tests yourself rather than trusting the executor's.

3. **Touchpoint 2:** handle any UNCLEAR work directly with the user (clarify, then implement it
   yourself). Never dispatch it to a cheap model.

4. **Touchpoint 3 -- stage gate (mandatory; you do all of it yourself).** This is the
   **floor**, not the final word: enough to say "this stage holds together", so the user can
   confirm the direction before anyone spends a strict review on it. Once every package has
   landed and every unclear item is done:
   - **Work out how to build and test this project yourself** by reading `package.json` /
     `Makefile` / CI config / etc. The user does not supply build/test commands and there is no
     manifest -- discover them.
   - Confirm **every changed line is covered by a test** (key paths and all modified code; aim for
     complete coverage, allowing only what genuinely cannot be covered). Fill any gap -- write the
     missing tests yourself, or dispatch a focused test-writing package (which must then pass too).
   - **Run the full-chain CI/build/tests in the real environment** (Docker included), **exactly as
     this project's CI invokes them**. **Read the complete output yourself, uncompressed, and
     decide** whether everything ran and passed. A per-package `verify` does not replace this run:
     it proved each package in isolation, not the combination.
   - **Never make the environment cooperate.** Do not `chmod` a file, hand-edit a config, install
     an undeclared dependency, pre-create a directory, or touch fixtures to get a test to run. If
     something fails on such a detail (a missing executable bit, a wrong file mode, an undeclared
     dependency, leftover state from a previous run), **that is a defect in the diff** -- fix it in
     the diff and re-run. A gate you helped pass verifies your workaround, not the change: it stops
     being evidence.
   - Do a **floor review** of the combined change yourself: does it do what the user asked, is
     anything obviously wrong or out of scope, are the tests real assertions?

   - **Record the orchestrator's own spend** so `router usage` can show main-model-vs-executor
     for this plan: run
     `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" orchestrator-usage --plan <plan_id> --since <the start timestamp you noted in step 1>`.
     It sums this session's main-model turns since then from the Claude transcript and records
     one approximate orchestrator row. If it reports "no transcript", pass `--transcript <path
     to this session's .jsonl>` (or `--projects-dir`). It is best-effort and approximate
     (it includes any interleaved chat and excludes pre-`go` planning) -- report the tokens
     saved from `router usage`, not a fabricated number, and never present the approximate
     orchestrator figure as exact.

   Then **stop and hand the stage back to the user**: report the combined diffs, that the full
   chain is green in the real environment, the per-plan main-vs-executor cost from `router usage`
   (actual total vs the all-baseline estimate), and state plainly that this was the **floor
   check, not a strict review**. Recommend `/router:review` as the **next stage** -- an
   independent, adversarial review of the landed code -- and let the user decide when to spend
   it: if the direction turns out to differ from what they wanted, a strict review now is wasted
   work. **Land nothing the user has not approved.**

You planned, decomposed, reviewed, verified in the real environment, and merged; the cheap models
did the execution -- that is the token saving.

**Why the review is a separate stage.** A green suite is weak evidence about judgment. Measured on
real bugs: a cheap executor's fix passed the held-out oracle test, every regression test, and this
floor review -- and an independent reviewer still found its guard condition was one notch too
broad, silently disabling an optimization the tests could not see. The floor catches "is it
broken"; the strict review catches "is it right". Keep them as two stages so the user gets to
confirm direction between them.

Optional first bookend: run `/router:spec` **before** `go` to adversarially review the plan.
