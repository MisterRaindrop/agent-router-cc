---
description: Execute the plan we just discussed -- dispatch clear subtasks to cheaper models, then YOU review and verify in the real environment before merge
allowed-tools: Bash, Read, Edit, Write, Task, ExitPlanMode
---
The user has finished planning WITH YOU in this conversation and now wants router to
execute. Do NOT re-plan from scratch or shell a separate planner -- YOU decompose the
plan you both just agreed on, using the full context you already have.

**Two entry modes -- check for an approved Plan FIRST.** If this feature went through the
design flow (`/router:design` -> `/router:plan`), `.router/plans/<plan_id>/PLAN.md` exists.
Read its frontmatter before anything else:
- **`status: plan_approved` -> execute it verbatim.** The task breakdown was already
  reviewed and approved at `/router:plan`, so author the packages exactly as PLAN.md lists
  them -- fill in only the numeric caps it marked "set at dispatch" (recording them in
  `task.yaml`), carry the plan's revision binding onto every package, and **skip
  Touchpoint 1**: the package list was approved there, and asking again is a wasted pause.
  Set the PLAN.md frontmatter to `status: executing`. If mid-run the code contradicts the
  Design itself (a `CONTRACT_CONFLICT` whose evidence reaches past the contract into the
  approach), stop and take it back to `/router:design` -- a bumped design revision drops
  the Plan to draft, and packages bound to the old revision are refused by the existing
  `plan_revision` machinery.
- **Any other status** (`plan_draft`, or a `design_revision` older than the Design's
  current revision) -> refuse, and point to the stage that must finish first.
- **No PLAN.md** -> proceed below unchanged: YOU decompose. This stays the normal path for
  everyday tasks that never needed a Design -- whether a change deserves the design flow is
  the user's call, never router's.

## Single mode -- one executor takes the whole feature (`go single [...]`)

The user says "single": one work package = the whole feature, no decomposition, no tier
routing, no quota rebalancing. The main session stays the advisor -- plan, review, verdict
-- while one **pinned** executor writes all the code.

**Both executor families are first-class targets.** The pin is always fully specified --
`worker: {kind, model, effort}` -- because each field changes what actually runs: `kind`
picks the launcher (`claude --model <slug>` vs `codex exec -m <slug> -c
model_reasoning_effort=<effort>`), and **an omitted `effort` silently falls back to the
provider default**, which on the codex side is a real capability downgrade. Never write a
partial pin.

Resolve the three fields like this, and state the result before dispatching:

- **Nothing specified** -> `kind: claude`, and the model/effort from the **`critical` row
  of `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models --json` for that kind** (today:
  `opus` at `xhigh`). Read the table, do not hardcode a slug -- the table is the source of
  truth and a stale slug in a prompt is exactly what the `model_mismatch` detector exists
  to catch.
- **The user names a family** ("用 codex 跑", `--codex`) -> same rule against that kind's
  `critical` row (today: `gpt-5.6-sol` at `xhigh`).
- **The user names a model slug** -> look the slug up in `models --json` to get its `kind`;
  keep that kind's `critical` effort unless the user names an effort too. If the slug
  appears in neither family, **ask** -- never guess which launcher a slug belongs to.

**The critical row is the floor, per family.** Single hands one executor an entire feature,
so it gets that family's most capable configuration. The user may deliberately go lower
("用 sonnet 就行"), and that is honored verbatim and recorded in the contract -- but router
**never** lowers it on its own: quota pressure, a 429, or a launch failure **fails loudly**
instead of quietly demoting the run. There is no tier lookup and no quota reordering in
single mode; the pin is the whole routing decision.

**Known observability gap on the codex side.** The live `recent_action` field is extracted
from the claude executor's `stream-json` events. A codex single run still reports phase,
elapsed-vs-budget, log activity and the stall countdown -- but not "which file it is
editing right now". Say so when the user pins codex, rather than letting them wonder why
the statusline is less specific.

