# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
within the 0.x series (minor bumps may still change command shapes before 1.0).

## [Unreleased]

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

[Unreleased]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.5...HEAD
[0.8.5]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.3...v0.8.5
[0.8.3]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/MisterRaindrop/agent-router-cc/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/MisterRaindrop/agent-router-cc/releases/tag/v0.8.0
