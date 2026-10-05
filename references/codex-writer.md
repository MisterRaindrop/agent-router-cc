# Briefing a codex writer

How to hand part of the work to codex when the user names it. `commands/go.md` owns the flow;
this owns the brief and the session rules. Everything here was measured on this repository while
codex was the executor for every dispatch, and survived the removal of the dispatch machinery
because it is about the writer, not the machinery.

## Size: as few runs as the work allows

Every run is a cold start: codex re-reads the repository before it writes a line. Measured on a
real plan, five runs re-explored the same repository five times -- 1.88M input tokens for a
roughly 400-line feature -- and a run's floor is 1.5-2M input tokens however small the change.
So split only where you must: a genuine dependency, an unrelated area, or work too large for one
session.

**A run is not the same size as a commit.** Inside one run the writer commits one functional unit
at a time, each with its own tests, because a human reviews one thing at a time. Two rulers, two
jobs: the run is sized to avoid cold starts, the commit is sized to be reviewable.

## The brief

`router write` sends the brief verbatim, followed by a short delivery footer (commit per unit,
write and run the tests, stay on the branch, report `CONTRACT_CONFLICT`, end with a report). The
writer is a strong model; precision beats prose. Write each of these in one to three lines:

| Face | What to write |
|---|---|
| **Goal** | what to accomplish, at the level of behaviour |
| **Invariants** | what must NOT change -- copy them from the Design's Must NOT when there is one |
| **Frozen interfaces** | signatures, formats and files it must build on rather than redesign |
| **Definition of done** | the bar, including the tests it must add and the command that runs them |
| **Blast radius** | the files it may touch, and the worst case if it is wrong |
| **Stop conditions** | when to stop and report instead of improvising |

**If you cannot write all six, it is not ready to hand over -- it is still a decision.** Keep it
and settle it with the user.

**When there is an approved `DESIGN.md`, append it verbatim** below the six faces. It says why
the thing is built this way and which invariants may not break -- the part a writer can never
recover by reading code. Do NOT include `BRAINSTORM.md`: it records rejected directions, and
handing it over hands the writer a pile of ideas that were decided against.

## What the writer may and may not do

- **Commits its own work**, one functional unit at a time. An intermediate commit that does not
  build yet is fine; nothing may be left uncommitted at the end -- the report lists anything that
  was, and uncommitted work is unfinished work, not a pass.
- **May not** merge, rebase, push or rewrite history. It works on the branch you are on.
- **May not touch `.router/`** -- a nested `router` that writes refuses (`ROUTER_EXECUTOR_SANDBOX`).
- **May not provision the environment** to make a check run: no installing dependencies, no
  creating directories, no editing configuration. An honest "did not run" is useful; a claimed
  pass that never ran is not.
- **May not change the brief.** If the code contradicts it, the writer stops and begins its final
  message with `CONTRACT_CONFLICT` and the evidence. A conflict means the brief is wrong, not the
  code: read the evidence and take it to the user before anything else happens.

## Resume: one complete round, at most two

`router resume <id> --feedback "..."` continues the same codex session, on the same branch, from
the same base. It saves exploration, **not tokens -- its input grows every round**. Measured on one
task, three attempts of the same session: **7.69M -> 9.18M -> 9.35M** input tokens; the third
changed eight lines and still cost more input than the original 1181-line implementation, because
the whole session is re-sent every turn. So:

- **Send every finding in one resume.** Three findings in three resumes pay the whole accumulated
  prefix three times.
- **Make trivial edits yourself.** A two-comment fix through a resume cost about what the whole
  implementation cost. Resume is for work that needs the writer's context, not for typing.
- **Cap it at two resumes**, then take the work over yourself or bring it to the user.
- **A different piece of work is a new write**, never a resume: the session's memory and the files
  on disk drift apart, and a stale session cheerfully revives plans it already discarded. Warm
  repository knowledge travels as artifacts instead -- the symbol index (`/router:symbol`).
