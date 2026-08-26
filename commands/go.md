---
description: Execute the plan we just discussed -- one executor writes the code on its own branch, then YOU review and verify in the real environment before merge
allowed-tools: Bash, Read, Edit, Write, Task, ExitPlanMode
---
The user has finished planning WITH YOU in this conversation and now wants router to execute. Do
NOT re-plan from scratch or shell a separate planner -- you already have the context.

**One run dispatches one work package to one executor.** There is no concurrency and no
decomposition-into-many here: if the work is several packages, run `go` once per package. That is
a deliberate limit, not a missing feature -- see "Why one at a time" at the end.

**The executor works in YOUR checkout**, on a branch called `router/<task-id>`. It does not get a
separate worktree, because a fresh worktree has no dependencies, no build objects and no
configure output, so a real project cannot compile in one. Everything else on this page follows
from that: the whole run holds an exclusive lock, your uncommitted work is committed before
anything moves, and the run ends leaving you standing on the task branch.

Contract-authoring detail lives in `${CLAUDE_PLUGIN_ROOT}/references/task-contract.md` --
`task.yaml` fields, executor pinning, the seven faces, the gate, budgets, the delivery report,
session policy. Read it when authoring; this page is the flow.

## Entry: is there an approved work plan?

Check FIRST. If this feature went through the design flow (`/router:design` ->
`/router:workplan`), `.router/plans/<plan_id>/WORKPLAN.md` exists. Read its frontmatter:

- **`status: plan_approved`** -> execute it verbatim. The breakdown was reviewed and approved at
  `/router:workplan`, so author the package exactly as the plan lists it -- fill in only the
  numeric caps it marked "set at dispatch" (recording them in `task.yaml`), carry the plan's
  revision binding onto the package, and **skip Touchpoint 1**: the list was approved there, and
  asking again is a wasted pause. Set the plan's frontmatter to `status: executing`.
- **Any other status** (`plan_draft`, or a `design_revision` older than the Design's current
  revision) -> refuse, and name the stage that must finish first.
- **No work plan** -> proceed below. YOU author the package. This is the normal path for everyday
  tasks that never needed a Design; whether a change deserves the design flow is the user's call,
  never router's.

If mid-run the code contradicts the **Design** -- a `CONTRACT_CONFLICT` whose evidence reaches
past the contract into the approach -- stop and take it back to `/router:design`. A bumped design
revision drops the plan to draft, and packages bound to the old revision are refused by the
existing `plan_revision` machinery.

## Plan-mode gate (check this second)

`/router:go` authors task files and dispatches; both mutate, so both are BLOCKED in plan mode.

- **In plan mode:** work out the package, scope and tier in your head, but run nothing and edit
  nothing. Present it via **`ExitPlanMode`** -- that single approval both exits plan mode and
  authorizes execution, so it **IS Touchpoint 1**; do not ask again. Only after it exits do you
  run `router new`, edit `task.yaml`, and dispatch.
- **Not in plan mode:** Touchpoint 1 is a plain confirmation.

## Division of labor

The **router CLI** owns the mechanism it alone can provide: the exclusive lock on the checkout,
rescuing your uncommitted work, cutting and asserting the task branch, process supervision, and
fast *environment-free* gates on the diff (it applies cleanly, stays within `allowed_globs`,
leaks no secrets, and a script added where its siblings are executable carries the executable
bit).

**YOU own every judgment** -- what the package is, whether a diff is correct, whether it needs
verifying, and **running the real build and tests yourself in this session's real environment**.
A cheap model can clear a shallow gate while being lazy or wrong, so verification and the
pass/fail verdict stay with you: never with the executor, never compressed.

**Wall clock is dominated by YOUR turns, not the executor's.** Measured: five executor runs took
12.8 minutes of executor time between them while the plan took about three hours across roughly
317 orchestrator turns. So spend no turn on what a mechanical gate can decide.

## 1. Author the package

Per `references/task-contract.md`. Then **Touchpoint 1:** show the user the package -- scope,
tier, risk, whether it carries a deterministic `verify`, and the note that it carries its own
tests -- plus any work you judge unclear. Wait for their go-ahead. (Skip entirely when executing
an approved work plan; in plan mode the `ExitPlanMode` approval is this touchpoint.)

## 2. Dispatch, and know what the twelve steps do

`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" dispatch <id> --json`

That one command is a transaction. You do not drive the steps, but you have to be able to read
its report, so this is what it does:

