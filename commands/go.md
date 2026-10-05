---
description: Build the change we just discussed -- you write it in this session (or codex does, when the user names it), commit by functional unit, verify in the real environment, and stop before merge
allowed-tools: Bash, Read, Edit, Write, Task, ExitPlanMode
---
The user has finished planning WITH YOU in this conversation and now wants it built. Do NOT
re-plan from scratch -- you already have the context.

**You write the code, in this session.** Router does not hand the work to another process by
default: the things that actually caught defects in this project's history -- reading the whole
diff, running the real build, an independent review -- all happen in the main session, and none
of them depended on someone else writing the code. The one exception is explicit: when the user
names a model ("let codex write this"), a part of the work goes to an external codex writer --
see "When the user names a model" below. Never choose that yourself.

## Entry: is there an approved design?

Check FIRST. If this feature went through `/router:design`, `.router/plans/<plan_id>/DESIGN.md`
exists. Read its frontmatter:

- **`status: design_approved`** -> build against it: its scope, invariants (Must NOT), acceptance
  criteria and verification matrix are the bar. Note the `revision` you read.
- **`status: design_draft`** -> refuse, and say the Design has not been approved yet.
- **`status: design_implemented`** -> the work was already built and accepted. Say so and ask:
  new work under a new `plan_id`, or a revision bump on this one.
- **`status: design_abandoned`** -> the user already chose to skip the flow. Proceed as if there
  were no design, and say that is what you are doing.
- **No design** -> proceed. This is the normal path for everyday tasks; whether a change deserves
  the design flow is the user's call, never router's.

If the code contradicts the **Design** mid-way -- not a detail, the approach -- stop and take it
back to `/router:design`. If the Design's `revision` moves while you are building, the bar moved:
say so before continuing.

## Plan-mode gate (check this second)

Building mutates, so it is BLOCKED in plan mode. In plan mode, work out the slicing in your head
and present it via **`ExitPlanMode`** -- that single approval both exits plan mode and authorizes
the work, so it **IS Touchpoint 1**; do not ask again.

## Touchpoint 1: the whole feature, once

Before writing anything, show the intended slicing of the whole feature: the functional units
you will commit, roughly in order, what each touches, and how each will be verified. If any part
goes to a codex writer, say which. Wait for the go-ahead, then build without asking again --
unless the slicing itself changes (a unit you did not show, a scope that grew past what the user
saw, a dependency that reorders the rest). That is a new confirmation, not a footnote.

It is a conversation, not a document: nothing is written to `.router/`, no status moves. For an
everyday task this is usually one or two lines.

## Build it

- **Work on a branch**, not on the default branch. Router does not create one for you.
- **Commit one functional unit at a time**, each with its own tests and a message that says why.
  That is the granularity a human can review; a single commit of thirty files is not reviewable,
  and that is a defect in itself.
- **Before you fix anything, look for the answer already in this repository.** Search for the
  *mechanism*, in one or two words -- not the symptom in a sentence -- and write what you found: a
  `file:line`, or "looked, nothing there". Measured: three times in one day the answer was
  already here and went unused (a process-group kill, a reclaim protocol, a bounded read added
  beside an unbounded sibling), and the first of those survived three review rounds and ended in
  190 orphaned processes. "Same class" means the same mechanism, not the same module.
- **Unclear work stays with the user (Touchpoint 2).** Anything that needs a real judgment the
  plan did not make, clarify it with them before writing it.

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
- **Review what it did exactly as you review your own work**: `git diff <base>..HEAD` commit by
  commit, from the `base` the report prints. A writer's report is a claim, not evidence.
- **Feedback goes back to the same session**:
  `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" resume <id> --feedback "<everything that is wrong>"`.
  All findings in ONE resume, at most two resumes, and trivial edits you make yourself --
  `codex-writer.md` has the measurements. If the report says **RESUME DID NOT RE-ATTACH**, the
  session was not continued: treat what happened as a fresh, unreviewed run.
- **`CONTRACT_CONFLICT`** at the start of its final message means the brief contradicts the code.
  Nothing it did is accepted until you have read the evidence and taken it to the user.

## Touchpoint 3 -- the stage gate (mandatory, all of it yours)

This is the **floor**, not the final word: enough to say "this stage holds together", so the user
can confirm the direction before anyone spends a strict review on it.

- **Read the complete diff** (`git diff <base>..HEAD`), every time, commit by commit. Do not read
  raw build output when a summary will do -- everything you read is re-read on every later turn.
- **Work out how to build and test this project yourself** from `package.json` / `Makefile` / CI
  config, and **cost it honestly before you promise it**. Measured on ClickHouse: adding one new
  source file re-triggered CMake's `CONFIGURE_DEPENDS` glob and invalidated 9,891 object files --
  a build the project's CI budgets four hours for. If the verification you promised cannot run
  here, say **"this was never compiled"** in exactly those words and let the user decide.
- **Confirm every changed line is covered by a test** that would fail without the change.
- **Run the full chain in the real environment** (Docker included), exactly as this project's CI
  invokes it. Read the complete output yourself and decide.
- **Never make the environment cooperate.** Do not `chmod` a file, hand-edit a config, install an
  undeclared dependency, pre-create a directory, or touch fixtures to get a test to run. If
  something fails on such a detail, **that is a defect in the diff** -- fix it in the diff and
  re-run. A gate you helped pass verifies your workaround, not the change.
- Check the diff for what no test sees: secrets in added lines, a new script without the
  executable bit its siblings have, files outside what Touchpoint 1 said would change.
- Do a **floor review** of the combined change: does it do what the user asked, is anything
  obviously wrong or out of scope, are the tests real assertions rather than hollow stubs?

## Hand the stage back

Report what changed (the commits), that the full chain is green in the real environment (or
exactly what did not run), which branch the user is on, and state plainly that this was the
**floor check, not a strict review**. **Merging is theirs** -- never merge, push, or switch
branches for them.

Recommend `/router:review` as the **next stage** -- an independent, adversarial review of the
change -- and let the user decide when to spend it: if the direction turns out to differ from
what they wanted, a strict review now is wasted work.

## Why the review is a separate stage

A green suite is weak evidence about judgment. Measured on real bugs: a fix passed the held-out
oracle test, every regression test, and this floor review -- and an independent reviewer still
found its guard condition was one notch too broad, silently disabling an optimization no test
could see. The floor catches "is it broken"; the strict review catches "is it right". Two stages,
so the user gets to confirm direction between them.

Optional first bookend for a large feature: `/router:brainstorm` (question the idea),
`/router:design` (clarify, research, draft the Design section by section), `/router:design-review`
(independent adversarial pass, every objection adjudicated by the user).
