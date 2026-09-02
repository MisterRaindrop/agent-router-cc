# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
within the 0.x series (minor bumps may still change command shapes before 1.0).

## [Unreleased]

### Fixed

- **Dependabot filed runtime dependency bumps under a group named `dev-dependencies`.** The group
  was `patterns: ["*"]` — everything — on the stated reasoning that "the shipped bundle is
  dependency-free". That reasoning is wrong: `web-tree-sitter` and `tree-sitter-wasms` are vendored
  into `dist/vendor/` and ship, so a bump arriving under a dev label changes the code users run.
  Measured twice, in #65 and #86: a `web-tree-sitter` bump rode in on a PR titled as build noise and
  took nine symbol-index tests with it, the second time bringing `js-yaml` along.

  The dev group is now restricted to `dependency-type: development`, the two tree-sitter packages are
  grouped as the pair they are — coupled by the grammar ABI, and each broken alone — and every other
  runtime dependency gets its own pull request. `test/plugin-manifest.test.ts` asserts the shape, so
  reverting it goes red rather than being noticed by the next failing CI run.

## [0.12.6] - 2026-09-02

### Fixed

- **A typo in a `DESIGN.md` was hidden by the brainstorm below it.** `router plans` picked the
  furthest document whose status it *recognized*, so a design declaring `desgin_draft` fell through
  to a `converged` BRAINSTORM — the listing reported a finished earlier stage and the error in the
  current one was invisible. That is the blind spot the unrecognized-status mark was added to
  remove, reproduced one level up, and it was unchanged from before that mark existed.

  Ownership now follows which document **exists**: work plan, else design, else brainstorm, and the
  search stops there. `hasPlan` already worked this way and its comment already said why — a plan on
  disk means the earlier stages are done, so reporting "brainstorming" over a broken plan reads as
  regress rather than as damage. The design level simply never got the same treatment.

  A design that exists but cannot be parsed therefore reports `-` rather than borrowing the
  brainstorm's status. **Known limit, recorded at the code site:** `-` there is still
  indistinguishable from "no document", which is the same class of conflation one step further, and
  closing it means inventing a value for "present but unreadable".
- **A lock test failed CI on a loaded runner while asserting nothing about the code.** It bounded the
  window in which the lock file may be absent during a reap at a hardcoded 100ms; a 4-core runner
  reported 162ms and went red. Measured five times on an idle machine, that window is **0ms** — the
  20ms sampler never once catches it, because the gap is two syscalls. The 162ms was the reclaiming
  process being descheduled between them, which is not a property of the lock. The bound is now one
  reap grace, derived from the same constant the test drives the reap with, and it was characterized
  from both sides: a 300ms handover still passes, a 600ms one fails, and the order this test exists
  to catch leaves the file absent for the whole ~800ms reap.

## [0.12.5] - 2026-09-01

An independent review of 0.12.4's change found two defects in it. Both are fixed here.

### Fixed

- **Only one of four text columns was sanitized.** 0.12.4 neutralized the `stage` column because the
  plans table is written straight to a terminal — and left `id`, `revision` and `design` raw, though a
  directory name and both revisions are arbitrary text out of the same files. Measured:
  `revision: "r<ESC>[31mRED"` put two escape bytes on the terminal. Sanitization now happens at the
  render boundary, on the same value the column width is computed from.
- **The rule "a control character means something was declared" held for two characters and no
  others.** `String.trim()` also removes TAB, CR, LF, VT, FF, NBSP, FEFF and U+2028, so
  `status: "\t\r"` rendered `-` while `status: "\e\a"` rendered `?..` — one rule answering two ways.
  Only plain spaces are padding now. A trailing TAB survives as one `.`, which is one terminal cell
  and more than the reader used to be told.
- **A frontmatter value has no size limit and the whole of it reached the table.** Cells sourced from
  frontmatter are capped at 32 characters with an ellipsis; `--json` keeps the full value for anyone
  who wants it. The cap deliberately does **not** apply to a plan id: that is a directory name and the
  row's key, and this table's own test pins that a long one widens the column rather than being cut.

### Changed

