# Work packages (shared by /router:go)

How a plan becomes dispatchable units, what the executor owes back, and how much review each
unit earns. Risk vocabulary is `Low | Normal | High` from
`references/assurance-core.md` -- the same tiers, including its rule: **when unsure, escalate;
never downgrade a tier to justify running fewer checks.**

## What a work package is

The largest coherent chunk **one executor can finish in one session** from its contract alone,
carrying a test story of its own. Not "the smallest task". A package owns its whole loop: read
the code, decide internal steps, implement, write tests, run the gate, fix to green, self-check
scope, report.

Measured reason to prefer few large packages over many small ones: five micro-tasks cost five
executor cold starts (1.88M executor input tokens re-reading the same repository) plus five
orchestrator review round trips, and the orchestrator's turns dominate wall clock -- 12.8 minutes
of executor time against about three hours and ~317 orchestrator turns for the same plan.

## The dispatchability test -- seven faces

A package is dispatchable only if all seven can be written down. **If they cannot, it is still a
decision, not a task: keep it and do it with the user.**

| Face | Why it exists |
|---|---|
| **Goal** | what to accomplish |
| **Invariants** | what must NOT change; the reviewer judges drift against these |
| **Frozen interfaces / dependencies** | packages may relate ONLY through already-frozen interfaces and declared dependencies |
| **Definition of Done** | the completion bar, including "carries its own tests" |
| **Blast radius** | worst case if it is wrong -> sets the risk tier |
| **Stop conditions** | when to stop and hand back instead of improvising |
| **Version binding** | `plan_id` + the `base_sha` router records, so evidence binds to exact code |

## Risk -> how much review it earns

Every tier gets the mechanical gates *and* the orchestrator reading the **complete diff**. What
scales is the independent pass, not the orchestrator's own reading.

| Risk | Mechanical gates | Independent contract review | Orchestrator |
|---|---|---|---|
| Low | required green | skip | reads the full diff + delivery report |
| Normal | required green | one independent pass | reads the full diff, judges its findings |
| High | required green | independent pass, multiple lenses | reads the full diff, plus verifies the invariants by hand |

**Never merge on green alone.** A green suite is the precondition, not the evidence. Measured:
the orchestrator's own floor review found three real defects in a diff that was green *and*
mechanically verified -- a reported concurrency figure that did not match the pool that ran, a
batch `--json` path emitting several concatenated documents, and a test fake reading an
environment variable the executor allowlist never passes through, so it silently proved nothing.

**Read the diff, not the logs.** The diff is judgment input -- read it whole. Raw build/test
output is evidence input: take the summary from the delivery report and the verifier's per-check
result. Everything read enters the orchestrator's prefix and is re-read on every later turn, so
raw logs are the largest avoidable cost; the diff is the one thing worth paying for.

## Gate modes -- decide once per project

Where the real build/tests can run is a property of the project, not of the task. Declare it,
do not guess.

- **`worktree`** -- the gate runs inside the run worktree. Valid when dependencies resolve from
  an ancestor or a global cache and the tests need no exclusive shared resource. Check it
  **empirically once**: a run worktree lives under the repo, so ancestor resolution often just
  works (verified here: the full gate runs in a worktree, 174 tests in 4.7s). Implementation and
  verification are both fully parallel.
- **`queue`** -- the real environment exists once (a single build directory, a long-running
  Docker container bound to a fixed host path, a live service). Executors write code and tests
  in parallel worktrees and **do not build**; router feeds their commits one at a time into the
  **main checkout**, which is where Docker is mounted and where the caches are warm.

Why the main checkout and not a dedicated verification worktree: the container mounts a **fixed
host path**, and the build directory, ccache, `CMakeCache.txt`, ninja depfiles and
`compile_commands.json` are all keyed to that path. A worktree is a different source path, so
its caches and absolute paths are worthless even when the path is inside the mount.

Borrowing the user's checkout demands hard rules:

1. **Refuse if TRACKED content is modified** -> do not run. Never stash, discard, or tidy up.
   Untracked files and submodule build residue do not count: a checkout or reset would
   overwrite tracked content, while those survive untouched. Measured on a real ClickHouse
   checkout, plain `git status --porcelain` showed 110 entries -- 107 build residue inside
   `contrib/*` submodules, 2 untracked scratch files, and exactly **one** real uncommitted
   edit. Refusing on all 110 would lock the queue out of the projects it exists for.
2. **Exclusive lock, and restore the original ref** when done. Lock liveness reuses the existing
   heartbeat mechanism, so a zombie holder can be declared dead.
3. **On failure, reset tracked files only** (`git reset --hard <integration head>`). **Never clean
   build artifacts** -- they are the cache the whole scheme exists to preserve.
4. Only the verification step borrows the checkout; executor worktrees stay parallel.
5. It must be **explicitly enabled**, because it touches the user's working directory.

Queue semantics: **verify on the integration head, not on the task's own older base.** Once one
task merges, every later task's base is stale, so "verified" would be a claim about code nobody
will ship. Apply conflict -> back to its executor. Three gate depths: **Task** (affected modules,
incremental) -> **Wave** (a batch together) -> **Milestone** (full clean build + full suite + CI).
A diff that touches build files, a code generator, or **deletes** a file escalates to a clean
build automatically -- incremental builds silently miss exactly those.

