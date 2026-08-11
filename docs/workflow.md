# The workflow

`/router:go` reads as one command, but it drives a whole protocol: how a plan becomes
dispatchable packages, what the executor owes back, which gate proves what, and how much
review each change earns. This page is that protocol end to end. `docs/quickstart.md` is the
five-minute version; `references/work-package.md` is the copy the orchestrator itself reads.

**The one rule everything else follows from:** the CLI owns only mechanism -- worktree
isolation, supervision, concurrency, locks, and gates that need no environment -- and every
judgment stays with you and the main session. A cheap model can clear a shallow gate while
being lazy or wrong, so "is this right" is never delegated, and never compressed.

## The shape of a run

```
everyday task:   plan with Opus in conversation  ->  /router:go  ->  /router:review (optional)
                                                     packages, dispatch,    independent, strict
                                                     gate, review, land     review of landed code

large feature (opt-in -- the user's call, never router's):
  /router:design  ->  /router:design-review (opt.)  ->  /router:plan  ->  /router:go  ->  /router:review (opt.)
  clarify + code      independent adversarial pass;     the how: task     executes the
  research; DESIGN.md  every objection adjudicated      breakdown, deps,  approved plan
  approved section     by the user, none auto-applied   verification;     verbatim
  by section                                            approved as summary
```

`/router:go` pauses at exactly three points: confirm the package list, handle whatever needs
real judgment, and approve before anything merges. Nothing lands without you. (When `go`
executes a Plan approved via the design flow, the package-list pause is skipped -- that list
was approved at `/router:plan`; the other two pauses remain.)

## 1. One plan, one `plan_id`

Every package of a plan carries the same `plan_id`, and everything written about that plan
lives under `.router/plans/<plan_id>/`. Pick something that still means something next
month: the issue or PR number (`issue-90731`), else the branch name with `/` replaced by `-`,
else a dated description. It doubles as a directory name, so the schema rejects a raw
`feat/x` rather than quietly creating a nested directory.

Namespacing is correctness, not tidiness. Two plans running in one repository would otherwise
overwrite each other's plan file -- and once a reviewer is pointed at a plan on disk, that
stops being a lost file and becomes a **silent review of the wrong plan**. `router plans`
lists what is there: revision, critique rounds, decisions, and whether a session holds the
lock.

## 2. Work packages, not micro-tasks

A **work package** is the largest coherent chunk one executor can finish in one session from
its contract alone, carrying a test story of its own. A plan usually becomes one to three of
them -- not one per file.

It is dispatchable only if all **seven faces** can be written down: goal, invariants, frozen
interfaces and dependencies, definition of done (including its own tests), blast radius, stop
conditions, version binding. **If they cannot be written down it is still a decision, not a
task** -- it stays with you and the user.

Why few and large, measured on a real plan: five micro-tasks meant five executor cold starts
that re-read the same repository (1.88M executor input tokens for a ~400-line feature) plus
five review round trips. The executors were never the bottleneck -- 12.8 minutes of executor
time against about three hours and ~317 orchestrator turns. **Wall clock and cost are
dominated by the orchestrator's turns**, so anything that adds a turn is expensive and
anything a mechanical gate can decide should never cost one.

## 3. Tier and risk are different questions

Both live in `.router/tasks/<id>/task.yaml`, and confusing them is the classic mistake.

| | question | effect |
|---|---|---|
| `tier: weak \| strong \| critical` | how much **capability** does this need? | picks the model and reasoning effort |
| `risk: low \| normal \| high` | how bad if it is **wrong**? | picks how much independent review it earns |

A mechanical change to an authentication path is `weak` **and** `high`. Router picks the
executor by real remaining quota *within* the tier -- quota never demotes a task to a weaker
model. `router models` prints the resolved table.

Risk moves **one way**. You declare it; the CLI raises it from deterministic signals (a large
changed-line count, a diff touching a path the contract declared invariant, a change spread
across several top-level directories) and never lowers it. When the declaration and the
signals disagree, the higher one wins, and the run records `risk_raised_by` so the escalation
is visible rather than mysterious.

