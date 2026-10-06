# The workflow

router adds opt-in stages around writing code with Claude Code: think before you write, and have a
different model attack the result. Writing the code itself is left alone -- the main session does
it exactly as it would without router. This page is that protocol end to end; `docs/quickstart.md` is
the five-minute version, and `commands/*.md` are the instructions the model actually follows.

## The shape of a run

```
everyday task:   talk it through with the main session  ->  /router:go  ->  /router:review (optional)
                                                             the main        independent, strict
                                                             session         review by another
                                                             writes it       model

large feature (opt-in -- the user's call, never router's):
  /router:brainstorm  ->  /router:design  ->  /router:design-review (opt.)  ->  /router:go
  question the idea;      clarify + code      independent adversarial           build against
  compare with how        research; one       pass; every objection             the approved
  others solve it;        DESIGN.md,          adjudicated by the user,          DESIGN.md
  argue against           approved section    none auto-applied
                          by section
```

`/router:go` adds no steps of its own -- no confirmation round, no mandated commit shape, no closing
checklist. It reads an approved `DESIGN.md` when there is one and hands a part to codex when you name
it. Nothing merges without you, and router never merges at all.

## 1. Who writes the code

**The main session, by default.** Until 0.15.0 router dispatched every package to a separate
executor -- codex or claude, picked by remaining plan quota -- under a lock, on a branch of its own,
with mechanical gates on its diff. That was removed, and the reason is in this project's own
records: every defect that was actually caught was caught by the main session reading the whole
diff, the main session running the real build, or an independent reviewer. None of those depended
on a different process writing the code, while the dispatch machinery was the largest and most
bug-prone part of the repository.

**codex, when you name it.** "Let codex write this part" is still useful, so `router write` keeps
exactly that: it launches codex on your current branch, under its `workspace-write` sandbox, with a
brief the main session wrote. The main session then reviews those commits exactly as it reviews its
own. `router resume` sends feedback back to the same codex session. See
`references/codex-writer.md` for what a brief contains and why resumes are capped.

## 2. One plan, one `plan_id`

A design-flow feature lives in `.router/plans/<plan_id>/`: `BRAINSTORM.md`, `DESIGN.md`, each design
review round's critique, and `DECISIONS.md`. `plan_id` is a short slug (an issue number, the branch
name, or a dated description). `router plans` lists every plan and the stage its documents declare.

`DESIGN.md` is the only plan document. Its last section, the **verification matrix**, maps every
acceptance criterion to where it will actually be proven -- or to `unverified`, kept visible. There
used to be a separate work plan; it was removed in 0.14.0 (see `DEPRECATIONS.md`).

## 3. Building has no ceremony

Until 0.16.0 `/router:go` made the main session confirm the slicing up front, commit one functional
unit at a time, search the repository for an existing answer before fixing anything, and run a
closing "floor check" (whole diff, full CI chain, a test for every changed line, no touching the
environment). It was measured and removed. On real ClickHouse bugs -- each fix reverted, the
upstream issue text as the prompt, the upstream test held out as the oracle -- that flow fixed
exactly as many bugs as plain Claude Code (3 of 4 on the hard tier, every one on the easy tier),
and cost about 1.4x the time and money -- a small sample (two runs per cell), but no sign of a
difference in what got fixed. The added review stage (`/router:review`) fixed no more
either, at 2-3x the time and over 3x the cost.

So how the work is sliced, committed and verified is the main session's ordinary judgment, the
same as without router. What router keeps is what it adds on top: the design flow before, an
independent review after, and codex as a writer when you ask for it.

## 4. How much review each change earns

`/router:review` is always the user's to ask for. As a guide to when it is worth its cost:

| risk | independent review (`/router:review`) |
|---|---|
| Low | rarely worth it |
| Normal | one independent pass, if you want a second opinion |
| High | independent pass, multiple lenses |

What it adds is judgment, not a higher fix rate: in the measurement above it caught real problems
(a regression test that could never reach the failing check; a guard broader than needed), but it
never turned an unfixed bug into a fixed one.

**Read the diff, not the logs.** Everything read enters the session's context and is re-read on
every later turn, so raw build output is the largest avoidable cost; the diff is the one thing
worth paying for.

## 5. Read the implemented design when the diff is no longer the useful view

`/router:explain <commit>` reads one completed feature and writes a self-contained
`.router/explanations/<feature>-<head>.html` page: the verdict first, then one complete architecture
diagram showing where the feature sits, who owns its state, and which path makes it work. It is a
human review aid, not a gate.

## 6. Read-only probes

When an assumption would invalidate the approach if it turned out false -- platform behaviour, a
migration's real shape, what a dependency actually does -- answer it first with a probe: an
investigation that changes nothing. Its conclusion enters the Design as text.

## 7. What lands on disk

```
.router/                        # fully gitignored; router never commits it
  models.yaml                   # optional: `writer:` and `review:` overrides; `router models` shows the result
  plans/<plan_id>/              # BRAINSTORM.md, DESIGN.md, critique-<round>.md, DECISIONS.md, spec.lock
  writes/<id>/                  # one codex writer run: BRIEF.md, codex.log, record.json
  explanations/                 # /router:explain pages
  symbols/                      # the symbol index cache
```

Nothing under `.router/` is ever an input to merging. The code and its history live in git.