- Eight behaviours that were verified by hand during review now carry assertions: numeric, boolean,
  mapping and sequence statuses; DEL, C1, TAB and wide-glyph sanitization; a value of 5000 characters;
  a parseable document with no `status` key; and which document owns the stage when every level is
  unrecognized.

## [0.12.4] - 2026-09-01

### Fixed

- **`router plans` reported "a status nothing recognizes" and "no document at all" identically**, both
  as `-`, so a typo in that one frontmatter field was invisible in the listing. An unrecognized
  status now renders `?<status>`, and `-` means only "no document, or no status declared".

  The value is neutralized before printing, which is the whole reason a naive echo was reverted
  earlier: `status:` is arbitrary text from a file and this table is written straight to a terminal,
  where an escape sequence moves the cursor or sets a colour instead of being read. Everything
  outside printable ASCII becomes `.` — ESC, the C0/C1 ranges, CR and LF — which also keeps one unit
  to one terminal cell so the column is measured like every other one.

  Four ways of writing nothing give one answer: no `status` key, `status:`, `status: ""` and
  `status: "   "` all render `-`. A padded value is marked rather than quietly accepted, so
  `status: " converged "` shows `?converged` — the document does not say `converged`. A status of
  only control characters counts as declared (`?..`), deliberately: `-` there would hide a corrupted
  document, which is the blind spot this column exists to remove.

  `stage` in `--json` carries the same marker.

## [0.12.3] - 2026-09-01

### Fixed

- **`router doctor` said `tree-sitter: UNAVAILABLE ()`** — the one line whose job is to explain a
  failure, explaining nothing. The runtime throws an `Error` with an empty message when it rejects a
  grammar's ABI, and the probe printed `.message` verbatim. Diagnosing a real occurrence needed a
  hand-written script. It now names the error type and code, and says which two packages to compare
  when there is no message at all. Measured on `web-tree-sitter` 0.26.13 against
  `tree-sitter-wasms` ^0.1.13: `Parser.init` succeeds, `Language.load` is what fails.
- `package-lock.json` still declared version `0.9.0` three releases later. Regenerated.

### Added

- **`design_abandoned`**, a terminal state for a design the user stops part-way — "just build the
  whole thing, skip the design". Such a document used to sit on `design_draft` forever, so
  `router plans` listed finished work as the only unfinished plan. Brainstorm has `rejected` for the
  same situation; design had nothing.

### Changed

- Dev dependencies: `@types/node` 26.1.2 → 26.4.0, `esbuild` 0.28.1 → 0.28.2. `web-tree-sitter` is
  deliberately held at `^0.25.3`: 0.26 makes `Language.load` reject the `tree-sitter-wasms` grammar
  and takes nine symbol-index tests with it.

## [0.12.2] - 2026-09-01

### Fixed

- **A gate or verify command that timed out left its build running in the checkout, and router then
  handed that checkout to the next task.** `runCommand` is how every reset, verify and gate command
  runs, and `spawnSync`'s `timeout` kills the direct child only — `npm`, `make`, `cmake` and every
  test runner start their own children. Measured: `timedOut: true` with the grandchild still alive,
  after which `dispatch` releases the exclusive lock on the stated invariant that no writer is left
  in the tree. Commands now lead their own process group and `runCommand` does not return until that
  group is empty, on **every** path — a command that exits 0 while its children keep working leaves
  the identical writer behind and is not a timeout. A group that outlives SIGKILL is reported as
  `group_survived`, fails the gate, and holds the lock shut, matching what the executor path already
  did.
- The SIGTERM-then-SIGKILL-then-confirm-empty protocol existed in three copies. It is now one,
  `drainGroupSync` in `src/io/signals.ts`, shared by the lock's reclaim path and the verifier.

### Changed

- **The RED-before-GREEN rule now covers tests that are not bug fixes.** `assurance-core.md` already
  required a regression test to fail against the old implementation; a test written for behaviour
  that already works needs the same proof, and did not have to give it. Three times in one plan a
  test looked better than what it replaced, passed with the fix, **and** passed with the fix
  removed. Two additions come with it: break the code once per part of the fix, because three
  regressions in one change need three failing tests and one "delete the whole thing" run passes
  over two of them; and assert the fixture did what you needed before asserting what you care about,
  so a mis-aimed test is loud rather than green.