## 4. Dispatch runs independent packages concurrently

```
router dispatch <id> <id> ... [--max-parallel <n>] --json
```

Two packages may run at once exactly when neither needs the other's output and their
`allowed_globs` are disjoint; anything else declares `depends_on` and waits. That judgment is
yours -- but `land` is fail-close, so a wrong call aborts the merge and restores the tree
rather than producing a mess.

Pass every independent package in **one** call: the wall clock becomes the slowest package
instead of the sum, and it costs one orchestrator turn instead of one per package. Measured:
26s + 31s ran as a 32s batch; 234s + 244s ran as 244s. Never fan out background shells you
then poll -- each poll is a full turn, the expensive thing here.

## 5. What the executor owes back

The executor owns its whole loop: read the code, decide its internal steps, implement, write
tests, run the gate, fix to green, self-check its scope, and report. Both protocols below
ride on its **final message**, so nothing is written into the worktree where it would enter
the diff and trip the scope gate.

**The delivery report.** Prose a human can read, then a `router-delivery` fenced block:

```router-delivery
task: q2
plan_revision: 1
gate_ran: true
scope_drift: false
escalate_review: false
```

Router stores it at `.router/tasks/<id>/runs/<run>/DELIVERY.md` and surfaces the parsed header
in `dispatch`/`result` output. Read it *before* the diff. `gate_ran: false` means the change is
unproven whatever the prose claims; `scope_drift: true` and `escalate_review: true` are the
executor telling you to look harder. A header that is missing or does not parse is reported as
`delivery_header: missing` and treated as a contract violation -- never as "probably fine".

**`CONTRACT_CONFLICT`.** The executor may never quietly change the plan. When the code
contradicts the contract its final message begins with that literal marker and states the
original assumption, the evidence found, the conflicting plan item or invariant, the other work
affected, the options, and whether experimental code was left behind. Nothing is committed,
`land` refuses, and it does not count as a failed attempt -- the contract was wrong, not the
executor. Decide the depth: this package's contract only, this package plus its declared
dependents, or the whole milestone. Only the affected subgraph is invalidated.

**No environment provisioning, ever.** An executor that cannot run the gate says
`gate_ran: false` with a reason. It must not install a dependency, create a directory, or edit
configuration to make a check run. An honest "did not run" is useful; a claimed pass that never
ran is corrosive.

## 6. Two kinds of gate

**Environment-free gates (always, by the CLI).** Every dispatched diff must clear these, in
order -- the deterministic guarantees a cheap model cannot fake:

| check | meaning |
|---|---|
| `diff_applies` | applies cleanly onto the base commit |
| `scope` | only `allowed_globs` changed, under the line cap, no test deletion |
| `secret_scan` | no keys or secrets in the added lines |
| `exec_bit` | a script added where its same-extension siblings are executable carries the bit |
| `verify` | the task's own `verify` command(s) exited 0 (skipped when `verify: []`) |

**The real gate** is a property of the project, not of the task, so decide it once and check
it empirically once. `.router/gate.yaml` declares which mode applies:

- **`mode: worktree`** -- the build and tests run inside the run worktree. Valid when
  dependencies resolve from an ancestor directory or a global cache and nothing needs an
  exclusive shared resource. A run worktree lives under the repository, so ancestor resolution
  often just works (verified here: the full gate runs in a worktree, 174 tests in 4.7s). Put
  that command in every package's `verify:` and the diff arrives already proven to compile and
  pass. Implementation and verification are both fully parallel.
- **`mode: queue`** -- the real environment exists **once**: a single build directory, a
  long-running Docker container bound to a fixed host path, a live service. Executors write code
  and tests in parallel worktrees and **do not build**; `router gate <id...>` feeds their commits
  one at a time into the project's own checkout, where the caches are warm.

