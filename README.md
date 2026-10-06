<div align="center">
  <img src="docs/assets/logo.svg" width="112" alt="router logo"/>

  <h1>router</h1>

  <p><b>Design before the code. Proof after it.</b></p>

  <p>A Claude Code plugin for writing code with discipline — settle the design before you
  write, build in commits a human can review, verify in your real environment, and let a
  different model attack the result.</p>

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

Asking an agent to "build this" goes wrong in predictable places: it guesses the details nobody
discussed, and it reviews its own work with its own blind spots. router puts an opt-in stage at
each of those places. Building itself is left alone: `/router:go` is the main session writing
code exactly as it would without router.

|                        | Prompting the agent directly       | With router                                                    |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------- |
| **Before the code**    | the model guesses what you meant   | `brainstorm` questions the idea; `design` settles it section by section, you approve each |
| **The design**         | reviewed by the model that wrote it | `design-review`: an independent model attacks it, you adjudicate every objection |
| **After the code**     | trust the author's tests           | `review`: two lenses from another model; tests are under review too |

router **never merges**. You decide what lands.

## 🚀 Quick start

**Requirements:** Claude Code · Node.js >= 18 · git. Optional: the
[codex](https://github.com/openai/codex) CLI, logged in (a plan subscription is fine, **no API
key**) — the independent reviewer, and a second writer when you ask for one.

Install from inside Claude Code:

```
/plugin marketplace add MisterRaindrop/agent-router-cc
/plugin install router@agent-router-cc
/reload-plugins
```

No install step beyond that, no config: `dist/router.js` is a committed, dependency-free
bundle, and router auto-creates a gitignored `.router/` on first use. **No `init`, no
policy file, no commit.**

Then talk the change through with the main session, and:

```
/router:go
```

### On another machine, or from a script

The same two steps without opening Claude Code. The repository is public, so no SSH key and no
`gh` login are needed:

```bash
claude plugin marketplace add MisterRaindrop/agent-router-cc
claude plugin install router@agent-router-cc -y      # -y is required when stdin/stdout is not a TTY
```

Restart Claude Code to apply, then check what landed:

```bash
claude plugin list | grep -A3 router     # → Version, Scope, Status: ✔ enabled
```

### Updating

```bash
claude plugin marketplace update agent-router-cc     # refresh the marketplace cache first
claude plugin update router@agent-router-cc
```

Inside Claude Code the equivalent is `/plugin marketplace update agent-router-cc`, then update
**router** from the `/plugin` menu, then `/reload-plugins`.

Command files (`commands/`, `skills/`, `hooks/`) are read once at startup, so a version that
changes one of them needs the restart. The CLI bundle does not: `dist/router.js` is spawned fresh
on every call.

## 📐 The shape of a run

```
everyday task:   talk it through  →  /router:go  →  /router:review (optional)
                                     the main session   independent, strict
                                     writes it, as it   review by another
                                     would without      model
                                     router

large feature (opt-in, YOUR call — router never judges task size):
  /router:brainstorm  →  /router:design  →  /router:design-review (opt.)  →  /router:go
  question the idea;     clarify +          independent adversarial          build against
  compare with how       research; one      pass; every objection            the approved
  others solve it;       DESIGN.md you      adjudicated by you,              DESIGN.md
  argue the case         approve section    nothing auto-applied
  against                by section
```

`/router:go` adds no steps of its own: no confirmation round, no mandated commit shape, no closing
checklist. It reads an approved `DESIGN.md` when there is one, hands a part to codex when you name
it, and otherwise just writes the code. It never merges or pushes.

Why so thin: on real ClickHouse bugs, a mandatory confirm / reproduce-first / verify-everything
flow fixed exactly as many bugs as plain Claude Code and cost about 1.4× the time and money.

## ✍️ Letting codex write part of it

Say "let codex write the parser" and that part goes to codex instead of the main session:
`router write` launches it on your current branch under its `workspace-write` sandbox, with a
brief the main session wrote, and `router resume` sends feedback back to the same session so it
keeps what it learned about the repository. The main session reviews those commits exactly as it
reviews its own — a writer's report is a claim, not evidence.

That is the only delegation left. Until 0.15.0 router dispatched *every* package to a separate
executor, picked by remaining plan quota, under a lock, behind mechanical gates. It was removed
because this project's own records showed where defects were actually caught — the main session
reading the whole diff, running the real build, and an independent review — and none of that
depended on someone else writing the code. See `DEPRECATIONS.md`.

