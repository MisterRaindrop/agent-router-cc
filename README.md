<div align="center">
  <img src="docs/assets/logo.svg" width="112" alt="router logo"/>

  <h1>router</h1>

  <p><b>The strongest model for judgment. The cheapest quota for tokens.</b></p>

  <p>A Claude Code plugin that routes coding subtasks to the cheapest capable model —
  your main session (Opus) plans, reviews, verifies and merges; cheap executors write the code.</p>

  <p>
    <a href="https://github.com/MisterRaindrop/agent-router-cc/actions/workflows/ci.yml"><img src="https://github.com/MisterRaindrop/agent-router-cc/actions/workflows/ci.yml/badge.svg" alt="ci"/></a>
    <a href="https://github.com/MisterRaindrop/agent-router-cc/releases"><img src="https://img.shields.io/github/package-json/v/MisterRaindrop/agent-router-cc?label=version&color=e8a33d" alt="version"/></a>
    <img src="https://img.shields.io/badge/status-beta-d9635f" alt="status beta"/>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-4c7bd9" alt="license Apache-2.0"/></a>
    <img src="https://img.shields.io/badge/node-%E2%89%A5%2018-2f8f5b" alt="node >= 18"/>
    <img src="https://img.shields.io/badge/Claude%20Code-plugin-8a63d2" alt="Claude Code plugin"/>
  </p>

  <p><b>English</b> | <a href="README.zh-CN.md">中文</a></p>
</div>

---

## ✨ The idea

Most of a coding task's tokens go to mechanical labor — reading the repo, writing the
implementation, iterating to green (measured: one ~400-line feature burned **1.88M
executor input tokens**). The part that actually needs your strongest model — planning,
reviewing, verifying, merging — is **low-token, high-judgment**. router splits the work
along exactly that line:

|                        | Prompting the agent directly       | With router                                                    |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------- |
| **Who executes**       | Opus (expensive)                   | the cheaper executor with more quota (codex / sonnet)          |
| **Change scope**       | bounded only by the prompt         | enforced on the diff: allowed globs + changed-line cap         |
| **Correctness**        | you check by hand                  | CLI gates the diff (scope + secrets + exec bit); Opus runs the build/tests in your real env |
| **...and laziness**    | trust the model's word             | ...**plus** the main session reviews the diff for lazy/wrong work |
| **Where edits land**   | your working tree, immediately     | an isolated worktree; your tree changes only on `land`         |
| **Quota / rate limit** | the run stalls                     | balances codex vs claude by real remaining quota; 429 fallover |

router **never auto-merges**. The gates decide PASS/FAIL; you decide land.

## 💸 What it saves — measured, not claimed

Measured on this repository's own development (20 real dispatches, `router usage --all`):

| | actual spend | if all on Opus (est) | saved (est) |
|---|---|---|---|
| 20 dispatches | **$23.96** | ~$93.34 | **~$69.38 (~74%)** |

The savings figure is a **list-price estimate, not a bill** — the executors run on plan
subscriptions, so real marginal cost is often lower; `--explain-savings` prints every
caveat. Quality is guarded by mechanism, not by trusting the cheap model: every diff
passes five mechanical gates, a **full-diff review by the main session**, real-environment
verification, and a mandatory full-chain CI pass before "done" — the acceptance bar is
identical to Opus writing the code itself. Measured first-pass rate on the routed tier:
**89%** (n=9, median wall clock 3.4 min).

## 🚀 Quick start