Throughput is one gate at a time: with a gate of T minutes the ceiling is 1/T **regardless of how
many executors run**. Two or three executors saturate it; more just lengthens the queue.

Reset **business** state before each gate run (not after -- a crashed run leaves debris), while
keeping compile caches. A failed reset is a FAILED gate: never run a gate on a dirty environment.

## What the executor owes back

Both protocols ride on the executor's **final message**, so nothing is ever written into the
worktree (which would enter the diff and trip the scope gate).

**Delivery report** -- prose a human can read, then a `router-delivery` fenced block with `task`,
`plan_revision`, `gate_ran`, `scope_drift`, `escalate_review`. Router stores it at
`.router/tasks/<id>/runs/<run>/DELIVERY.md`. Read it before the diff. A header that is missing or
does not parse is surfaced as `delivery_header: missing` -- treat it as a contract violation worth
a closer look, never as "probably fine". `gate_ran: false` means the diff is unproven, whatever
the prose claims.

**`CONTRACT_CONFLICT`** -- the executor may never quietly change the plan. When the code
contradicts the contract, its final message begins with that literal line and states: the
original assumption, the evidence found, the conflicting plan item or invariant, the other work
affected, the options, and whether experimental code is left behind. Nothing lands. Three depths:

- **Local** -- fix this package's contract only.
- **Interface** -- re-plan this package and its declared dependents.
- **Global semantic** -- stop the milestone; the plan is re-frozen with the user.

Only the affected subgraph is invalidated; a conflict is not a reason to redo the whole plan.

Declaring a `verify` command is also a permission decision, so make it deliberately: it is what
grants the Claude executor `Bash`. Two real runs measured what that grant is. `acceptEdits`
auto-approves **read-only** commands by itself -- which is why a run executed `git diff`
unprompted -- while anything that *does* something must match the allow list exactly. So the
grant is the gate command plus its program+subcommand prefix (`Bash(npm run:*)`), and it is
re-issued on `resume`: granting less than that does not make the run safer, it makes the
executor stall waiting for approval it can never get -- measured, that is exactly how one run
shipped no tests and no delivery header. Reading is bounded by the worktree and the stripped
environment rather than by the list; codex's `workspace-write` sandbox is the tighter of the
two, and a task with no `verify` gets no `Bash` at all.

An executor that cannot run the gate (queue mode, or a missing toolchain) must say so with
`gate_ran: false` and a reason. It must **not** provision the environment to make a check run --
no installing dependencies, no creating directories, no editing configuration. An honest "did not
run" is useful; a claimed pass that never ran is corrosive.

## Session policy

- **Same task, fixing what the gate reported -> `resume`.** Same worktree, same base, same scope;
  the executor keeps what it learned instead of re-exploring the repository. Cap it at two
  attempts, then take it over or bring it to the user.
- **`resume` saves exploration, NOT tokens — its input grows every round.** Measured on one real
  task, three attempts of the same session: **7.69M -> 9.18M -> 9.35M input tokens**. The third
  attempt changed **eight lines in 59 seconds** and still cost *more input than writing the
  original 1181-line implementation from scratch*, because an executor's whole session is re-sent
  each turn. Two rules follow, and they matter more than the wall clock:
  - **Send complete feedback in one resume.** Splitting three findings across three resumes pays
    the whole accumulated prefix three times.
  - **Do trivial mechanical edits yourself.** A two-comment fix through a resume cost roughly what
    the entire implementation cost; the orchestrator's own edit would have been a few thousand
    tokens. Resume is for work that needs the executor's context, not for typing.
- **A different task -> a fresh session.** `resume` continues on the same task branch from the
  same `base_sha`; the next task starts from a new base, so a reused session's memory and the
  files on disk drift apart silently. Worse, the scope gate diffs against `base_sha`, so a second
  task resumed into the first one's session would carry the first one's changes -- "one task, one
  auditable diff" is gone. And a stale session cheerfully revives plans it already discarded.
- **Wanting to reuse a session across tasks is a symptom of splitting too finely.** If the next
  task is the same area, the same base, and has no dependency, it should have been part of the
  same package. Merge them instead.
- A `TASK_CONTEXT.md` navigation summary is **not written**. Measured on a small two-file task
  it cost **21% more executor input** (474.7k vs 392.6k) for identical quality, because an
  executor's input is re-sent every turn: the summary is paid every turn while its benefit is
  one-off. Whether it pays on a repository where finding the entry points genuinely dominates is
  still open, and `task_context_present` / `task_context_chars` are still recorded on every
  dispatch so the answer can come from data -- but the default is off until it does. The loader
  still reads a file that is present, which is what keeps an existing task working; nothing
  writes one. **This is the single answer to a question this repository used to answer three
  different ways** (`go.md` said no, `go.md` also said yes, and this file said by default).
- Warm context is carried by **artifacts, not sessions**: the symbol index (`/router:symbol`) gives
  a fresh session the same repository knowledge without inheriting stale beliefs, and a probe's
  findings enter the next contract as text.
