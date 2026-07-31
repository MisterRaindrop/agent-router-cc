---
description: Adversarially review the plan you just made -- an independent second-opinion model tries to refute it; YOU and the user judge
allowed-tools: Bash, Read, Write, Task
---
Before executing a plan, get an independent, adversarial second opinion on the **plan
itself** -- its soundness, risks, and whether there is a better approach. This reviews
the *approach*, NOT how the work will be split into tasks (that is `/router:go`).

**You do not review your own plan.** Launch an **independent reviewer -- a different
model from yourself** (you are Claude, so prefer a non-Claude reviewer). Get the reviewer
chain from `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models --json` (the `review` array,
strongest first): launch the first entry via `codex exec -m <model> -c
model_reasoning_effort=<effort>` with the `effort` from that entry (the default is
`xhigh` -- deliberate: plan review rewards breadth of judgment, and a completed xhigh
review beats a max review that times out). Independence is the whole point: it catches
blind spots a self-review shares.

**Everything this command writes is namespaced by `plan_id`** -- `.router/plans/<plan_id>/`
holds the frozen `PLAN.md`, each round's critique, and the decision record. One shared
`.router/PLAN.md` was fine while it was only an output, but two plans reviewed at once in one
repo would overwrite each other's files, and the moment a reviewer is pointed at a plan on
disk that stops being a lost file and becomes a **silent review of the wrong plan**. Pick the
id the way `/router:go` describes (issue or PR number, else the branch name with `/` replaced
by `-`), record it in the plan's frontmatter alongside `plan_revision`, and **tell the reviewer
which `plan_id` it must be looking at -- if what it reads says otherwise, it must refuse rather
than review.** If another session already holds `.router/plans/<plan_id>/spec.lock`, say so and
stop: two sessions interleaving rounds on one plan produce a decision record that contradicts
itself.

**Run the reviewer in the background.** A review takes minutes; do not block the session
on it. Launch it as a background job, **redirecting its full output to a file** (e.g.
`codex exec ... > .router/plans/<plan_id>/critique-<round>.md 2>&1`), tell the user plainly -- e.g.
"plan review running in the background (<model>, effort <effort>, ~a few minutes); go do
other work, I'll surface the critique when it lands" -- and continue. Running detached
also avoids the interactive timeout that a foreground review can hit. When it completes,
surface the critique from the file (verbatim, see below). **`max` effort is opt-in, not
default:** use it only when the user explicitly asks for the deepest possible pass on a
high-stakes plan (still in the background -- it can take ~15 minutes).

**Guard against truncation.** A thorough critique can be long, and it can be cut off at
two points: the reviewer's own output cap (generation stops mid-way), and the shell/tool
buffer when you read it back. So: (1) always write to the file above -- the file holds the
complete output regardless of tool buffers; read it in chunks if large, never rely on
inline stdout capture. (2) Check whether the output was truncated -- codex's finish/exit
signal, or the text ending mid-objection. If it was, **re-invoke the reviewer to continue
from where it stopped** (or split the plan into parts) and **never present a truncated
critique as complete** -- say "critique was truncated, continuing" and finish it. Keeping
each objection compact and structured (the format below) fits more before any cap.

**The human is the judge, not you.** Print the reviewer's critique **verbatim** so the
user can see it. You do not decide which objections are valid, and you do not silently
revise the plan on the reviewer's say-so -- the user does. Revisions happen here, in
this session, between you and the user.

When you need to check a plan claim against the codebase, navigate with the symbol index
rather than reading whole files (see `/router:symbol`): `router symbol index <dirs>` once,
then `symbol find` / `enclosing` / `methods`, opening only bounded slices. It keeps this
session's context small.

## Define what must be proven (the assurance plan)

Beyond judging the approach, `/router:spec` fixes the bar `/router:review` will later hold
the change to. Read `${CLAUDE_PLUGIN_ROOT}/references/assurance-core.md` and produce, at a
depth **proportional to the change** (a Low-risk change needs almost none of this; a
High-risk change needs all of it):

- **Scope & impact:** root cause; entry points and callers; public API; persisted data;
  concurrency; security boundary; performance-critical paths; compatibility range. (Map
  these with the symbol index, not whole-file reads.)
- **Risk tier** (Low/Normal/High) via the deterministic triggers in assurance-core --
  escalate when unsure, never downgrade to skip checks.
- **Failure Model:** for each way it can break -- consequence + the check that would catch
  it; if no available check can, mark it `unverified` (do not fake a unit test for it).
- **Must NOT / invariants**, plus a few concrete `Given/When/Then` scenarios (minimal, not
  exhaustive Gherkin).
- **Verification Matrix:** the compact table from assurance-core (scenario/risk ->
  verification layer -> necessity); tooling-dependent rows are `conditional`.