**Applicability first.** If the plan spans several unrelated top-level areas or the
expected diff clearly exceeds one executor session, say so and get explicit confirmation
("this looks like 2-3 packages -- single anyway?"). Budgets are sized to the WHOLE feature
with test headroom (measured: ~40% of a real diff was tests; an 800-line cap rejected a
correct 802-line diff) -- and **never silently enlarged**: the values and the reason go
into the contract where the final review can see them.

**The contract is a copy, not a composition.**
- An approved `PLAN.md` exists -> verify its frontmatter says `status: plan_approved`
  (refuse otherwise), then build `TASK_CONTRACT.md` as a compact yaml header (globs,
  `verify`, worker pin, budgets, `plan_id`, `plan_revision`, and `plan_sha256` -- the
  sha256 of the PLAN.md file) followed by the **entire PLAN.md verbatim** via shell
  concatenation. Zero re-authoring -- byte-identical is the test -- so the contract is an
  immutable snapshot of the approved revision; later PLAN.md edits cannot reach a
  dispatched contract.
- No plan (everyday task) -> the compact template: the seven faces at 1-3 lines each,
  ~40 lines. The executor is a strong model; precision beats prose.
- `TASK_CONTEXT.md` is **not** written (measured: +21% executor input, zero quality gain).

**Detached execution plus a listener -- never a foreground wait.** The harness kills
tracked background tasks **by process group** (measured: a nohup'd child died with its
wrapper; a `detached: true` child survived), so launch dispatch detached -- a `node -e`
one-liner using `child_process.spawn(..., {detached: true, stdio: ['ignore', log, log]})`
+ `.unref()`, output to the run's own log -- and arm a **listener** as a tracked
background task watching three sources until one fires: (1) `status.json` gains a
`terminal_state`; (2) the detached pid is gone; (3) `result.json`/`DELIVERY.md` appear.
Process gone with no legal terminal state -> report **"status channel failed"** and fall
back to the authoritative result files; never hang silently. The listener's completion is
what wakes this session into review. If even the listener died (session restart), nothing
is lost: `router list` plus the run's `status.json`/`result.json` rebuild the picture from
disk -- resume the review there.

**Conversation events: two kinds only.** The listener speaks at terminal states and
anomalies (the stall countdown has started) -- periodic progress lives in the statusline,
which costs zero turns. An opt-in periodic in-conversation heartbeat exists
(`--heartbeat <min>`); it costs one model turn per beat, and enabling it says so.

