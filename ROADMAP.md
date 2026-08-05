# Roadmap

router is **beta (0.x)**: the mechanism works end to end and is exercised on real
projects, but command shapes may still change before 1.0. This page says what 1.0 means
and what is being worked toward. It is a living document — items move as real runs
teach us things (see [CHANGELOG.md](CHANGELOG.md) for what they have taught so far).

## Toward 1.0

- [ ] **Stable command surface.** No renames or flag changes to
      `go / spec / review / dispatch / resume / land / gate / result / usage` without a
      deprecation window.
- [ ] **More real end-to-end runs.** The 0.8.x lessons all came from running real
      ClickHouse tasks through the whole loop; 1.0 wants that mileage on several more
      projects (worktree-mode and queue-mode both).
- [ ] **Routing defaults driven by evidence.** `router usage --routing` aggregates
      first-pass rate, re-dispatch rate, wall clock and input per (executor, tier,
      effort); once the sample sizes stop saying `insufficient data`, fold the findings
      back into the bundled tier defaults.
- [ ] **The `TASK_CONTEXT.md` question, answered by data.** Known: on a small two-file
      task it made executor input 21% larger for identical quality. Open: whether it
      pays on a large repository where finding the entry points dominates. Every
      dispatch records `task_context_present` / `task_context_chars`; the answer comes
      from those rows.
- [ ] **Changed-line-cap authoring guidance validated.** The cap rejected correct work
      twice before 0.8.3 taught it to count tests and deletions; confirm the new
      guidance stops the false rejections without letting scope creep through.

## Under consideration

- **npm publication** (`npx agent-router-cc`) as a second install channel alongside the
  Claude Code marketplace.
- **Coverage reporting in CI** (node --test's coverage output + a badge).
- **A docs site** (GitHub Pages) once the workflow doc stabilizes — today
  [docs/workflow.md](docs/workflow.md) is the single source of truth.

## Non-goals

These are settled by design, not open items:

- **No auto-merge.** Gates decide PASS/FAIL; the human decides land.
- **No self-modifying configuration.** router never edits `models.yaml` or `gate.yaml`
  on its own; routing evidence is input to a decision *you* make.
- **No global policy file.** Scope, risk, and verification stay per-task, authored from
  the conversation.
- **The CLI stays thin.** Mechanism in code; judgment in the command playbooks and with
  the human.