## [0.12.1] - 2026-08-31

Three rules about how a code review ends. No new code paths: the production diff is comments
and one new test.

### Fixed

- **The statusline replaced the user's whole HUD with a bare `router` on most renders.** The 1s
  timeout on the chained inner statusline, added in 0.12.0, killed it before it flushed: measured,
  claude-hud takes a median of 1206ms in this repository because it runs `git status` every render,
  so 20 of 25 runs were over the limit and 10 of 12 renders lost the line. The timeout now sits far
  above any healthy HUD.
- Two FIFO tests were bounded by node startup latency (750ms / 1500ms) rather than by the
  finite-versus-infinite distinction they existed to make, so they failed on a loaded machine while
  asserting nothing about FIFOs.
- The statusline's inner-HUD reap is now tested on **both** paths it runs on. It had only ever been
  fenced on the timeout path, so narrowing it to `ETIMEDOUT` left the suite green while a HUD that
  exited normally leaked its background children again. Behaviour is unchanged; the production
  change is comments, which now describe a contract the code can actually keep: work left inside
  the inner HUD's *process group* does not survive a render — a descendant that calls `setsid` is
  outside it, and so is the interval before the group drains.

### Changed

- **`/router:review` now has to say why a round ended, and a round is not over because it ran.** A
  reviewer that a content filter refused does not know it was refused and does not say so: its log
  is simply short, and short reads exactly like clean. Every lens is now classified before a round
  can close — `verdicts`, `blocked`, `truncated`, `empty`, checked in that order because one lens
  read 666KB, produced one finding, and was refused at the moment it wrote its report. A lens that
  is not `verdicts` did not conclude; it did not "find nothing". The round ends on zero blocking
  findings with every lens `verdicts`, never on a round count — a cap does not produce convergence,
  it hides the absence of one. Round two and later review `<previous round's head>..HEAD`, because
  the fixes are what that round is for: of nine findings across rounds two and three of one plan,
  two were defects the earlier fixes had introduced.
- **A finding that cannot be reproduced is `unverified`, not discarded.** Reproduction decides
  blocking versus unverified; it does not decide reported versus discarded. Only a finding with no
  mechanism at all is dropped. Getting this backwards would have thrown away this project's own
  heartbeat defect, which was raised with no reproduction and was entirely real. `unverified`
  findings go into the reviewed work's own `DESIGN.md` known-limits section, where the next feature
  reads them — a per-round decisions file is where they go to die, measured: one was re-raised and
  re-adjudicated in all three rounds because it lived only there.
- **`/router:go` asks you to search the repository before fixing anything.** Search for the
  mechanism in one or two words, not the symptom in a sentence, and write the result into the
  adjudication as a `file:line` or the sentence "looked, nothing there" — an unwritten search and an
  unperformed one leave the same trace. Three times in one day the answer was already here and went
  unused; the first of those survived three adversarial review rounds and ended in 190 orphaned
  `git` processes and a load average of 86.
- **The spinner is gone, and `refreshInterval` goes back to 10 seconds.** The 2-second interval was
  chosen from a cost estimate that was wrong by twenty times (~122ms per render; really ~1777ms),
  and at 2 seconds renders overlapped until five statusline processes were alive and the load
  average passed 130. At an honest interval a spinner holds one frame for ten seconds, which reads
  as motion that has *stopped* — worse than no spinner. Liveness is carried by the numbers, which
  are recomputed every render and so are uniformly stale rather than partly moving.
- `setup-statusline` writes `refreshInterval` **only when the field is absent**. A value you set is
  yours: the right interval depends on what you chained and how large your repository is, and
  router can measure neither.


## [0.12.0] - 2026-08-25

You can see what is running in the background, and see that it is *moving*. Designed
through the project's own flow (brainstorm -> design -> workplan), built as five work
packages, each independently reviewed and mutation-tested by the main session.


### Added

- **`router supervise --label L --log F -- <argv...>`** — run any command with visible
  liveness. It publishes an activity record with an out-of-process heartbeat, writes the
  child's stdout **and** stderr to `--log` byte-for-byte as `> file 2>&1` would, and passes
  the child's exit code through unchanged. It deliberately does **not** take `gate.lock`,
  so a supervised review and a dispatch never queue behind each other.