**On wake**: read `DELIVERY.md`, read the **complete diff**, judge it, land, run the final
acceptance -- identical to steps 2-4 below. Single mode changes who executes and how you
wait; it changes nothing about what may merge.

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
   - `max_changed_lines`: **budget implementation + tests + deletions, then leave headroom.** This
     cap has rejected correct work twice, both times because it was sized to the implementation
     alone. Measured: a package whose contract demanded unit, stateless *and* integration coverage
     came in at 1181 changed lines against a cap of 1000 -- about **40% of the diff was tests**,
     and 93 of those lines were deletions, which count too. A rejection here is not free: the
     executor has already done the whole job, and recovering costs a `resume` whose input is
     larger than the original run's.
   - `verify`: see **the deterministic gate** below.
   - `plan_id`: **the same identifier on every package of this plan**, so `router usage` can
     group it and so its artifacts live together under `.router/plans/<plan_id>/`. Pick
     something that still means something next month, in this order: **the issue or PR number**
     (`issue-90731`), else **the branch name with `/` replaced by `-`**
     (`feat-p2-probe-and-routing`), else a dated kebab description (`spec-cost-2026-07-31`).
     It doubles as a directory name, so it must be path-safe -- the schema enforces that, and
     a raw branch name with a `/` in it is rejected rather than quietly creating a nested
     directory. **Decide it once and copy it verbatim onto every task**: a branch can be
     renamed mid-flight, and re-deriving the id would split one plan's history in two.
     Also **note the current ISO timestamp now** (`date -u +%Y-%m-%dT%H:%M:%SZ`) as the plan's
     start -- you will pass it to `orchestrator-usage` at the end.

   Write each package's `TASK_CONTRACT.md` with **all seven faces** -- goal, invariants,
   frozen interfaces/dependencies, definition of done (including **its own tests**), blast
   radius, stop conditions, version binding. **If you cannot write all seven, it is still a
   decision, not a task: keep it and do it with the user** (that is Touchpoint 2). Rate its
   risk `Low | Normal | High` per `${CLAUDE_PLUGIN_ROOT}/references/assurance-core.md`; when
   unsure, escalate -- never downgrade a tier to justify fewer checks.

   **Also write `TASK_CONTEXT.md` -- but only from what you already know.** Authoring the seven
   faces already required you to establish the invariants, the frozen interfaces and the entry
   points, so writing them down as a navigation summary is nearly free. The rule that keeps it
   free: **never explore extra in order to fill it in.** Record verified facts with
   `path:line`, separate them from assumptions the executor must confirm, paste no source, and
   if you have nothing established to say, leave the section out rather than padding it.
   Frontmatter must carry `task_id` and the dispatch `base_sha` (plus `plan_revision` when the
   contract declares one) -- a summary that cannot be shown to describe the code about to be
   worked on is refused before any executor starts, never quietly used.

   Known cost, so nobody is surprised by it: on a small, two-file task the summary made the
   executor's input **21% larger** (474.7k vs 392.6k) for identical quality -- an executor's
   input is re-sent every turn, so the summary is paid every turn while its benefit is
   one-off. That is executor quota, which is the cheap side; the expensive side is the
   orchestrator's own turns, which is exactly why the summary must be a by-product of work
   already done rather than a reason to go exploring. Whether it pays on a large repository,
   where finding the entry points genuinely dominates, is still open -- every dispatch now
   records `task_context_present` and `task_context_chars`, so the answer will come from data.

   **When two tasks would want the same summary, merge them into one package instead**: that
   is cheaper than writing it twice, and always was.

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
   one approval exits plan mode AND authorizes execution; do not double-ask. When executing
   an approved `PLAN.md`, skip this touchpoint entirely -- see the Approved-Plan gate at the
   top.)

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
     which continues that executor's session so it does not re-explore the repository. Send it a
     **precise error summary, not a log dump**, and send **everything you found in one resume** --
     an executor's session is re-sent in full every turn, so each extra round pays the whole
     accumulated prefix again. Measured across three attempts of one task: **7.69M -> 9.18M ->
     9.35M input tokens**, where the third changed *eight lines* and still cost more input than
     the original 1181-line implementation. **For a few mechanical lines, edit them yourself** --
     a resume for two comment changes cost about what the whole implementation cost. Cap this at
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
   - **Cost this step honestly before you promise it, and say so if it is out of reach.** A warm
     build directory does not mean a cheap verification: measured on ClickHouse, adding **one new
     source file** re-triggered CMake's `CONFIGURE_DEPENDS` glob, regenerated the build graph and
     invalidated **9,891 object files** -- the project's own CI budgets four hours for that build.
     Check what the project itself budgets (a CI job timeout is the honest number), and check
     whether the change *adds* files rather than only editing them. If the verification you
     promised cannot run here, say **"this was never compiled"** in exactly those words and let the
     user decide; never let green mechanical gates and a clean review imply that it builds.
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

Optional first bookend: for a large feature, the design flow -- `/router:design` (clarify,
research, draft the Design section by section), `/router:design-review` (independent
adversarial pass, every objection adjudicated by the user), then `/router:plan` (the
implementation plan and task breakdown) -- fixes the approach AND the package list before
`go` ever runs.
