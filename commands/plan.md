---
description: Turn an approved Design into the implementation plan -- steps, task breakdown, dependencies, verification, rollout; the user reviews a summary and approves
allowed-tools: Bash, Read, Write, Edit, Task, AskUserQuestion
---
Translate an **approved `DESIGN.md`** into `PLAN.md` -- the *how*: implementation steps,
task breakdown, dependencies, verification, rollout. This stage is deliberately cheap: the
approach was settled at Design, so there is no adversarial review here and no
section-by-section drafting -- one document, one summary review, one approval.

**The gate comes first.** Read `.router/plans/<plan_id>/DESIGN.md`. If it is missing or its
frontmatter is not `status: design_approved`, refuse and point the user to `/router:design`
-- a plan derived from an unapproved design would freeze guesses as commitments. Respect
the plan's `spec.lock` as `/router:design` does.

## The document

`PLAN.md` lives next to the Design. Its frontmatter is the stage record `/router:go` trusts
-- and the **binding** that keeps plan and design honest with each other:

```yaml
plan_id: <id>
design_revision: <the DESIGN.md revision this plan implements>
revision: 0            # frozen (bumped) at approval
status: plan_draft     # plan_draft | plan_approved | executing | done
approved: null         # { revision, by, date } once approved
```

**If the Design's revision ever moves past `design_revision`, this plan is stale**: drop
`status` back to `plan_draft`, re-derive what the Design change affects, and take it back
through approval. Packages already dispatched are bound to the old revision and get refused
by the existing `plan_revision` machinery rather than quietly landing against a new bar.

Four sections:

1. **Implementation overview** -- the steps, their order, what depends on what, milestones.
2. **Task breakdown** -- the work packages, exactly as `/router:go` will author them. Follow
   `${CLAUDE_PLUGIN_ROOT}/references/work-package.md`: as FEW packages as the dependency
   structure allows, each the largest coherent chunk one executor can finish from its
   contract alone. Per package: goal; invariants (inherited from the Design's Must NOT);
   frozen interfaces and dependencies; definition of done including its own tests and
   `verify` command; file scope (`allowed_globs`); stop conditions; `tier` and `risk` (two
   different questions -- capability needed vs cost of being wrong); `depends_on`. Probe
   packages born from the Design's open questions are listed here, ordered before whatever
   depends on their findings. Numeric caps (`max_wall_minutes`, `max_changed_lines`) may be
   set here or marked "set at dispatch" -- `/router:go` fills those in and records them, but
   never changes the breakdown itself. Work that cannot state all seven faces is not a
   package: mark it as a main-session step or a Touchpoint with the user.
3. **Verification matrix** -- every acceptance criterion from the Design mapped to where it
   is actually proven: the environment-free gates, the real gate (`/router:gate` or per-task
   `verify`), the main session's own run, or `unverified` -- kept visible, never papered over
   with a test that does not test it.
4. **Rollout** -- branch and PR strategy, what merges when, how to roll back.

Write the document in the language the user is conversing in.

## Review and approval

Do not dump the document. Present: **[stage] + a per-package summary** (goal, scope, tier,
risk, dependencies, how it is verified) **+ the verification mapping + anything you had to
decide that the Design did not settle** -- those decisions are exactly what the user must
see. Full text on request. Approval is an explicit user action and the last action of the
stage: set `status: plan_approved`, freeze the bumped `revision`, record `approved`. Then
`/router:go` executes it verbatim -- the package list is not re-confirmed there, because it
was approved here.