- **A three-state statusline segment, always rendered**: `router ▶ idle` when nothing is
  running, a **spinning** frame plus the label (and phase / budget / `·log` age) while a run
  is alive, and `已失联 <age>` when its owner has gone. Liveness is `pid` alive **and**
  heartbeat fresh — never "does a `terminal_state` field exist", which is what used to leave
  a phantom run on screen forever.
- `.router/activity/<key>.json`: display-only activity records with an ownership token, an
  atomic claim, and one shared liveness rule. `router result`, `router land` and the queue
  gate do not read them.
- `dist/statusline-activity.mjs`: the activity observation API as its own import-safe bundle,
  so the standalone statusline reuses the one liveness rule instead of re-implementing it.

### Changed

- `router setup-statusline` now also writes `statusLine.refreshInterval: 2` — without a fast
  refresh the segment is technically correct and visibly frozen. It **repairs** an existing
  config that lacks the field (reporting `updated`, not `already-configured`, which is the trap
  0.10.1 shipped), names the previous value it overwrote, **preserves unknown keys under
  `statusLine`** instead of replacing the whole object, and tells you to restart Claude Code.
- `commands/review.md` launches both review lenses through `router supervise`, always with
  `< /dev/null` — a lens that inherits an open stdin can sit for 20 minutes printing 39 bytes.

### Notes

- **Restart Claude Code** after upgrading for `refreshInterval` to take effect. A running
  session keeps its old refresh rate, so the statusline stays frozen while everything
  underneath is already correct.
- The activity file is display-only by design: it is never consulted to decide whether a
  merge, a gate verdict or a result is valid.

## [0.11.0] - 2026-08-25

Executor ownership and verification hardening, from three review rounds (21 findings,
15 commits). Back-filled from the git history on 2026-08-25; this file had stopped being
updated after 0.9.0, so these four entries are reconstructed from commits and PRs, not
written at release time. Where a detail was not recoverable from the history it is left out
rather than guessed.

### Added

- **`verified_head`**: a PASSED verdict authorizes a *commit*, not a branch. `router land`
  and the queue gate both merge the SHA that was actually verified, and `land` deletes the
  branch with an `update-ref` compare-and-swap.
- A content-hash fingerprint of `.router/` taken before and after the executor **and across
  verification** -- the verify commands are the executor's own committed code, so that is its
  last and widest write channel.
- A reclaimer mutex (`gate.lock.reclaim`) installed by write-to-staging -> fsync -> `link`,
  so there is no live-but-empty window, with a lease renewed on every reap poll.

### Fixed

- An unref'd drain timer let the CLI exit mid-drain with code 13, leaving an orphan executor.
- `router orchestrator-usage` now takes the checkout lock instead of racing a live run.

## [0.10.2] - 2026-08-24

### Fixed

- The statusline command pinned one plugin version, so an upgrade stranded it on the old
  release forever, silently. It now resolves the newest installed version at startup.
- An inner statusline that ignores stdin lost its whole line to a caught EPIPE.

## [0.10.1] - 2026-08-24

### Fixed

- The statusline fix had to reach an installed plugin, which keys on version -- so shipping it
  required a release, not just a commit.

## [0.10.0] - 2026-08-23

The router v2 command surface.

### Added

- **`/router:brainstorm`** -- the stage before design, for when the goal itself is not settled.
- **`/router:workplan`** -- `PLAN.md` renamed, with the design-revision binding that drops a
  plan back to draft when the design moves past it.

### Changed

- **Parallel dispatch removed.** Measured, the orchestration overhead was 0.26s against 393s
  of executor time -- effectively free to run, and expensive for the human: review was the
  bottleneck the parallelism kept feeding.
- Worktree mode replaced by branch mode: a fresh worktree has no dependencies, no build
  objects and no configure output, so a real project cannot compile in one.

## [0.9.0] - 2026-08-12

The go-execution v2 groundwork: single-executor mode plus the shared observability
substrate. Designed through the project's own design flow (two adversarial review
rounds, twelve objections adjudicated one by one; records in the plan's DECISIONS.md).

