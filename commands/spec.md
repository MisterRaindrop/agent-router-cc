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

**Run the reviewer in the background.** A review takes minutes; do not block the session
on it. Launch it as a background job, **redirecting its full output to a file** (e.g.
`codex exec ... > .router/spec/critique-<round>.md 2>&1`), tell the user plainly -- e.g.
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
convergence. When the user is satisfied, write the frozen plan to `.router/PLAN.md` as the
input to `/router:go`. That file holds the approach, the identified risks, and the
definition of done (the build/tests `/router:go` runs at the end) -- **not** a task
breakdown.