```
--- outside the lock (read-only, and it talks to you) --------------------
 1  probe        read the current branch and working tree. Already on an unmerged router/*
                 branch -> say so and ask: merge first, or continue from here?
--- inside the lock (one CLI transaction) --------------------------------
 2  take lock    BEFORE any write. Blocked -> report the holder's pid and last-active time
 3  reap         lock reclaimed from a dead holder -> kill its orphan executor group first
 4  rescue       your uncommitted work -> one commit, file list and sha reported
 5  branch       create router/<task-id>. Name already taken -> FAIL, never reuse
 6  contract     WORKPLAN.md + DESIGN.md concatenated verbatim, each with its sha256
 7  dispatch     launch the executor detached, cwd = repository root
--- executing (lock held; heartbeat runs in its own process) -------------
 8  work         the executor commits one functional unit at a time
 9  closing      assert: on the task branch, base_sha is an ancestor of HEAD, and NOTHING
                 is uncommitted. Any failure -> no verification, no success claim
10  verify       gate.yaml reset, then clean-vs-incremental gate, then the five checks
                 (diff applies -> scope -> secret scan -> exec bit -> gate), over base_sha..HEAD
--- finishing -----------------------------------------------------------
11  report       done, and WHICH BRANCH you are on. No switch back, no merge
12  release      terminate the executor's process group, release the lock
```

**Do not commit your own fixes onto `router/<task-id>`.** The scope check at step 10 runs over
`base_sha..HEAD`, so any commit you add lands in it and gets judged against the executor's
`allowed_globs` -- which yours were never written for. Measured twice: a one-line fix of a review
finding, committed onto the task branch, produced `not_allowed:src/app/stateGuard.ts` and `router
land` then refused the whole package with "last dispatch was not PASSED".

The gate is right to do that: your commits really are on the branch and really will land, so it
cannot wave them through. **Put your own fixes on the integration branch after landing the
package.** And do NOT widen `allowed_globs` afterwards to make the gate green -- a gate you helped
pass has stopped being evidence.

Three of those are worth reading the report for:

- **`rescue_sha`** -- you had uncommitted work and it is now a commit on your branch. Undo with
  `git reset --soft <sha>~1`.
- **`closeout`** -- if this failed, the executor left a file uncommitted and **nothing was
  verified**. That is not a gate failure; it is unfinished work.
- **`branch`** -- where you are standing now. Router never switches back and never merges.

**Detached execution plus a listener -- never a foreground wait.** The harness kills tracked
background tasks by process group (measured: a nohup'd child died with its wrapper, a
`detached: true` child survived), so launch dispatch detached -- a `node -e` one-liner using
`child_process.spawn(..., {detached: true, stdio: ['ignore', log, log]})` + `.unref()`, output to
the run's own log -- and arm a **listener** as a tracked background task watching three sources
until one fires: (1) `status.json` gains a `terminal_state`; (2) the detached pid is gone;
(3) `result.json` / `DELIVERY.md` appear. Process gone with no legal terminal state -> report
**"status channel failed"** and fall back to the authoritative result files; never hang silently.
The listener's completion is what wakes this session into review. If even the listener died
(session restart), nothing is lost: `router list` plus the run's `status.json` / `result.json`
rebuild the picture from disk.

**Conversation events: two kinds only.** The listener speaks at terminal states and anomalies
(the stall countdown has started). Periodic progress lives in the statusline, which costs zero
turns. An opt-in in-conversation heartbeat exists (`--heartbeat <min>`); it costs one model turn
per beat, and enabling it says so.

## 3. Review the diff yourself

Read the run's `DELIVERY.md` first (what it did, which checks ran, what it flags), then **read
the complete diff -- every risk tier, every time**. Do NOT read raw build output: the verifier's
per-check result and the report's summary are the evidence, and anything you read is re-read on
every later turn.

The executor committed one functional unit at a time, so **review it commit by commit** -- that
is what the granularity is for. Ask of each: is it correct? did it drift from what you specified?
**are the tests real assertions rather than hollow or hardcoded stubs?** is the changed code
actually covered?

At `Normal` and `High` risk also run an **independent contract review** (a different model -- see
`/router:review`) and judge its findings yourself. **Never merge on green alone.**