### Added

- **`/router:go single`** — one strong executor takes the whole feature as a single
  package while the main session stays planner/reviewer. Opus is the default and the
  floor: the pin never silently downgrades; quota pressure fails loudly. With an
  approved `PLAN.md`, the contract is a **verbatim copy** anchored by plan revision +
  content sha256 (an immutable snapshot — zero re-authoring); without one, a ~40-line
  compact template. `TASK_CONTEXT.md` is no longer written by default (measured: +21%
  executor input, zero quality gain).
- **Live run status**: every dispatch run writes an atomic `status.json` — a six-phase
  state machine separate from five terminal states, elapsed vs budget, log-activity age,
  stall countdown, and a `recent_action` under a strict redaction allowlist (tool +
  repo-relative path, or Bash program + known subcommand; arguments, file contents and
  environment values provably never persisted).
- **Statusline live segment**: active runs render as
  `router ▶ <id> <phase> <elapsed>/<budget> ·log <age>` (multi-run, stall countdown,
  recent action), chained after the existing quota segment.
- **Per-phase timings** (`t_worktree/t_launch/t_exec/t_gate/t_verify`) recorded on each
  run's metrics row — the wall-clock baseline for the upcoming parallel work.
- **Detached execution + listener protocol** in `go`: dispatch survives the session
  (process-group detachment — measured: the harness kills tracked tasks by process
  group; a `detached:true` child survives), a listener wakes the session at terminal
  states, and a dead status channel falls back to the authoritative result files.

- **`router list` shows the live phase** of a run still in flight (`executor_working 3m`)
  instead of `none`; `--json` gains `live`. A malformed `status.json` degrades to the old
  output rather than breaking a read-only view.
- **`recent_action` for codex runs**, extracted from `command_execution` events (login-shell
  wrapper unwrapped) under the same redaction allowlist as the claude path; model prose is
  ignored outright.
- **`router usage --routing` reports per-phase medians** (`worktree/launch/exec/gate/verify`)
  with their sample counts. Rows lacking the fields are excluded from the median rather than
  counted as zero, and a group with no timed rows renders `—`, never `0.0s`.
- **`router plans` gains a `stage` column** (the furthest recognized document status) and
  sizes its columns to the longest value.
- CI now fails when the committed `dist/` bundle is not the build of the committed source.

### Changed

- Conversation-side progress is two-tier by design: statusline carries periodic status
  (zero model turns); the conversation gets only terminal states and anomalies. An
  opt-in periodic heartbeat exists and is documented as costing one model turn per beat.

### Fixed

- `router plans` reported **every** revision as `unknown`: it read the legacy
  `plan_revision` key while the current flow writes `revision` (the legacy key is still
  honored). Long plan ids also overflowed the id column and swallowed the next one.
- `router plans` no longer creates `.router/` as a side effect of being run — browsing is
  read-only.

## [0.8.5] - 2026-08-11

Version bump note: `0.8.4` was bumped in-manifest during dependency updates but its
content was never released as a distinct set of commands; everything since `0.8.3`
ships here. The bump to `0.8.5` exists so version-comparing plugin updaters actually
reinstall -- the design-flow change below altered command content under an unchanged
version, which left already-updated installs stuck on the old command set.

### Added