**Requirements:** Claude Code · Node.js >= 18 · git · one executor CLI logged in
([codex](https://github.com/openai/codex) **or** `claude` — a plan subscription is fine,
**no API key needed**).

Install from inside Claude Code:

```
/plugin marketplace add MisterRaindrop/agent-router-cc
/plugin install router@agent-router-cc
/reload-plugins
```

No install step beyond that, no config: `dist/router.js` is a committed, dependency-free
bundle, and router auto-creates a gitignored `.router/` on first use. **No `init`, no
policy file, no commit.**

Then just talk to Opus, plan the change together, and:

```
/router:go
```

To update later: `/plugin marketplace update agent-router-cc`, update **router** from the
`/plugin` menu (or `claude plugin update router@agent-router-cc`), then `/reload-plugins`.

## 📐 The shape of a run

```
everyday task:   plan with Opus in conversation  →  /router:go  →  /router:review (optional)
                                                    packages, dispatch,    independent, strict
                                                    gate, review, land     review of landed code

large feature (opt-in, YOUR call — router never judges task size):
  /router:design        →  /router:design-review (opt.)  →  /router:plan       →  /router:go
  clarify + research;      independent adversarial pass;     the how: steps,      executes the
  a DESIGN.md you           every objection adjudicated       task breakdown,      approved plan
  approve section           by you, nothing auto-applied      verification;        verbatim
  by section                                                  you approve
```

`/router:go` pauses at exactly **three points** — nothing happens without you (when it
executes a Plan approved via the design flow, the breakdown confirmation is skipped: you
already approved that list at `/router:plan`):

1. **Confirm the task breakdown.** Every package is shown with its file scope and target
   model before anything runs.
2. **Unclear tasks stay with you.** Anything needing real judgment or design, Opus does
   with you directly instead of handing it to a cheap model.
3. **Approve before merge.** Nothing lands in your branch without your say-so.

In between, each *clear* package runs on the quota-picked executor in an isolated
worktree — independent packages **concurrently**, so the wall clock is the slowest one,
not the sum (measured: 26s + 31s ran as a 32s batch; 234s + 244s ran as 244s). At the end
Opus runs a **mandatory acceptance pass**: full-chain CI in your real environment, reading
the whole output itself, before reporting done.

## 🗂️ Task contracts: tier and risk are different questions

Every package is a machine contract at `.router/tasks/<id>/task.yaml`, authored by the
main session from your conversation — there is no global policy file:

```yaml
# .router/tasks/q2/task.yaml
title: usage --json emits one document per run
plan_id: issue-1234
allowed_globs: ["src/app/**", "test/usage-*.test.ts"]
max_changed_lines: 400   # size it to the real diff shape: tests and deletions count too
tier: weak               # capability needed:  weak | strong | critical
risk: normal             # review it earns:    low  | normal | high   (one-way: only ever raised)
verify: [["npm", "test"]]
depends_on: []
```

| field | question | decides |
|---|---|---|
| `tier` | how much **capability** does this need? | which model and reasoning effort |
| `risk` | how bad if it is **wrong**? | how much independent review it earns |

A mechanical change to an authentication path is `weak` **and** `high`. The CLI raises
`risk` from deterministic signals (line count, invariant paths touched) and **never lowers
it**; quota never demotes a task to a weaker tier.

## 🤖 How models are picked

| tier | codex | claude |
|---|---|---|
| `weak` | gpt-5.6-terra · medium | haiku · medium |
| `strong` | gpt-5.6-sol · high | sonnet · high |
| `critical` | gpt-5.6-sol · xhigh | opus · xhigh |

1. Decide the **minimum capability tier** the task actually requires — the one routing
   decision that matters.
2. Within the tier, both executors are candidates; **real remaining quota** picks (codex
   usage read from `~/.codex/sessions`, claude from an optional statusline snapshot). More
   headroom goes first; a real 429 switches to the other. Quota reorders *within* a tier —
   it never demotes.
3. Reasoning effort is matched to the work, not maxed: `medium` for mechanical
   implementation, `high` for real capability, `xhigh` reserved for `critical`.
4. The orchestrator's own model appears **only** at `critical` — spending it as an
   ordinary executor would consume the very budget routing exists to protect.

Override any slot in `.router/models.yaml`; `router models` prints the resolved table.
Nothing ever edits it for you.

## 🛡️ Two kinds of gate

**Environment-free gates** — run by the CLI on every diff, the deterministic guarantees a
cheap model cannot fake:

| check | meaning |
|---|---|
| `diff_applies` | applies cleanly onto the base commit |
| `scope` | only `allowed_globs` changed, under the line cap, no test deletion |
| `secret_scan` | no keys or secrets in the added lines |
| `exec_bit` | a new script carries the executable bit when its siblings do |
| `verify` | the task's own `verify` command(s) exited 0 |

`verify` answers a mechanical question — *did it run and pass* — never *is it right*.

**The real gate** is a property of the project, declared once in `.router/gate.yaml`:

- **`mode: worktree`** — build and tests run inside each run worktree; implementation and
  verification are both fully parallel.
- **`mode: queue`** — for the project whose environment exists **once** (one build
  directory, a container bound to a fixed host path): executors write code in parallel but
  don't build; `router gate` feeds commits one at a time into your own checkout under an
  exclusive lock — refusing if tracked files are modified, verifying on the current
  integration head, keeping the build cache warm (never `git clean`), and restoring your
  branch. A gate that fails is re-run on the pre-merge head, so a project that was already
  red doesn't get blamed on the change.

## ⚔️ The design flow — two documents, approved in order

For a large feature — cross-module work, real approach trade-offs — the user opts in with
`/router:design`. Exactly **two documents**, each yours to approve:

- **`/router:design` → `DESIGN.md`** (why / what / what NOT / chosen approach / risks /
  acceptance criteria). One clarifying question at a time, interleaved with **code
  research** (symbol index, `file:line` evidence); 2–3 approaches with trade-offs and the
  rejected ones recorded; then the document is drafted **section by section**, each section
  confirmed by you before the next is written. No document is generated while the
  conversation is still open — that is where models start guessing.
- **`/router:design-review`** (optional, any rounds) — an **independent model** attacks the
  Design: critique printed verbatim, written in your conversation language, every objection
  carrying a `confidence`, uncertainty phrased as questions rather than assertions, and the
  reviewer must read *Alternatives considered* so it never re-proposes a road you already
  closed. **Each objection is adjudicated by you** — accept / reject / discuss, recorded in
  `DECISIONS.md`; nothing touches the document before your verdict. Runs in the background,
  truncation-guarded, session resumed across rounds.
- **`/router:plan` → `PLAN.md`** (how: steps, task breakdown, dependencies, verification
  matrix, rollout) — derived only from an approved Design and bound to its revision: a
  Design revision drops the Plan back to draft. You approve a summary; `/router:go` then
  executes it verbatim. Everyday tasks skip all of this and use `/router:go` directly.

## 🔍 `/router:review` — the last gate after green

Green tests are the **precondition, not the evidence** — the tests themselves are under
review. Two lenses, ideally two different models, 16 fixed dimensions:

- **Architect lens (F1–F7):** was the need actually solved; should this change exist at
  all; reuse vs reinvent; root cause vs symptom; simpler-but-still-correct; structure and
  integration; independent correctness judgment that does not trust the author's tests.
- **Senior-dev lens (D1–D9):** robustness beyond the tests; failure modes (no silent
  fallbacks); **complexity/over-design** ("an explanation longer than the code is
  complexity dressed as prose"); test design quality; readability; project-style
  consistency; comments and shortcut labeling; security; performance sense.

Verdicts are **two axes, never collapsed**: `code_health` (did we find defects?) and
`assurance` (is it actually proven?). "No defect found" is not "proven". Blocking must be
earned; a clean diff gets a plain "ship it". Mechanical checks (formatting, import order)
go to lint/CI, not to the LLM.

## 🧰 Commands

| command | what it does |
|---|---|
| `/router:go` | **top-level** — execute the plan you just agreed on (or an approved `PLAN.md`, verbatim); drives everything below |
| `/router:design` | opt-in for large features — clarify, research, draft a `DESIGN.md` you approve section by section |
| `/router:design-review` | adversarial second opinion on the Design — you adjudicate every objection; nothing auto-applied |
| `/router:plan` | turn the approved Design into `PLAN.md` — steps, task breakdown, verification; you approve |
| `/router:review` | strict, independent two-lens review of the landed code |
| `/router:dispatch <id...>` | run tasks on quota-picked executors, concurrently, to gated diffs |
| `/router:resume <id>` | send a failure back to that task's own executor session |
| `/router:land <id...>` | merge PASSED dispatches into your working branch |
| `/router:gate <id...>` | verify commits one at a time in your own checkout (queue mode) |
| `/router:result <id>` | per-check verifier report and log tail for a run |
| `/router:list` | tasks with their last status and whether a worktree remains |
| `/router:models` | the resolved model-tier table (bundled default + overrides) |
| `/router:usage` | cost vs an all-strongest-model baseline; `--routing` for routing evidence |
| `/router:symbol` | out-of-context symbol index — locate code without reading whole files |
| `/router:setup-statusline` | wire claude-side quota reads into Claude Code's statusLine |

**[docs/workflow.md](docs/workflow.md)** is the whole protocol end to end — work packages,
tiers and risk, both gate modes, what the executor owes back, and when to resume a
session. See also **[docs/quickstart.md](docs/quickstart.md)** and a runnable task in
**[examples/minimal/](examples/minimal/)**.

## 🔒 Isolation & credentials

- Executors run in fresh `git worktree`s under `.router/`, supervised with a wall timeout
  and a stall watchdog; their output never enters the orchestrator's context, and no MCP
  server from your session is inherited.
- Codex uses its `workspace-write` sandbox. Claude runs in plain `acceptEdits` (never
  `bypassPermissions`), and gets `Bash` **only** when the task declares a `verify`
  command — the grant is that exact command plus its program+subcommand prefix, not a shell.
- Executor CLIs receive only the login-session context needed for plan auth plus an
  explicitly configured provider key — never your full parent environment.
- Every run ends with a delivery report (`gate_ran`, `scope_drift`, `escalate_review`); a
  missing header is a contract violation, and a contract conflict (`CONTRACT_CONFLICT`)
  stops the run and returns the decision to you.

## 🛠️ Development

```sh
npm ci
npm run check     # tsc --noEmit + core-purity guard + node --test
npm run build     # bundle src/ -> dist/router.js (commit the result)
```

`src/` is layered `domain -> core -> io -> app -> cli`. `core/` is pure (no fs,
child_process, process, clock, or randomness — enforced by `npm run check:deps`), which
keeps the gate logic deterministic and unit-testable.

## 🤝 Contributing

Contributions are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the build,
test, and PR workflow, **[ROADMAP.md](ROADMAP.md)** for where the project is headed, and
**[CHANGELOG.md](CHANGELOG.md)** for what each release changed. Security issues go
through **[SECURITY.md](SECURITY.md)**, never public issues.

## 📄 License

Apache-2.0.