Why the main checkout and not a dedicated verification worktree: the container mounts a **fixed
host path**, and the build directory, ccache, `CMakeCache.txt`, ninja depfiles and
`compile_commands.json` are all keyed to that path. A worktree is a different source path, so
its caches and absolute paths are worthless even when the path sits inside the mount.

Borrowing your checkout is only safe under hard rules, all of which the queue enforces:

1. **Refuse if tracked content is modified.** Never stash, discard, or tidy up. Untracked files
   and submodule build residue do not count -- a checkout or reset would overwrite tracked
   content while those survive untouched. Measured on a real ClickHouse checkout, plain
   `git status --porcelain` showed 110 entries: 107 build residue inside `contrib/*`, 2 untracked
   scratch files, and exactly **one** real uncommitted edit. Refusing on all 110 would lock the
   queue out of the projects it exists for.
2. **Exclusive lock, and restore the original ref** afterwards -- always, pass or fail.
   `router gate --status` shows the mode and who holds the checkout; a zombie holder is declared
   dead by heartbeat rather than blocking forever.
3. **Verify on the current integration head, not on the task's own older base.** Once one task
   merges, every later task's base is stale, and "verified" would be a claim about code nobody
   will ship. An apply conflict sends the package back to its executor; the integration branch is
   never polluted.
4. **On failure, reset tracked files only** (`git reset --hard <integration head>`). **Never
   clean build artifacts** -- they are the cache the whole scheme exists to preserve. (On the
   ClickHouse checkout that cache is 43GB of hot state.)
5. **A failing gate is re-run on the pre-merge head as a baseline.** If it fails there too, the
   verdict is `gate_failed_pre_existing`: the project was already red, and the package is not
   blamed for it. This is not hypothetical -- a real run tripped on the project's own style check
   failing over symlinks that had nothing to do with the change.
6. **A diff that touches build files or a code generator, or deletes a file, escalates to a
   clean build automatically.** Incremental builds silently miss exactly those.

Reset **business** state before each run (not after -- a crashed run leaves debris) while keeping
compile caches. A failed reset is a failed gate: never run a gate on a dirty environment. Router
will not guess a `reset` command, because that is the one that wipes state.

Throughput is one gate at a time: with a gate of T minutes the ceiling is 1/T **regardless of how
many executors run**. Two or three executors saturate it; more just lengthens the queue.

## 7. How much review each change earns

Every tier gets the mechanical gates *and* the main session reading the **complete diff**. What
scales with risk is the independent pass, not your own reading.

| risk | mechanical gates | independent contract review | main session |
|---|---|---|---|
| Low | green required | skip | reads the full diff + delivery report |
| Normal | green required | one independent pass | reads the full diff, judges its findings |
| High | green required | independent pass, multiple lenses | reads the full diff, plus verifies the invariants by hand |

**Never merge on green alone.** Measured: the main session's own floor review found three real
defects in a diff that was green *and* mechanically verified -- a reported concurrency figure
that did not match the pool that actually ran, a batch `--json` path emitting several
concatenated documents, and a test fake reading an environment variable the executor allowlist
never passes, so it silently proved nothing.

**Read the diff, not the logs.** The diff is judgment input -- read it whole. Raw build output is
evidence input: take the delivery report's summary and the verifier's per-check result, and cite
the gate log by *path*. Everything read enters the orchestrator's prefix and is re-read on every
later turn, so raw logs are the largest avoidable cost.

## 8. Sessions: resume, or start fresh

- **Same task, fixing what the gate reported -> `router resume <id> --feedback "..."`.** Same
  worktree, same base, same scope; the executor keeps what it learned instead of re-exploring the
  repository. Send a precise error summary, not a log dump. Cap it at two attempts, then take the
  package over or bring it to the user.
