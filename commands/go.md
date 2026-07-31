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
   - `tier`: `weak` for mechanical work, `strong` for a package that needs more capability,
     `critical` for security, concurrency, or an architectural invariant. **Decide the minimum
     capability the package actually requires**; router then picks the executor by real quota
     *within* that tier and takes the model + reasoning effort from the tier config
     (`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models` shows it). Router never judges
     difficulty itself, and quota **never** demotes a task to a weaker tier. Efforts are
     matched to the work (mechanical `medium`, capable `high`, `critical` `xhigh`) because
     effort buys latency on the critical path. An explicit `worker: { kind, model, effort }`
     pin overrides the tier when a package must run somewhere specific.
   - `risk`: `low | normal | high` (the vocabulary of
     `${CLAUDE_PLUGIN_ROOT}/references/assurance-core.md`) -- it decides how much independent
     review the package earns, not how capable the executor is. Those are different questions:
     a mechanical change to an auth path is `weak`/`high`.
   - `depends_on`: the packages that must land before this one may run. Declaring it is what
     lets the rest run concurrently with confidence.
   - `max_wall_minutes`: fit the package -- a bigger package needs a bigger budget.
   - `verify`: see **the deterministic gate** below.
   - `plan_id`: **the same short slug on every package of this plan** (e.g. the feature
     name), so `router usage` can group the plan and show main-vs-executor cost. Also
     **note the current ISO timestamp now** (`date -u +%Y-%m-%dT%H:%M:%SZ`) as the plan's
     start -- you will pass it to `orchestrator-usage` at the end.

   Write each package's `TASK_CONTRACT.md` with **all seven faces** -- goal, invariants,
   frozen interfaces/dependencies, definition of done (including **its own tests**), blast
   radius, stop conditions, version binding. **If you cannot write all seven, it is still a
   decision, not a task: keep it and do it with the user** (that is Touchpoint 2). Rate its
   risk `Low | Normal | High` per `${CLAUDE_PLUGIN_ROOT}/references/assurance-core.md`; when
   unsure, escalate -- never downgrade a tier to justify fewer checks.

   **The deterministic gate (`verify`).** Where the real build/tests can run is a property of
   the project, not of the task, so decide it once and **check it empirically once**: if a
   fast self-contained gate runs inside a run worktree (`.router/worktrees/<id>/<run>` sits
   under the repo, so ancestor dependency resolution usually just works), put that command in
   `verify:` for every package (e.g. `verify: [["npm", "run", "check"]]`) -- the diff then
   arrives already proven to compile and pass, and your review goes on judgment instead of on
   breakage. (If `.router/gate.yaml` does not exist yet, **work the build out yourself** from
   `package.json`/`Makefile`/the CI workflow/`Dockerfile`, propose the whole config for the
   user to confirm once, and write it -- never make them author YAML, and never infer a
   `reset` command, which is the one that wipes state. `/router:gate` documents this.)
   If the real gate needs Docker, a single shared build directory, or CI, leave
   `verify: []`, declare `mode: queue` in `.router/gate.yaml`, and verify with
   **`/router:gate <id...>`**: it borrows the project's own checkout under an exclusive lock,
   verifies each commit on the current integration head, keeps the build cache warm, and puts
   your branch back. Tell the executor plainly that it cannot build there, so it reports
   `gate_ran: false` instead of burning its budget on a build that cannot work. Either way `verify` is mechanical: it answers "did it run and pass", never "is it
   right". **`${CLAUDE_PLUGIN_ROOT}/references/work-package.md` has the full rules** -- the
   seven faces, risk-to-review mapping, both gate modes (including borrowing the main checkout
   safely), the delivery-report and `CONTRACT_CONFLICT` protocols, and the session policy.

   **Touchpoint 1:** show the user the package list -- each package with its scope, its tier,
   its risk, whether it carries a deterministic `verify`, which packages you intend to run
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

   **A `CONTRACT_CONFLICT` result means the plan is wrong, not the code.** The executor is
   forbidden to quietly work around a bad contract; when it reports one, nothing lands. Read
   its evidence, decide the depth -- this package's contract only, this package plus its
   declared dependents, or the whole milestone -- and take it to the user. Invalidate only the
   affected subgraph; a conflict is not a reason to redo the plan.

   **Then YOU read the delivery report and the diff, and review them** -- in as few turns as
   you can: read, judge, and land in the same turn where nothing forces a split, and never
   re-read a file already in your context. Start with the run's `DELIVERY.md` (what it did,
   which checks ran, what it flags), then **read the complete diff -- every risk tier, every
   time**. Do **not** read raw build/test output: the verifier's per-check result and the
   report's summary are the evidence, and anything you read is re-read on every later turn.
   Treat `delivery_header: missing`, `gate_ran: false`, or `scope_drift: true` as a reason to
   look harder, never as "probably fine". For each package: is the implementation correct? did
   it drift from the change you specified? **are the tests real assertions rather than hollow
   or hardcoded stubs?** is the changed code actually covered? At `Normal` and `High` risk also
   run an **independent contract review** (a different model -- see `/router:review`) and judge
   its findings yourself. **Never merge on green alone.** Then branch:
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
     another cold start. Send it a **precise error summary, not a log dump**. Cap this at
     **two resume attempts**, then take the package over or bring it to the user;
     re-dispatch only when the contract itself was wrong. For correctness-critical paths,
     write or harden the tests yourself rather than trusting the executor's.

   **Session policy.** `resume` is for the *same* task -- same worktree, same `base_sha`. For a
   *different* task always start a fresh session: a reused one diffs against a stale base (so
   the next diff would carry the previous task's changes, destroying "one task, one auditable
   diff") and it revives plans it already discarded. **Wanting to reuse a session across tasks
   means the packages were split too finely -- merge them into one package instead.** Warm
   repository knowledge travels as artifacts, not sessions: the symbol index (`/router:symbol`)
   gives a fresh session the same knowledge without inheriting stale beliefs.

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
