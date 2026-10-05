# The workflow

router is a discipline for writing code with Claude Code: think before you write, write in units a
human can review, verify in the real environment, and have a different model attack the result.
The main session does all of it. This page is that protocol end to end; `docs/quickstart.md` is
the five-minute version, and `commands/*.md` are the instructions the model actually follows.

## The shape of a run

```
everyday task:   talk it through with the main session  ->  /router:go  ->  /router:review (optional)
                                                             you write,      independent, strict
                                                             commit,         review by another
                                                             verify          model

large feature (opt-in -- the user's call, never router's):
  /router:brainstorm  ->  /router:design  ->  /router:design-review (opt.)  ->  /router:go
  question the idea;      clarify + code      independent adversarial           build against
  compare with how        research; one       pass; every objection             the approved
  others solve it;        DESIGN.md,          adjudicated by the user,          DESIGN.md
  argue against           approved section    none auto-applied
                          by section
```

`/router:go` pauses at exactly three points: confirm the slicing (once, for the whole feature),
handle whatever needs real judgment, and hand back before anything merges. Nothing merges without
you, and router never merges at all.

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

## 3. Functional units

The work is committed **one functional unit at a time**: one thing a human can review, with its
tests. A single thirty-file commit is not reviewable, and that is a defect in itself. Touchpoint 1
is where the units are agreed -- what each touches and how each will be verified -- once, in
conversation, before anything is written.

## 4. Verification is the main session's, and it is the real build

There is no mechanical gate standing in for judgment. The main session works out how this project
builds and tests (from its own `package.json`, `Makefile`, CI config), costs that honestly, runs
the full chain exactly as CI does, and reads the whole output. Two rules carry most of the weight:

- **Never make the environment cooperate.** No `chmod`, no hand-edited config, no undeclared
  dependency, no pre-created directory to get a test to run. A failure on such a detail is a
  defect in the diff. A check you helped pass verifies your workaround, not the change.
- **Say "this was never compiled" when it was not.** A build the project budgets four hours for
  does not get to be implied by a clean review.

## 5. How much review each change earns

Every change gets the main session reading the **complete diff**. What scales with risk is the
independent pass:

| risk | main session | independent review (`/router:review`) |
|---|---|---|
| Low | reads the full diff, runs the real build | optional |
| Normal | reads the full diff, runs the real build | one independent pass |
| High | reads the full diff, runs the real build, verifies the invariants by hand | independent pass, multiple lenses |

**Never merge on green alone.** Measured: the main session's own floor review found three real
defects in a diff that was green -- a reported figure that did not match what ran, a `--json` path
emitting several concatenated documents, and a test fake reading an environment variable that was
never passed, so it silently proved nothing.

**Read the diff, not the logs.** Everything read enters the session's context and is re-read on
every later turn, so raw build output is the largest avoidable cost; the diff is the one thing
worth paying for.

## 6. Read the implemented design when the diff is no longer the useful view

`/router:explain <commit>` reads one completed feature and writes a self-contained
`.router/explanations/<feature>-<head>.html` page: the verdict first, then one complete architecture
diagram showing where the feature sits, who owns its state, and which path makes it work. It is a
human review aid, not a gate.

## 7. Read-only probes

When an assumption would invalidate the approach if it turned out false -- platform behaviour, a
migration's real shape, what a dependency actually does -- answer it first with a probe: an
investigation that changes nothing. Its conclusion enters the Design as text.

## 8. What lands on disk

```
.router/                        # fully gitignored; router never commits it
  models.yaml                   # optional: `writer:` and `review:` overrides; `router models` shows the result
  plans/<plan_id>/              # BRAINSTORM.md, DESIGN.md, critique-<round>.md, DECISIONS.md, spec.lock
  writes/<id>/                  # one codex writer run: BRIEF.md, codex.log, record.json
  explanations/                 # /router:explain pages
  symbols/                      # the symbol index cache
```

Nothing under `.router/` is ever an input to merging. The code and its history live in git.