- **The design flow for large features** (opt-in, always the user's call): `/router:design`
  clarifies one question at a time interleaved with code research, then drafts a
  `DESIGN.md` (why/what/non-goals/approach/alternatives-rejected/risks/acceptance) confirmed
  **section by section**; `/router:design-review` gets an independent-model adversarial pass
  on the Design where **every objection is adjudicated by the user** (accept/reject/discuss,
  recorded in `DECISIONS.md`, output in the user's conversation language, nothing ever
  auto-applied); `/router:plan` turns the approved Design into a `PLAN.md` carrying the task
  breakdown, verification matrix and rollout, approved as a summary. Stage state lives in
  the two documents' frontmatter; a Design revision drops the Plan back to draft.
- Project logo (`docs/assets/logo.svg`) and a restructured bilingual README with
  badges, a measured-savings section, model-selection and gate tables, and condensed
  review rule summaries.

### Changed

- `/router:go` gains a second entry mode: with an approved `PLAN.md` it executes the
  breakdown **verbatim** (numeric caps filled at dispatch) and skips the package-list
  confirmation -- that list was approved at `/router:plan`. Without one, behaviour is
  unchanged.
- `/router:review` and the assurance references now name the Design (risk tier, Must NOT,
  acceptance criteria) and the Plan (verification matrix, scope) as the bar they check
  against; `level: spec` findings return to `/router:design` / `/router:plan`.

### Deprecated

- `/router:spec` -- replaced by the design flow above. The command now only prints the
  migration pointer; existing frozen `PLAN.md` files remain valid inputs to `/router:go`.
- Community standards: `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `ROADMAP.md`, issue/PR templates, and Dependabot config.
- CI: node 18/20 smoke jobs on the committed bundle, alongside the full node 22 check.

## [0.8.3] - 2026-08-03

Three cost lessons the second real ClickHouse run measured. All three were guidance the
docs got wrong or never gave, and each one cost real money or a rejected-but-correct
diff on the run that found it.

### Changed

- **`resume` guidance no longer implies resume is cheap.** An executor's session is
  re-sent in full every turn, so each round pays the whole accumulated prefix again
  (measured across three attempts of one task: 7.69M → 9.18M → 9.35M input tokens; the
  third attempt — eight lines in 59 seconds — cost more input than the original
  1181-line implementation). The guidance now says: put every finding into one resume,
  and make trivial mechanical edits yourself.
- **`max_changed_lines` now has authoring guidance.** The cap had rejected correct work
  twice, both times sized to the implementation while the contract demanded three tiers
  of tests. Size it to the real diff shape: tests and deletions count too.
- **The stage gate now costs the build step.** A warm build directory does not make
  verification cheap: adding one new source file re-triggered CMake's
  `CONFIGURE_DEPENDS` glob and invalidated 9,891 object files against a four-hour CI
  budget. The gate now checks the project's own build budget, flags changes that add
  files rather than only editing them, and — when the promised verification cannot
  run — says "this was never compiled" in those words.

## [0.8.2] - 2026-08-02

Two report/tidiness defects from the first real end-to-end run — both found by running
a real ClickHouse task through the whole loop rather than by reading the code.

### Fixed

- **`router usage` no longer suggests routing the orchestrator row.** That row is the
  main model by definition — the one row that cannot be routed — and suggesting it next
  to otherwise-correct hints cost the report its credibility. Suggestions now consider
  dispatch rows only.
- **`land` no longer leaves an empty `.router/worktrees/<id>/` shell behind.** The
  directory grew one empty entry per task that had ever run and read like a list of
  live runs. It is now dropped with `rmdir`, which refuses a non-empty directory, so a
  second run of the same task is never touched.

## [0.8.1] - 2026-08-01

### Fixed

- **Shipped the state-guard fix (#51).** The guard now allows what the workflow asks
  the orchestrator to write (`TASK_CONTEXT.md`, `gate.yaml`); without the version bump
  the fix stayed on `main` while every installed plugin kept refusing those writes.

## [0.8.0] - 2026-08-01

The version installed users update to: `main` had carried the v2 round (#37–#48) while
the plugin manifest still said 0.7.0, and that number decides whether an installed
plugin sees an update at all.

### Added

- The v2 workflow round (#37–#48): plan namespacing under `.router/plans/<plan_id>/`
  with `spec.lock`, the `plans` verb, the optional `TASK_CONTEXT.md` mechanism (off by
  default, measured), queue-gate discovery and plan revision, and the widened executor
  gate grant that survives a resume.
- `docs/` added to the packaged `files`, since the README points at
  `docs/workflow.md`.

### Changed

- Plugin/command descriptions rewritten to state the actual division of labor: the CLI
  owns mechanism (isolated worktrees, supervision, concurrent dispatch, the
  exclusive-lock verification queue, environment-free gates on the diff); the main
  session owns every judgment, including the pass/fail verdict.

[Unreleased]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.5...v0.9.0
[0.8.5]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.3...v0.8.5
[0.8.3]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/MisterRaindrop/agent-router-cc/releases/tag/v0.8.0
