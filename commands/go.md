---
description: Build the change we just discussed -- you write it in this session, the way you would without router (or codex does, when the user names it)
allowed-tools: Bash, Read, Edit, Write, Task
---
The user has finished talking the change through WITH YOU in this conversation and now wants it
built. Do NOT re-plan from scratch -- you already have the context. Start writing.

**You write the code, in this session.** Work exactly as you would if router were not installed:
no extra confirmation round, no ceremony, no checklist of router's own. How you slice the work,
whether and how you commit, and how you verify it are the same judgments you would make anyway.
The one exception is explicit: when the user names a model ("let codex write this"), a part of the
work goes to an external codex writer -- see "When the user names a model" below.
Never choose that yourself.

Why this is thin: measured on real ClickHouse bugs (2026-10), a mandatory confirm / reproduce-first
/ floor-check flow fixed exactly as many bugs as plain Claude Code (3 of 4 on the hard tier, all of
the easy tier) and took 1.4x the time and cost. A procedure that changes nothing but the bill is
overhead.

## An approved design, if there is one

If this feature went through `/router:design`, `.router/plans/<plan_id>/DESIGN.md` exists. Read its
frontmatter:

- **`status: design_approved`** -> build against it: its scope, invariants (Must NOT), acceptance
  criteria and verification matrix are the bar. Note the `revision` you read.
- **`status: design_draft`** -> refuse, and say the Design has not been approved yet.
- **`status: design_implemented`** -> the work was already built and accepted. Say so and ask:
  new work under a new `plan_id`, or a revision bump on this one.
- **`status: design_abandoned`** -> the user already chose to skip the flow. Proceed as if there
  were no design, and say that is what you are doing.
- **No design** -> just build it. This is the normal path; whether a change deserves the design
  flow is the user's call, never router's.

If the code contradicts the **Design** mid-way -- not a detail, the approach -- stop and take it
back to `/router:design`. If the Design's `revision` moves while you are building, the bar moved:
say so before continuing.

## When the user names a model

Only then, and only for the part they named. The CLI launches codex on your current branch,
under its `workspace-write` sandbox, with a minimal environment:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" write <id> --brief <file> [--model M] [--effort E]
```

- **Write the brief first** -- `${CLAUDE_PLUGIN_ROOT}/references/codex-writer.md` says what it
  must contain. Put it under `.router/` (gitignored), e.g. `.router/writes/<id>/BRIEF.md`.
- **The tree must be clean.** The writer refuses to start over uncommitted changes; commit your
  own work first.
- **Run it in the background** (`run_in_background`) and continue when it completes. A writer run
  routinely outlasts the 10-minute foreground limit. If this session ends mid-run the writer may
  die with it; nothing is lost but its unfinished work -- start a new write.
- **Its default model** is `writer:` in `router models` (`gpt-5.6-sol` at `xhigh`). Pass the
  user's choice explicitly when they name one; never lower it on your own.
- **Read what it did** -- `git diff <base>..HEAD`, from the `base` the report prints. A writer's
  report is a claim, not evidence.
- **Feedback goes back to the same session**:
  `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" resume <id> --feedback "<everything that is wrong>"`.
  All findings in ONE resume, at most two resumes, and trivial edits you make yourself --
  `codex-writer.md` has the measurements. If the report says **RESUME DID NOT RE-ATTACH**, the
  session was not continued: treat what happened as a fresh, unreviewed run.
- **`CONTRACT_CONFLICT`** at the start of its final message means the brief contradicts the code.
  Nothing it did is accepted until you have read the evidence and taken it to the user.

## Finishing

Say what you changed and how you checked it, as you normally would. **Merging is the user's** --
never merge or push for them. An independent review is available as `/router:review` if they want
one; it is theirs to ask for, not a step of this command.
