# Contributing to router

Thanks for your interest! This document covers how to build, test, and submit changes.

## Getting started

```sh
git clone https://github.com/MisterRaindrop/agent-router-cc.git
cd agent-router-cc
npm ci
npm run check     # tsc --noEmit + core-purity guard + node --test
```

Development requires **Node.js 22+** (the test suite runs TypeScript directly via
`node --test`). The shipped bundle (`dist/router.js`) only requires Node 18+.

## Repository layout

```
src/          domain -> core -> io -> app -> cli   (layered; lower layers never import higher)
  core/       PURE: no fs, child_process, process, clock, or randomness
              (enforced by `npm run check:deps`) — this keeps gate logic
              deterministic and unit-testable
dist/         the committed, dependency-free bundle (`npm run build`)
commands/     the Claude Code slash-command playbooks (the "intelligence" lives here)
docs/         quickstart, the full workflow protocol, design notes
references/   documents the orchestrator itself reads at run time
schema/       JSON schema for task contracts
test/         node --test suites
testkit/      fixtures and helpers
```

Two design rules shape every change:

1. **The CLI owns mechanism, never judgment.** Worktree isolation, supervision,
   concurrency, locks, and environment-free gates live in code; anything that decides
   "is this right" belongs in the command playbooks (`commands/*.md`) and ultimately
   with the human.
2. **`core/` stays pure.** If your change needs fs/process/clock access, it goes in
   `io/` (or `app/`), and `core/` receives values, not effects.

## Making a change

1. Branch from `main`.
2. Make the change, with tests. Bug fixes need a regression test that **fails against
   the old code first** (RED) — see `references/assurance-core.md` for the full
   anti-gaming rules the project holds itself to.
3. `npm run check` must pass.
4. If you touched `src/`, run `npm run build` and **commit the rebuilt
   `dist/router.js`** — the plugin ships the bundle, not the sources.
5. If the change should reach installed plugins, bump the version in **both**
   `package.json` and `.claude-plugin/plugin.json` (they must match), and add a
   `CHANGELOG.md` entry. An unbumped fix stays on `main` and never reaches anyone's
   machine.
6. Open a PR. CI runs typecheck, the purity guard, the test suite, a bundle build, and
   a bundle smoke test on Node 18/20/22.

## Commit messages

Look at `git log` and match the house style: a short imperative subject, then a body
that explains **why** — what broke, what it cost, and how the change closes it.
Measured numbers beat adjectives.

## Reporting bugs

Use the bug-report issue template. The most useful thing you can attach is the run
record: `router result <id> --json` plus the log paths it names.

## Security issues

Please do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0](LICENSE) license that covers the project.
