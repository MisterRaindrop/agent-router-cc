---
description: Adversarially review the plan you just made -- an independent second-opinion model tries to refute it; YOU and the user judge
allowed-tools: Bash, Read, Write, Task
---
Before executing a plan, get an independent, adversarial second opinion on the **plan
itself** -- its soundness, risks, and whether there is a better approach. This reviews
the *approach*, NOT how the work will be split into tasks (that is `/router:go`).

**You do not review your own plan.** Launch an **independent reviewer -- a different
model from yourself** (you are Claude, so prefer a non-Claude reviewer, e.g. run
`codex exec` via Bash, or a `Task` subagent pinned to another model). Independence is
the whole point: it catches blind spots a self-review shares.

**The human is the judge, not you.** Print the reviewer's critique **verbatim** so the
user can see it. You do not decide which objections are valid, and you do not silently
revise the plan on the reviewer's say-so -- the user does. Revisions happen here, in
this session, between you and the user.

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
