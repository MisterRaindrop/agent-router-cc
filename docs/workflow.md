# The workflow

`/router:go` reads as one command, but it drives a whole protocol: how a plan becomes
dispatchable packages, what the executor owes back, which gate proves what, and how much
review each change earns. This page is that protocol end to end. `docs/quickstart.md` is the
five-minute version; `references/work-package.md` is the copy the orchestrator itself reads.

**The one rule everything else follows from:** the CLI owns only mechanism -- the exclusive
lock on the checkout, rescuing your uncommitted work, cutting and asserting the task branch,
supervision, and gates that need no environment -- and every judgment stays with you and the
main session. A cheap model can clear a shallow gate while
being lazy or wrong, so "is this right" is never delegated, and never compressed.

## The shape of a run

```
everyday task:   plan with Opus in conversation  ->  /router:go  ->  /router:review (optional)
                                                     one package, one       independent, strict
                                                     executor, gate,        review of landed code
                                                     review, land

large feature (opt-in -- the user's call, never router's):
  /router:brainstorm -> /router:design -> /router:design-review (opt.) -> /router:workplan -> /router:go
  question the idea;    clarify + code    independent adversarial          the how: task       executes the
  compare with how      research;         pass; every objection            breakdown, deps,    approved plan
  others solve it;      DESIGN.md         adjudicated by the user,         verification;       verbatim
  argue against         approved section  none auto-applied                approved as
                        by section                                         summary
```

`/router:go` pauses at exactly three points: confirm the package, handle whatever needs real
judgment, and approve before anything merges. Nothing lands without you. (When `go` executes a
work plan approved via the design flow, the first pause is skipped -- that was approved at
`/router:workplan`; the other two remain.)

**One run, one package, one executor.** The pin always carries all three fields (`kind`,
`model`, `effort`) taken from that family's `critical` row in `router models`, because an
omitted effort silently falls back to the provider default. The user may deliberately pin
lower; router never lowers it on its own (a 429 fails loudly instead of demoting). The contract
is a verbatim copy of the approved `WORKPLAN.md` **and `DESIGN.md`** (each anchored by revision
+ sha256) or a ~40-line compact template. Dispatch runs **detached** (it survives the session)
with a listener that wakes the session at terminal states; progress lives in the statusline --
every run writes a live `status.json` (phase, elapsed vs budget, log activity, stall countdown,
a redacted `recent_action`) and per-phase timings into metrics. `commands/go.md` has the flow;
`references/task-contract.md` has the authoring detail.

**Where the executor works.** In your own checkout, on a branch called `router/<task-id>`. Not
in a `git worktree`: a fresh one has no dependencies, no build objects and no configure output,
so a real project cannot compile in it -- and the build has to happen in the main checkout
anyway, which then adds a "carry the code back" step. What replaces the directory isolation is
git plus a lock, described in section 4.

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

## 4. Dispatch runs one task at a time, under a lock

```
router dispatch <id> --json
```

Parallel dispatch was removed, and not for cost: measured, the whole orchestration overhead was
0.26s against 393s of executor time -- effectively free. It cost the human. Several executors
editing at once means tracking who changed what, in what order things merge, and whether
merging them breaks each other; and every result still needs reviewing one at a time, so review
was the bottleneck the parallelism kept feeding. Several packages means several `go` runs.

Because the executor shares your checkout, the run is a transaction:

| Step | What it does |
|---|---|
| probe | read the branch and working tree. Already on an unmerged `router/*` branch -> ask before continuing |
| take lock | **before the first write**. Blocked -> report the holder's pid and last-active time |
| reap | lock reclaimed from a dead holder -> kill its orphan executor group first, and wait for it |
| rescue | your uncommitted work -> one commit, file list and sha reported |
| branch | create `router/<task-id>`. Name already taken -> **fail**, never reuse |
| contract | `WORKPLAN.md` + `DESIGN.md` concatenated verbatim, each with its sha256 |
| dispatch | launch the executor detached, cwd = the repository root |
| work | the executor commits **one functional unit at a time** |
| closing | assert: on the task branch, `base_sha` is an ancestor of `HEAD`, **nothing uncommitted** |
| verify | `gate.yaml` reset, clean-vs-incremental gate, then the environment-free checks |
| report | done, and **which branch you are on**. No switch back, no merge |
| release | terminate the executor's process group, release the lock |

Three rules make sharing the checkout safe, and each replaces something the worktree used to
give for free:

- **The lock is taken before the first write and held until the executor is dead.** The
  resource being protected starts changing at the rescue commit, so a lock taken later would
  let two runs commit over each other while neither yet held anything. Its heartbeat runs in a
  separate process, because verify commands block the event loop and an in-process beat would
  go silent for exactly as long as the lock's 90-second staleness window.
- **Nothing destructive runs without asserting identity.** A reset only happens while the
  current branch is exactly the task's and `base_sha` is still an ancestor of `HEAD`. And it is
  a tracked-only reset: the variant that also runs `git clean -fd` would delete files created
  while the executor was running, yours included.
- **The closing invariant.** There is no catch-all commit any more -- the executor commits its
  own units -- so a file it forgot would never enter `base_sha..HEAD`, and every gate would pass
  without ever seeing it. The run fails on leftovers instead of reporting success.

## 5. What the executor owes back

The executor owns its whole loop: read the code, decide its internal steps, implement, write
tests, run the gate, fix to green, self-check its scope, and report. Both protocols below
ride on its **final message**, so nothing is written into the working tree where it would enter
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

**The real gate** is a property of the project, not of the task, so decide it once and check it
empirically once. The executor now works in your checkout, so it already has the environment the
gate needs -- warm dependencies, warm objects, a real configure result. That is why the worktree
mode this section used to describe is gone: the reason for a separate mode was that a worktree
could not build.

Declare it in `.router/gate.yaml` and the dispatch flow runs it:

| key | what it does |
|---|---|
| `gate` | the incremental build-and-test command |
| `clean_gate` | the full-rebuild command |
| `clean_triggers` | globs whose change forces `clean_gate` instead of `gate` |
| `reset` | run **before** verification, clearing state a previous build left behind |
| `env` | extra environment variable names the gate needs |
| `lock_wait_minutes` | how long to wait when another run holds the checkout |
| `gate_wall_minutes` | hard ceiling on one gate command |

When `gate.yaml` declares commands they **replace** the task's `verify`: it describes how the
project builds, `verify` describes one task, and running both builds twice. Any **deletion** in
the diff forces `clean_gate` regardless of triggers -- an incremental build keeps a stale object
for a source file that no longer exists, and nothing in the diff tells it to drop it.

`mode: queue` still exists for a project that verifies on a shared **integration branch**:
`router gate <id...>` merges each task commit onto that branch in the project's own checkout,
where the caches are warm. The reason it uses your checkout rather than a dedicated verification
worktree has not changed: the container mounts a **fixed host path**, and the build directory,
ccache, `CMakeCache.txt`, ninja depfiles and `compile_commands.json` are all keyed to it. A
worktree is a different source path, so its caches and absolute paths are worthless even when
the path sits inside the mount.

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
  branch, same base, same scope -- and it refuses if you have checked something else out in the
  meantime; the executor keeps what it learned instead of re-exploring the
  repository. Send a precise error summary, not a log dump. Cap it at two attempts, then take the
  package over or bring it to the user.
- **Resume saves exploration, not tokens.** An executor's session is re-sent in full every turn, so
  each round costs the whole accumulated prefix again. Measured across three attempts of one task:
  **7.69M → 9.18M → 9.35M input tokens** — the third changed *eight lines in 59 seconds* and still
  cost more input than the original 1181-line implementation. So: put **all** your findings into
  one resume rather than three, and **make trivial mechanical edits yourself** — a resume for two
  comment changes cost roughly what the entire implementation had.
- **A different task -> a fresh session.** `resume` continues on the same task branch from the same
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
  gate.lock                     # the exclusive lock on this checkout, while a run holds it
  plans/<plan_id>/              # BRAINSTORM.md, DESIGN.md, WORKPLAN.md,
                                #   critique-<round>.md, DECISIONS.md, spec.lock
  tasks/<id>/
    task.yaml                   # the machine contract (scope, tier, risk, verify, depends_on)
    TASK_CONTRACT.md            # the seven faces, for the executor to read
    DELIVERY.md                 # the executor's final message
    diff.patch  result.json     # the diff and the full run record
    status.json                 # live phase/activity/terminal state (observation only --
                                #   never an input to gates, land, or any verdict)
    logs/worker.log  logs/gate.log
```

Run artifacts sit directly in `tasks/<id>/`. They used to live under `tasks/<id>/runs/run-001/`,
which was a directory level over a constant -- dispatch has been one attempt per task since the
synchronous model landed. The old path is still **read** so an existing task's history does not
vanish on upgrade; nothing writes it.

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
