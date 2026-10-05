# Roadmap

router is **beta (0.x)**: the mechanism works end to end and is exercised on real
projects, but command shapes may still change before 1.0. This page says what 1.0 means
and what is being worked toward. It is a living document — items move as real runs
teach us things (see [CHANGELOG.md](CHANGELOG.md) for what they have taught so far).

## Toward 1.0

- [ ] **Stable command surface.** No renames or flag changes to
      `go / brainstorm / design / design-review / review / explain / resume / symbol` without a
      deprecation window. A rename of the plugin itself -- `router` no longer routes anything --
      is expected before 1.0 and will get one.
- [ ] **A measure of "better code".** Every measurement this project recorded was about cost and
      first-pass rate, and those went with the executor model in 0.15.0. Decide what to watch --
      defects reaching main, review rounds to converge, rework after merge -- before recording
      anything, so the data answers a question someone actually asked.
- [ ] **Review that converges in 2-3 rounds.** The burden-of-proof rule in `/router:review` is in
      place; confirm on more real changes that it holds.
- [ ] **More real end-to-end runs** of the main-session flow on projects other than this one.

## Under consideration

- **npm publication** (`npx agent-router-cc`) as a second install channel alongside the
  Claude Code marketplace.
- **Coverage reporting in CI** (node --test's coverage output + a badge).
- **A docs site** (GitHub Pages) once the workflow doc stabilizes — today
  [docs/workflow.md](docs/workflow.md) is the single source of truth.

## Non-goals

These are settled by design, not open items:

- **No auto-merge.** The main session verifies and hands back; the human decides what lands.
- **No self-modifying configuration.** router never edits `models.yaml` on its own.
- **No global policy file.** Scope, risk, and verification are agreed per change, in the
  conversation.
- **The CLI stays thin.** Mechanism in code; judgment in the command playbooks and with
  the human.
