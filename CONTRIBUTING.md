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
              (enforced by `npm run check:deps`) — this keeps exit classification and
              the symbol index deterministic and unit-testable
dist/         the committed, dependency-free bundle (`npm run build`)
commands/     the Claude Code slash-command playbooks (the judgment lives here)
skills/       portable skills the commands load (writing discipline, feature explanation)
references/   documents the main session reads at run time (assurance rules, the codex brief)
docs/         quickstart and the full workflow protocol
test/         node --test suites
testkit/      fixtures and helpers, including the fake codex binaries
```

Two design rules shape every change:

1. **The CLI owns mechanism, never judgment.** Launching and supervising codex, the
   symbol index and listing plans live in code; anything that decides "is this right"
   belongs in the command playbooks (`commands/*.md`) and ultimately with the human.
   Since 0.15.0 the main session writes the code itself, so the CLI is small on purpose —
   a change that grows it back toward an orchestrator needs a reason the main session
   cannot do the job.
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

Use the bug-report issue template. For a codex write, the most useful thing you can
attach is its record: `.router/writes/<id>/record.json` plus the tail of `codex.log` next
to it.

## Security issues

Please do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0](LICENSE) license that covers the project.
