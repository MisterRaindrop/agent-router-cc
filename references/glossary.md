# Glossary

Every term here appeared in this project's own documents without explanation, and an independent
reviewer reading a design document reported not being able to follow it. That is the test this
file is written against: **not "is the word defined somewhere", but "would a reader who has never
seen this project understand the sentence".**

Two entries are split into several, because one word was doing several jobs. That is the more
useful half of this file: an ambiguous term is worse than an undefined one, since the reader does
not know they have misunderstood.

## The two words that had to be split

### "gate" -- three different things

Never write "the gate" unqualified. Say which:

| Name to use | What it is | Where |
|---|---|---|
| **environment-free gate** | Checks needing nothing but the diff: does the patch apply onto `base_sha`, does it stay inside `allowed_globs`, does it leak a secret, does a new script carry the executable bit. Fast, deterministic, no build. | `app/verifier.ts` |
| **scope gate** | One of those: the `allowed_globs` / forbidden-globs / line-cap / don't-delete-tests check. A pure function over an already-parsed diff. | `core/scope.ts` |
| **project gate** | The project's own build-and-test command -- `npm run check`, `make test`. Answers "did it run and pass", never "is it right". Configured as `verify` on a task or `gate` / `clean_gate` in `.router/gate.yaml`. | `.router/gate.yaml`, `task.yaml` |

There is also the historical **queue gate**: verifying in the project's own checkout under an
exclusive lock, once a separate `/router:gate` command. Its mechanisms are now part of the normal
dispatch flow, so the phrase should not appear in new writing.

### "detached" -- two unrelated meanings

| Name to use | What it means |
|---|---|
| **detached process** | A child process started as leader of its own process group (`spawn(..., {detached: true})`), so it survives its parent and can be killed as a group. Used for the executor and for the lock heartbeat. |
| **detached HEAD** | A Git working tree checked out at a commit rather than a branch. Router refuses to run a task from one -- task identity requires a branch. |

Write the whole phrase both times. "Detached" alone has caused real confusion.

## The pieces

**router** -- this plugin. Two halves, and they are easy to confuse:

- a **slash command** (`/router:go`) is a Markdown instruction file in `commands/`. It is read by
  the model driving *your* session; there is no program behind it. It decides things.
- a **CLI subcommand** (`router dispatch`, `router list`) is a Node program, the single bundled
  `dist/router.js`. It does mechanical, deterministic work and owns all state under `.router/`.
  It decides nothing.

The split is the whole design: judgment in the slash command, mechanism in the CLI. When a
document says "router does X", it should say which half.

**orchestrator** -- the model in your session, the one reading the slash command. Also called
"the main session" or "the main model". It plans, reviews, and owns the pass/fail verdict.

**executor** -- the model dispatched to write the code (`claude` or `codex`, run headless). It
gets a contract and the repository, and it is not trusted with the verdict on its own work.

**work package** -- what one executor does in one session: the largest coherent chunk it can
finish from its contract alone. One `/router:go` run dispatches one package.

**functional unit** -- what one *commit* contains: one thing a human can review at a time, with
its tests. Deliberately a different size from a work package. Adding a storage access method is
file IO, then the storage format, then the storage architecture -- three functional units, one
package. Neither "the whole task in one commit" nor "a commit per edit".

**task branch** -- `router/<task-id>`, the branch a dispatch creates and develops on in your own
checkout. The run ends with you standing on it; router never merges and never switches back.

**base_sha** -- the commit the task branch was cut from. Every diff, every scope check and every
gate is computed over `base_sha..HEAD`, so it is what "what this task changed" means.

**rescue commit** -- a commit router makes of *your* uncommitted work before it moves anything,
reporting the sha. It exists so that nothing router does later can lose work you had not
committed. Undo with `git reset --soft <sha>~1`. Not a `git stash`: a stash is detached from the
branch, and a conflicting pop on a failure path leaves your changes somewhere you have to be told
about.

**closing invariant** -- the assertion before verification: we are on the task branch, `base_sha`
is an ancestor of `HEAD`, and **nothing is uncommitted**. The last part matters because a file the
executor forgot never enters `base_sha..HEAD`, so every gate would pass without ever seeing it.

**probe** -- a read-only investigation task: dispatched to answer one question, and **required to
produce no diff at all**. Used when a design has an open question too big to guess at.

**tier** -- how much *capability* a task needs: `weak`, `strong`, `critical`. Router picks the
executor by real quota within the tier. Not the same question as risk.

**risk** -- how much it costs to be wrong: `low`, `normal`, `high`. Decides how much independent
review the change earns. A mechanical change on an authentication path is `weak` tier and `high`
risk.

**effort** -- the reasoning budget passed to the executor (`medium`, `high`, `xhigh`, `max`).
Omitting it silently falls back to the provider default, which on the codex side is a real
capability downgrade -- so a pin always states it.

**floor check** -- the mandatory verification at the end of `/router:go`: green in the real
environment plus the orchestrator's own review. It answers "is this broken". `/router:review` is
the separate, stricter stage that answers "is this right".

**blast radius** -- one of a contract's seven faces: what else this change can affect if it is
wrong. Prefer the plain phrasing ("what else this can break") in new writing.

**unverified** -- a check that genuinely could not run here. A required and honest outcome, and
explicitly **not** to be dressed up as a pass, nor turned into one by inventing a hollow test.
See `assurance-core.md`.

**slug** -- a short kebab-case identifier for a plan (`2026-08-21-router-v2-commands`). It is the
directory name under `.router/plans/` and the `plan_id` on every task of that plan; one
identifier, no mapping layer.

**WIP** -- "work in progress". Prefer writing it out.

**sha / sha256** -- a **sha** (bare) is a Git commit id, the 40-hex string `git log` shows. A
**sha256** in this project is a content hash of a *document*, used to prove a dispatched contract
quotes the exact approved revision. Different things; say which.

**green** -- the build and tests passed. Common in conversation; in a document, say what passed.

## Retired words

Do not use these in new writing. They name things that no longer exist, and a reader will go
looking for them.

| Word | Was | Now |
|---|---|---|
| **worktree** (per task) | a separate checkout for each task | the executor works in your checkout on a task branch. `worktree` still legitimately names the verifier's throwaway patch-check checkout |
| **run** / `run-001` | a numbered attempt inside a task | dispatch is one attempt per task; artifacts sit directly in `.router/tasks/<id>/` |
| **dispatch** (slash command) | `/router:dispatch` | `router dispatch`, the CLI subcommand, driven by `/router:go` |
| **land** (slash command) | `/router:land` | `router land`, the CLI subcommand |
| **spec** | the single document that preceded design + plan | `/router:design` then `/router:workplan` |
| **plan** (the document) | `PLAN.md` | `WORKPLAN.md`; `/router:plan` is a stub pointing at `/router:workplan` |
