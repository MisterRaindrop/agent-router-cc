---
description: Clarify a large feature in conversation, research the code, then draft a Design doc section by section -- the user confirms every section and gives the final approval
allowed-tools: Bash, Read, Write, Edit, Task, AskUserQuestion
---
This is the **opt-in entry point for large features**. The user -- never router -- decides
whether a change is big enough to deserve it: cross-module work, real approach trade-offs,
or anything where guessing un-discussed details would be expensive. Small changes skip this
entirely: talk them through and run `/router:go` as before. Do not judge task size yourself
and do not suggest this flow for every task.

The flow separates what the old `/router:spec` mixed together. Exactly **two documents**,
in order, each approved by the user before the next stage may start:

- **`DESIGN.md`** (this command) -- why do it, what to do, what NOT to do, the chosen
  approach and its rejected alternatives, risks and invariants, acceptance criteria.
- **`PLAN.md`** (`/router:plan`) -- how: implementation steps, task breakdown, dependencies,
  verification, rollout. Only an approved Design may enter it; only an approved Plan may be
  executed by `/router:go`.

## Files and state

Pick `plan_id` the way `/router:go` describes (issue or PR number, else the branch name with
`/` replaced by `-`, else a dated description). Everything lives in `.router/plans/<plan_id>/`:
`DESIGN.md` (this command's document), `critique-<n>.md` + `DECISIONS.md` (written by
`/router:design-review`), and `spec.lock` -- the per-plan lock (it keeps its historical
name: `router plans` reads that filename). If another session holds it, say so and stop.

**The document's frontmatter IS the stage record** -- there is no side state file, and the
`guard-router-state` hook enforces that only `.md` files under `plans/` are writable:

```yaml
plan_id: <id>
revision: 0            # frozen (bumped) at each approval
status: design_draft   # design_draft | design_approved
approved: null         # { revision, by, date } once approved
```

Approval is an explicit user action and **always the last action of the stage**. Any edit
after approval bumps `revision`, requires re-approval, drops an existing `PLAN.md` back to
`plan_draft`, and is recorded in a Revision Log section -- a changed bar must be visible,
never silent.

## Interaction discipline (hard rules, shared with the whole flow)

- Every interaction shows: **[stage] + what changed this round + what needs confirming +
  explicit actions**. The Markdown file is the source of truth; the conversation shows
  summaries and decisions, not the file.
- Never dump the full document at the user. Show the full text only when explicitly asked.
- Write the document (and every reviewer-facing summary) in the language the user is
  conversing in.

## Phase 1 -- Clarify and research, interleaved

Ask **one question at a time**: goal, scope (in and out), constraints, success criteria, the
trade-offs that matter. Never assume what you can ask -- and never ask what you can verify:
when a claim is checkable in code, check it with the symbol index (`/router:symbol`) and
bounded file slices, and bring back `file:line` evidence. Findings drive the next question;
questions drive the next probe. **Do not start writing the document while the conversation
is still open** -- a document drafted before convergence is guesswork with headings.

## Phase 2 -- Approaches

Present **2-3 genuinely different approaches** with their trade-offs. Recommend one; the
user picks. Record every rejected option and the reason it lost -- that record becomes
"Alternatives considered", which `/router:design-review` requires its reviewer to read so a
road already closed is never re-proposed as a fresh idea.

## Phase 3 -- Write section by section

Seven sections, each a few hundred words, drafted **one at a time**. After each section:
stop, show that section, and ask for an explicit verdict (approve / revise) before writing
the next. Track progress in a header note (`n/7 confirmed`).

1. **Background & goals** -- why; success criteria.
2. **Scope** -- what is in; what is explicitly out (non-goals).
3. **Current state** -- what the research found: modules, call chains, constraints, with
   `file:line` references.
4. **Approach** -- the chosen design and its key decisions; alternatives considered and why
   each was rejected.
5. **Risks & invariants** -- risk tier (the vocabulary of `references/assurance-core.md`);
   Must NOT / behavior that may not break.
6. **Acceptance criteria** -- behavior-level definition of done. *How* each criterion is
   proven (which gate, which check) belongs to the Plan, not here.
7. **Open questions** -- key unknowns. Small ones are marked as `mode: probe` candidates and
   stay in this list; only research too large for a probe is proposed as its own task. There
   is no third document type.

## Phase 4 -- Approval

When all sections are confirmed, ask for approval of the whole document as an explicit
action. On approval: set `status: design_approved`, freeze the bumped `revision`, record
`approved`. Then the user may run `/router:plan`.

An optional adversarial pass -- `/router:design-review`, an independent model attacking the
draft, every objection adjudicated by the user -- can run before approval, as many rounds as
the user wants. It is never automatic and never a prerequisite.