Doubtful, high-risk, or drifted -> verify it now, yourself, in the real environment. Read the
entire output yourself and judge it; do not compress it and do not let a cheap model decide
pass/fail. Fail -> find the root cause and prefer
`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" resume <id> --feedback "<what is wrong>"`, which
continues that executor's session instead of re-exploring the repository. The cost rules and the
two-attempt cap are in `references/task-contract.md`.

## 4. Touchpoint 2: unclear work

Handle it directly with the user -- clarify, then implement it yourself. Never dispatch it to a
cheap model.

## 5. Touchpoint 3 -- the stage gate (mandatory, all of it yours)

This is the **floor**, not the final word: enough to say "this stage holds together", so the user
can confirm the direction before anyone spends a strict review on it.

- **Work out how to build and test this project yourself** from `package.json` / `Makefile` / CI
  config. There is no manifest; discover them.
- **Cost this step honestly before you promise it.** A warm build directory does not mean a cheap
  verification: measured on ClickHouse, adding **one new source file** re-triggered CMake's
  `CONFIGURE_DEPENDS` glob, regenerated the build graph and invalidated **9,891 object files** --
  a build the project's own CI budgets four hours for. Check what the project itself budgets (a
  CI job timeout is the honest number) and whether the change *adds* files rather than only
  editing them. If the verification you promised cannot run here, say **"this was never
  compiled"** in exactly those words and let the user decide. Never let green mechanical gates
  and a clean review imply that it builds.
- Confirm **every changed line is covered by a test**. Fill any gap yourself, or dispatch a
  focused test-writing package (which must then pass too).
- **Run the full chain in the real environment** (Docker included), exactly as this project's CI
  invokes it. Read the complete output yourself, uncompressed, and decide. A per-package `verify`
  does not replace this: it proved the package, not the combination.
- **Never make the environment cooperate.** Do not `chmod` a file, hand-edit a config, install an
  undeclared dependency, pre-create a directory, or touch fixtures to get a test to run. If
  something fails on such a detail, **that is a defect in the diff** -- fix it in the diff and
  re-run. A gate you helped pass verifies your workaround, not the change: it stops being
  evidence.
- Do a **floor review** of the combined change: does it do what the user asked, is anything
  obviously wrong or out of scope, are the tests real assertions?
- **Record the orchestrator's own spend** so `router usage` can show main-model-vs-executor:
  `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" orchestrator-usage --plan <plan_id> --since <the
  timestamp you noted while authoring>`. It sums this session's main-model turns from the Claude
  transcript. If it reports "no transcript", pass `--transcript <path>` or `--projects-dir`. It
  is best-effort and approximate (it includes interleaved chat and excludes pre-`go` planning) --
  report the tokens saved from `router usage`, never a fabricated number, and never present the
  approximate orchestrator figure as exact.

## 6. Hand the stage back

Report the diff, that the full chain is green in the real environment, the per-plan
main-vs-executor cost from `router usage` (actual total vs the all-baseline estimate), **which
branch the user is standing on**, and state plainly that this was the **floor check, not a strict
review**.

**Merging is theirs.** Router never merges and never switches back. `router land <id>` merges the
task branch into whatever you have checked out -- so it refuses while you are standing on the
branch being landed, and you pick the target first. Land nothing the user has not approved.

Recommend `/router:review` as the **next stage** -- an independent, adversarial review of the
landed code -- and let the user decide when to spend it: if the direction turns out to differ
from what they wanted, a strict review now is wasted work.

## Why one at a time

Parallel dispatch was removed, and not because it cost anything to run: measured, the whole
orchestration overhead was 0.26s against 393s of executor time -- effectively free. It cost the
human. Several executors editing at once means tracking who changed what, in what order things
merge, and whether merging them breaks each other -- and every result still needs reviewing one
at a time, so review was the bottleneck the parallelism kept feeding.

## Why the review is a separate stage

A green suite is weak evidence about judgment. Measured on real bugs: a cheap executor's fix
passed the held-out oracle test, every regression test, and this floor review -- and an
independent reviewer still found its guard condition was one notch too broad, silently disabling
an optimization no test could see. The floor catches "is it broken"; the strict review catches
"is it right". Two stages, so the user gets to confirm direction between them.

Optional first bookend for a large feature: `/router:brainstorm` (question the idea, compare it
against how others solve it, produce counter-evidence), `/router:design` (clarify, research,
draft the Design section by section), `/router:design-review` (independent adversarial pass,
every objection adjudicated by the user), then `/router:workplan` (the work plan and task
breakdown) -- fixing the approach AND the package list before `go` ever runs.