- **Environment & dependency plan:** which existing project commands to use; whether a new
  tool is needed (**never install silently**; if the user does not approve it, the
  dependent checks are `unverified`); each new dependency's purpose.

This is the promise; `/router:review` is the check. Some items appear in both stages -- not
redundancy: spec commits, review verifies.

## What this spec hands to `/router:go`

The assurance plan is not prose that gets re-derived at dispatch time: each part has a slot in
the machine contract `/router:go` writes, so state it in a form that can be **copied** rather
than re-decided.

- **Risk tier -> `risk:` on every package.** It buys independent review, and it is **one-way**:
  the CLI raises it from deterministic signals and never lowers it, so a tier set too low is
  only a floor while a tier set too high really does spend review effort. Keep it distinct from
  `tier:` (how capable the executor must be) -- a mechanical change on an auth path is `weak`
  **and** `high`.
- **Must NOT / invariants -> `invariants:`** in the contract. This is the yardstick
  `/router:review` judges drift against, and the CLI escalates risk when a diff touches a path
  listed there. An invariant nobody wrote down cannot be checked by either one.
- **Verification Matrix -> where each row is actually proven.** Sort the rows: what the
  environment-free gates settle (scope, secrets, executable bit, and whether the `verify` command
  exited 0), what the real gate settles (`/router:gate`, one commit at a time, on a project whose
  environment exists once), and what only the main session can settle. A row no available check
  can cover stays `unverified` and visible -- never quietly replaced by a unit test that does not
  test it.
- **A high-reversal-risk assumption -> a `mode: probe` package.** When one matrix row would
  invalidate the whole approach if it turned out false (platform behaviour, what a dependency
  really does, the real shape of a migration), check it *before* code is written: probe inverts
  the gate so an **empty diff passes**, and its findings enter the implementation package's
  contract as text. Skip it where the project already has the pattern.
- **`plan_revision`** is frozen here and copied onto every package. Revising later is allowed and
  visible (the Revision Log), but packages already dispatched are bound to the old revision -- a
  `TASK_CONTEXT.md` whose revision disagrees with its contract is refused before the executor
  starts rather than quietly used.
- **Environment & dependency plan -> the gate config.** A check needing a tool the project does
  not have is not silently installed; without the user's approval that check is `unverified`.
  `.router/gate.yaml` is confirmed by the user once, and a `reset` command -- the one that wipes
  state -- is never inferred.

None of this is a second copy of the plan. It is the same decisions, written where the machinery
can enforce them instead of hoping they are remembered.

## Each round

1. Hand the reviewer the current plan plus this instruction:

   > You are a demanding staff engineer reviewing a PROPOSED PLAN (not code). Be
   > adversarial -- your job is to find what is wrong or risky; default to skepticism.
   > But judge against "does this plan improve the system", not perfection. Attack: Is
   > the approach correct? What are the hidden risks, edge cases, or failure modes? Is
   > there a simpler or better approach? Does it fit this codebase's conventions and
   > constraints? Cite specifics -- name the concrete consequence, never "follow best
   > practices". Do NOT critique how the work is broken into tasks; only the plan/approach.
   > Emit each objection as `{severity: blocking|advisory|nit, argument: <specific problem
   > + concrete consequence>, suggestion: <concrete fix>}`. If the plan is sound, say so
   > plainly instead of manufacturing objections.
   >
   > Also review the ASSURANCE PLAN (risk tier, Failure Model, Must NOT, Verification
   > Matrix): are risks missed or under-rated? are the acceptance scenarios too loose? can
   > each named check actually surface the failure it is paired with? is there a high-cost
   > check with little value, or a simpler, more reliable verification that was missed?

2. Print the reviewer's output verbatim for the user.
3. The user judges. Apply only the objections the user accepts, revising the plan with
   them here.

## Across rounds (resume, do not restart)

The reviewer is a **persistent session**. On the next `/router:spec` round, **resume the
same reviewer session** and send only what changed since its last critique -- it recalls
its prior objections and can check whether you actually addressed them. This saves tokens
and keeps continuity. (If the installed reviewer CLI cannot resume, re-run it but attach
its previous critique so it has that context.)

The user decides how many rounds to run and when to stop -- there is no automatic
convergence. When the user is satisfied, write the frozen plan to `.router/plans/<plan_id>/PLAN.md` as the
input to `/router:go`. It holds: goals & non-goals; the approach; risk tier; Failure Model;
behaviour scenarios; Must NOT; Verification Matrix; environment & dependency plan; Known
Unverified; Spec Approval; and a Revision Log (every spec revision recorded, so a later
change of the bar is visible). It is **not** a task breakdown -- that is `/router:go`.
