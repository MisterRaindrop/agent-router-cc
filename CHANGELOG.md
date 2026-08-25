# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
within the 0.x series (minor bumps may still change command shapes before 1.0).

## [Unreleased]

## [0.12.0] - 2026-08-25

You can see what is running in the background, and see that it is *moving*. Designed
through the project's own flow (brainstorm -> design -> workplan), built as five work
packages, each independently reviewed and mutation-tested by the main session.

> **Changelog gap.** 0.10.0, 0.10.1, 0.10.2 and 0.11.0 shipped without entries here.
> They are in the git history; this file simply stopped being updated. Recorded rather
> than back-filled from memory.

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