- **Resume saves exploration, not tokens.** An executor's session is re-sent in full every turn, so
  each round costs the whole accumulated prefix again. Measured across three attempts of one task:
  **7.69M → 9.18M → 9.35M input tokens** — the third changed *eight lines in 59 seconds* and still
  cost more input than the original 1181-line implementation. So: put **all** your findings into
  one resume rather than three, and **make trivial mechanical edits yourself** — a resume for two
  comment changes cost roughly what the entire implementation had.
- **A different task -> a fresh session.** `resume` reuses the same worktree and the same
  `base_sha`, so a reused session's memory and the files on disk drift apart silently -- and the
  scope gate diffs against `base_sha`, so a second task there would carry the first one's changes.
  "One task, one auditable diff" is gone. A stale session also cheerfully revives plans it already
  discarded.
- **Wanting to reuse a session across tasks is a symptom of splitting too finely.** Same area,
  same base, no dependency -- they should have been one package. Merge them instead.

Warm repository knowledge travels as **artifacts, not sessions**: the symbol index
(`/router:symbol`) gives a fresh session the same knowledge without inheriting stale beliefs, and
a probe's findings enter the next contract as text.

A `TASK_CONTEXT.md` navigation summary is written by default, but **only from facts establishing
the contract already required** -- never explore extra to fill it in, and leave a section out
rather than pad it. Known cost: on a small two-file task it made the executor's input 21% larger
(474.7k vs 392.6k) for identical quality, because an executor's input is re-sent every turn --
the summary is paid every turn while its benefit is one-off. That is executor quota, the cheap
side; whether it pays on a large repository where finding the entry points genuinely dominates is
still open, so every dispatch records `task_context_present` and `task_context_chars` and the
answer will come from data.

## 9. Read-only probes

`mode: probe` in a task contract inverts the gate: an **empty diff passes** and a diff fails. Use
it when an assumption would invalidate the approach if it turned out false -- platform behaviour,
a migration's real shape, what a dependency actually does. The probe reports what it found; its
conclusion enters the implementation package's contract as text. Skip it for low-risk work in a
pattern the project already uses.

## 10. What lands on disk

```
.router/
  gate.yaml                     # the real gate: mode + commands (you confirm it once)
  models.yaml                   # optional tier overrides; `router models` shows the result
  metrics.jsonl                 # append-only: one row per run, plus orchestrator rows
  plans/<plan_id>/              # DESIGN.md, PLAN.md, critique-<round>.md, DECISIONS.md, spec.lock
  tasks/<id>/
    task.yaml                   # the machine contract (scope, tier, risk, verify, depends_on)
    TASK_CONTRACT.md            # the seven faces, for the executor to read
    TASK_CONTEXT.md             # optional navigation summary
    runs/<run>/
      DELIVERY.md               # the executor's final message
      diff.patch  result.json   # the diff and the full run record
      logs/worker.log  logs/gate.log
  worktrees/<id>/<run>/         # the isolated checkout the executor worked in
```

All of it is gitignored and created on first use -- there is no `init`, no policy file, and
nothing router writes into your repository.

`router result <id> --json` returns the whole run record: the verifier's per-check result, the
delivery header, effective `risk` and `risk_raised_by`, the queue gate's verdict and log path,
`base_sha`, and -- after `land` -- the `merge_commit`, which is the durable handle on what the
package changed (`git diff <merge_commit>^1 <merge_commit>`).

## 11. What is measured

`router usage` reports what each run cost against an all-strongest-model baseline -- grouped
per plan, main model versus executor, once the packages carry a `plan_id` and the orchestrator's
own spend has been recorded (`router orchestrator-usage --plan <id> --since <iso>`). The saving
is a measurement, not a claim; `--explain-savings` states its caveats, and an estimated figure is
never presented as exact.

`router usage --routing` aggregates recorded runs by executor, tier and effort -- first-pass
rate, re-dispatch rate, conflict rate, median wall clock, median input -- and says
`insufficient data` instead of guessing from three runs. It is **evidence for a routing decision
you make**: router never edits `models.yaml` on its own, and nothing in this system changes its
own configuration.