## ⚔️ The design flow — approved in order

For a large feature — cross-module work, real approach trade-offs — the user opts in. Every
document is yours to approve:

- **`/router:brainstorm` → `BRAINSTORM.md`** (optional first stage, for when the *goal* is not
  settled yet). Every round owes you four things: a question about **why**, from an angle you
  have not considered; a comparison with how other products actually solve this; the **strongest
  argument against building it at all**; and at least one alternative you did not propose. Your
  approach is the best one you have, not necessarily the best one there is. `status: rejected` is
  a real outcome — a killed idea with a documented reason is this stage succeeding, and the
  record is what stops it coming back in three months with nobody remembering why.
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
Its last section, the **verification matrix**, maps every acceptance criterion to where it will
actually be proven — with `unverified` kept visible instead of papered over by a test that does
not test it. There is no separate work plan; slicing is left to whoever builds it.

## 🗺️ `/router:explain` — read the feature as a system

After code exists, `/router:explain <commit>` (or an explicit range or `--working-tree`) writes a
self-contained design page under `.router/explanations/`. The opening gives the verdict, then one
complete architecture diagram shows both where the feature sits and the path that makes it work.
Small step numbers carry any load-bearing order inside that same figure; a problem strip appears
only when the evidence changes the verdict.

This is deliberately not a PR summary or a proposed `DESIGN.md`: it explains the system that the
code produced, without making the reader reconstruct it from a file list.

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
| `/router:go` | **top-level** — build the change you just agreed on, the way the main session would without router (against an approved `DESIGN.md` when there is one; codex writes a part when you name it) |
| `/router:brainstorm` | question an idea before designing it — compare it with how others solve it, argue the case against, propose the option you were not offered |
| `/router:design` | opt-in for large features — clarify, research, draft a `DESIGN.md` you approve section by section |
| `/router:design-review` | adversarial second opinion on the Design — you adjudicate every objection; nothing auto-applied |
| `/router:review` | strict, independent two-lens review of the change |
| `/router:explain [scope]` | explain implemented code as a standalone page with a concise verdict and one complete design diagram; accepts a commit, range, or `--working-tree` |
| `/router:resume <id>` | send feedback to a codex write's same session |
| `/router:symbol` | out-of-context symbol index — locate code without reading whole files |

The CLI behind them: `router write` / `resume` (the codex writer), `router plans` (every plan and
its stage), `router models` (the writer and reviewer models), `router symbol`, `router doctor`,
`router supervise`. The plugin does not put `router` on your `PATH` —
[docs/quickstart.md](docs/quickstart.md#the-cli) has the one-line alias, or just ask the main
session to run it.

**[docs/workflow.md](docs/workflow.md)** is the whole protocol end to end.

## 🔒 The codex writer's limits

- **It starts only into a clean tree.** Uncommitted changes make `router write` refuse; it never
  commits, stashes or moves your work for you.
- **It commits on your current branch** and is told not to merge, rebase, push or rewrite
  history. A resume refuses on any other branch than the one the write ran on.
- **codex's `workspace-write` sandbox**: it can edit and commit in the checkout and nothing
  outside it.
- **A minimal environment**: only the login-session context plan auth needs — never your full
  parent environment, so unrelated credentials (`AWS_*`, tokens) do not reach it.
- **It cannot drive router.** A nested `router` that writes refuses outright, so a writer cannot
  launch a second writer into the same checkout.
- **Supervised**: a wall timeout and a stall watchdog, its process group killed on exit; its
  output goes to `.router/writes/<id>/codex.log`, never into your session's context.
- **A resume that does not re-attach says so.** If codex reports a different session — or none —
  the run is flagged `RESUME DID NOT RE-ATTACH` and treated as fresh, not as a continuation.

## 🛠️ Development

```sh
npm ci
npm run check     # tsc --noEmit + core-purity guard + node --test
npm run build     # bundle src/ -> dist/router.js (commit the result)
```

`src/` is layered `domain -> core -> io -> app -> cli`. `core/` is pure (no fs,
child_process, process, clock, or randomness — enforced by `npm run check:deps`), which
keeps its logic deterministic and unit-testable.

## 🤝 Contributing

Contributions are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the build,
test, and PR workflow, **[ROADMAP.md](ROADMAP.md)** for where the project is headed, and
**[CHANGELOG.md](CHANGELOG.md)** for what each release changed. Security issues go
through **[SECURITY.md](SECURITY.md)**, never public issues.

## 📄 License

Apache-2.0.
