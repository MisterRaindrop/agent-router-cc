# Glossary

Every term here appeared in this project's own documents without explanation, and an independent
reviewer reading a design document reported not being able to follow it. That is the test this
file is written against: **not "is the word defined somewhere", but "would a reader who has never
seen this project understand the sentence".**

## The word that had to be split

### "detached" -- two unrelated meanings

| Name to use | What it means |
|---|---|
| **detached process** | A child process started as leader of its own process group (`spawn(..., {detached: true})`), so it survives its parent and can be killed as a group. Used for heartbeat children. |
| **detached HEAD** | A Git working tree checked out at a commit rather than a branch. `router write` refuses to start from one -- the writer needs a branch to commit on. |

Write the whole phrase both times. "Detached" alone has caused real confusion.

## The pieces

**router** -- this plugin. Two halves, and they are easy to confuse:

- a **slash command** (`/router:go`) is a Markdown instruction file in `commands/`. It is read by
  the model driving *your* session; there is no program behind it. It decides things.
- a **CLI subcommand** (`router write`, `router plans`) is a Node program, the single bundled
  `dist/router.js`. It does mechanical work: launching codex, listing plans, the symbol index. It
  decides nothing.

The split is the whole design: judgment in the slash command, mechanism in the CLI. When a
document says "router does X", it should say which half.

**main session** -- the model in your session, the one reading the slash command. It writes the
code, reviews it, and owns the pass/fail verdict. (Older documents call it "the orchestrator".)

**codex writer** -- codex, launched by `router write` to write part of the work when the user
names it. It gets a brief and the repository, commits on your branch, and is not trusted with the
verdict on its own work.

**brief** -- what a codex writer is given: six faces (goal, invariants, frozen interfaces,
definition of done, blast radius, stop conditions) plus the approved `DESIGN.md` verbatim. See
`codex-writer.md`.

**functional unit** -- what one *commit* contains: one thing a human can review at a time, with
its tests. Adding a storage access method is file IO, then the storage format, then the storage
architecture -- three functional units. Neither "the whole task in one commit" nor "a commit per
edit".

**base** / **base_sha** -- the commit a piece of work started from. Its diff is `base..HEAD`, so it
is what "what this changed" means. `router write` records it and prints it.

**write id** -- the name of one codex writer run, `.router/writes/<id>/`: its brief, its log and
its record. `router resume <id>` continues that run's codex session.

**probe** -- a read-only investigation: answering one question and producing no diff at all. Used
when a design has an open question too big to guess at.

**risk** -- how much it costs to be wrong: `low`, `normal`, `high`. Decides how much independent
review the change earns. See `assurance-core.md`.

**effort** -- the reasoning budget passed to codex (`medium`, `high`, `xhigh`, `max`). Omitting it
silently falls back to the provider default, which is a real capability downgrade -- so a pin
always states it.

**blast radius** -- one of a brief's six faces: what else this change can affect if it is wrong.
Prefer the plain phrasing ("what else this can break") in new writing.

**unverified** -- a check that genuinely could not run here. A required and honest outcome, and
explicitly **not** to be dressed up as a pass, nor turned into one by inventing a hollow test.

**slug** -- a short kebab-case identifier for a plan (`2026-08-21-router-v2-commands`). It is the
directory name under `.router/plans/` and the `plan_id`; one identifier, no mapping layer.

**sha / sha256** -- a **sha** (bare) is a Git commit id, the 40-hex string `git log` shows. A
**sha256** is a content hash of a document. Different things; say which.

**green** -- the build and tests passed. Common in conversation; in a document, say what passed.

## Retired words

Do not use these in new writing. They name things that no longer exist, and a reader will go
looking for them.

| Word | Was | Now |
|---|---|---|
| **executor** / **dispatch** | a model dispatched to write each work package, under a lock, on its own task branch | the main session writes; `router write` launches codex only when the user names it. Removed in 0.15.0 |
| **work package** / **task** / **`task.yaml`** / **contract** | the unit one executor did, and the files that described it | a functional unit (a commit); for codex, a brief |
| **tier** (`weak` / `strong` / `critical`) | how much capability a package needed, used to pick a model | gone with quota routing. `router models` has one `writer:` default |
| **quota balancing** | picking codex or claude per dispatch by remaining plan quota | removed in 0.15.0 |
| **environment-free gate** / **scope gate** / **queue gate** | mechanical checks on an executor's diff, and a verification queue in the user's checkout | removed in 0.15.0. The main session reads the diff and runs the project's own build |
| **task branch** / **rescue commit** / **closing invariant** | `router/<id>`, the commit of the user's uncommitted work, the "nothing uncommitted" assertion | the writer commits on your branch and refuses to start over uncommitted work |
| **land** | merging a task branch | merging is the user's, with git |
| **worktree** (per task) | a separate checkout for each task | nothing. Work happens in your checkout |
| **spec** | the single document that preceded design + plan | `/router:design` |
| **work plan** (the document) | `PLAN.md`, then `WORKPLAN.md` | nothing. `DESIGN.md` is the only document a plan has; slicing is left to whoever builds it |
| **floor check** / **Touchpoint 1/2/3** | `/router:go`'s mandatory slicing confirmation and its closing verification checklist | removed in 0.16.0. `/router:go` builds the way the main session would without router; `/router:review` is opt-in |
| **plan** (slash command) | `/router:plan`, then a stub pointing at `/router:workplan` | removed |
