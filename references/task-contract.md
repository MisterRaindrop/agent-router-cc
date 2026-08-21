# Authoring a task contract

How to write the files one `/router:go` run hands its executor. `commands/go.md` owns the flow;
this owns the detail, so the flow stays readable.

**Terms.** A **work package** is what one executor does in one session: the largest coherent
chunk it can finish from its contract alone, carrying a test story of its own. The **contract**
is `.router/tasks/<id>/TASK_CONTRACT.md` plus `.router/tasks/<id>/task.yaml` -- the only things
the executor is given besides the code. A **gate** here means the project's own build-and-test
command; router also runs *environment-free gates* on the diff, which is a different thing (see
`glossary.md`).

## Package size: as few as the dependency structure allows

One `go` run dispatches ONE package. Split across runs only where you must -- a genuine
dependency, an unrelated area of the codebase, or work too large for one session.

The reason is measured, not stylistic. On a real plan, five executor runs took 12.8 minutes of
executor time between them, while the plan as a whole took about three hours across roughly 317
orchestrator turns -- and five cold starts re-explored the same repository five times, 1.88M
executor input tokens for a roughly 400-line feature. Every extra package costs a fresh cold
start plus a review round trip of yours.

**This is not the same size as a commit.** Inside its one session the executor commits **one
functional unit at a time**, each with its own tests, because a human reviews one thing at a
time. Adding a storage access method is file IO, then the storage format, then the storage
architecture: three commits, one package. Two rulers, two jobs -- the dispatch unit is sized to
avoid cold starts, the commit is sized to be reviewable.

## `task.yaml`

Create it with `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" new <id> --title "<title>"`
(`<id>`/`<title>` are placeholders), then edit:

- **`allowed_globs`** -- the smallest scope that still covers the whole package.
- **`tier`** -- `weak` for mechanical work, `strong` where more capability is needed, `critical`
  for security, concurrency, or an architectural invariant. Decide the **minimum capability the
  package actually requires**; router picks the executor by real quota *within* that tier and
  takes model + reasoning effort from the tier config (`router models` shows it). Router never
  judges difficulty itself, and quota **never** demotes a task to a weaker tier.
- **`risk`** -- `low | normal | high` per `assurance-core.md`. This decides how much independent
  review the package earns, **not** how capable the executor is. Different questions: a
  mechanical change on an auth path is `weak`/`high`.
- **`max_wall_minutes`** -- fit the package; a bigger package needs a bigger budget.
- **`max_changed_lines`** -- budget implementation **plus tests plus deletions**, then leave
  headroom. This cap has rejected correct work twice, both times because it was sized to the
  implementation alone: a package whose contract demanded unit, stateless *and* integration
  coverage came in at 1181 changed lines against a cap of 1000 -- about **40% of the diff was
  tests**, and 93 of those lines were deletions, which count too. A rejection is not free: the
  executor has already done the whole job, and recovering costs a `resume` whose input is larger
  than the original run's. Never enlarge the cap silently -- the value and the reason go in the
  contract where the final review can see them.
- **`verify`** -- see the gate section below.
- **`plan_id`** -- the same identifier on **every** package of one plan, so `router usage` can
  group it and its artifacts live together under `.router/plans/<plan_id>/`. Pick something that
  still means something next month, in this order: the issue or PR number (`issue-90731`), else
  the branch name with `/` replaced by `-` (`feat-p2-probe-and-routing`), else a dated kebab
  description (`spec-cost-2026-07-31`). It doubles as a directory name, so it must be path-safe;
  the schema enforces that rather than quietly creating a nested directory. **Decide it once and
  copy it verbatim** -- a branch can be renamed mid-flight, and re-deriving the id would split
  one plan's history in two.
- **`worker: { kind, model, effort }`** -- an explicit pin, overriding the tier. Always fully
  specified; see the next section.

Also note the current ISO timestamp (`date -u +%Y-%m-%dT%H:%M:%SZ`) as the plan's start -- the
final step passes it to `orchestrator-usage`.

## Pinning an executor

The pin is always **fully specified**, because each field changes what runs: `kind` picks the
launcher (`claude --model <slug>` vs `codex exec -m <slug> -c model_reasoning_effort=<effort>`),
and **an omitted `effort` silently falls back to the provider default**, which on the codex side
is a real capability downgrade. Never write a partial pin.

Resolve the three fields like this, and state the result before dispatching:

- **Nothing specified** -> `kind: claude`, with model and effort from the **`critical` row** of
  `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models --json` for that kind. Read the table; do
  not hardcode a slug -- the table is the source of truth, and a stale slug in a prompt is
  exactly what the `model_mismatch` detector exists to catch.
- **A family named** ("用 codex 跑", `--codex`) -> the same rule against that kind's `critical` row.
- **A model slug named** -> look it up in `models --json` to get its `kind`; keep that kind's
  `critical` effort unless an effort is named too. If the slug is in neither family, **ask** --
  never guess which launcher a slug belongs to.

**The `critical` row is the floor, per family.** One executor takes a whole package, so it gets
that family's most capable configuration. The user may deliberately go lower ("用 sonnet 就行"),
which is honoured verbatim and recorded in the contract -- but router **never** lowers it on its
own: quota pressure, a 429, or a launch failure **fails loudly** rather than quietly demoting.

**Observability gap on the codex side.** The live `recent_action` field is extracted from the
claude executor's `stream-json` events. A codex run still reports phase, elapsed-vs-budget, log
activity and the stall countdown -- but not "which file it is editing right now". Say so when
the user pins codex, rather than letting them wonder why the statusline is less specific.

## `TASK_CONTRACT.md`

**The contract is a copy, not a composition.**

- **An approved work plan exists** -> verify its frontmatter says `status: plan_approved`
  (refuse otherwise), then build `TASK_CONTRACT.md` as a compact YAML header (globs, `verify`,
  worker pin, budgets, `plan_id`, `plan_revision`, `plan_sha256`, `design_sha256`) followed by
  the **entire `WORKPLAN.md` verbatim and then the entire `DESIGN.md` verbatim**, via shell
  concatenation. Zero re-authoring -- byte-identical is the test -- so the contract is an
  immutable snapshot of the approved revision, and later edits cannot reach a dispatched
  contract.

  Both documents, because they answer different questions. The work plan says what to do, in
  what order, and how it will be verified. The design says **why it is built this way, where the
  boundaries are, and which invariants may not break** -- and that is the part an executor can
  never recover by reading code. `BRAINSTORM.md` is deliberately NOT included: it records
  counter-evidence and rejected directions, so handing it over means handing the executor a pile
  of ideas that were decided against.

- **No plan** (an everyday task) -> the compact template: the **seven faces** at 1-3 lines each,
  roughly 40 lines. The executor is a strong model; precision beats prose.

The seven faces: goal; invariants; frozen interfaces and dependencies; definition of done
**including its own tests**; blast radius; stop conditions; version binding. **If you cannot
write all seven, it is not a task but a decision** -- keep it and do it with the user. Rate its
risk per `assurance-core.md`; when unsure, escalate, and never downgrade a tier to justify
running fewer checks.

**`TASK_CONTEXT.md` is not written.** Measured on a small two-file task, the navigation summary
made the executor's input **21% larger** (474.7k vs 392.6k) for identical quality -- an
executor's input is re-sent every turn, so the summary is paid every turn while its benefit is
one-off. The loader still reads one if a file is present, which is what keeps an existing task
working; nothing writes one. (This is the single answer to a question the repository used to
answer three different ways.)

## The deterministic gate (`verify`)

Where the real build and tests can run is a property of the project, not of the task, so decide
it once and **check it empirically once**.

The executor now works in the repository root on a `router/<task-id>` branch, so it has the same
build environment you do: warm dependencies, warm object files, a real configure result. Put the
project's fast gate in `verify:` for every package (e.g. `verify: [["npm", "run", "check"]]`) --
the diff then arrives already proven to compile and pass, and your review goes on judgment
instead of on breakage.

For a project whose build is expensive or configuration-heavy, put it in `.router/gate.yaml`
instead of in each task:

| Key | What it does |
|---|---|
| `gate` | the incremental build-and-test command |
| `clean_gate` | the full-rebuild command |
| `clean_triggers` | globs whose change forces `clean_gate` instead of `gate` |
| `reset` | run before verification, to clear state a previous build left behind |
| `env` | extra environment variable names the gate needs |
| `lock_wait_minutes` | how long to wait for the checkout when another run holds it |
| `gate_wall_minutes` | hard ceiling on one gate command |

When `gate.yaml` declares commands they **replace** `verify` -- it describes how the project
builds, `verify` describes one task, and running both builds twice. Any **deletion** in the diff
forces `clean_gate` regardless of triggers: an incremental build keeps a stale object for a
source file that no longer exists and nothing tells it to drop it.

If `.router/gate.yaml` does not exist yet, **work the build out yourself** from
`package.json` / `Makefile` / the CI workflow / `Dockerfile`, propose the whole config for the
user to confirm once, and write it. Never make them author YAML, and **never infer a `reset`
command** -- that is the one that wipes state.

Either way `verify` is mechanical: it answers "did it run and pass", never "is it right".

## What the executor may and may not do

Stated here because the permission grant enforces exactly this list, and a contract that asks
for more will simply stall.

- **Commits its own work**, one functional unit at a time, with `git add` and `git commit`.
  Committing does not wait for green -- the gate runs once at the end, so an intermediate commit
  that does not build yet is expected.
- **Leaves nothing uncommitted.** An uncommitted file never enters `base_sha..HEAD`, so every
  gate would pass without seeing it. The run fails on leftovers rather than sweeping them up.
- **May not** `checkout`, `reset`, `rebase`, delete a branch, or push. The grant is a git
  *subcommand* allowlist, so an attempt is refused rather than obeyed.
- **May not touch `.router/`.** Orchestration state belongs to the dispatching session; a nested
  `router` invocation refuses (`ROUTER_EXECUTOR_SANDBOX`).
- **May not provision the environment** to make a check run: no installing dependencies, no
  creating directories, no editing configuration. An honest "did not run" is useful; a claimed
  pass that never ran is not.
- **May not change the plan or the contract.** If the code contradicts it, the executor stops and
  reports `CONTRACT_CONFLICT` with evidence.

## `CONTRACT_CONFLICT`

A conflict means **the plan is wrong, not the code**. The executor is forbidden to quietly work
around a bad contract; when it reports one, nothing lands. Read its evidence, decide the depth --
this contract only, this package plus its declared dependents, or the whole milestone -- and take
it to the user. Invalidate only the affected subgraph; a conflict is not a reason to redo the
plan.

## The delivery report

The executor's final message is a few readable sentences -- what it implemented, which modules it
touched, which checks it ran and their results, anything risky or unresolved -- followed by
exactly this block:

````
```router-delivery
task: <id>
plan_revision: <revision or none>
gate_ran: true|false
scope_drift: true|false
escalate_review: true|false
```
````

`gate_ran` is whether the gate actually ran and passed. `scope_drift` is whether anything outside
the scope had to be touched. `escalate_review` is whether this deserves a closer look than usual.
All three are **read, not audited** -- so `delivery_header: missing`, `gate_ran: false` or
`scope_drift: true` is a reason to look harder, never "probably fine".

## Session policy

`resume` continues the *same* task: same branch, same `base_sha`. For a **different** task always
start a fresh session -- a reused one diffs against a stale base, so the next diff would carry
the previous task's changes and destroy "one task, one auditable diff", and it revives plans it
already discarded.

**Wanting to reuse a session across tasks means the packages were split too finely; merge them.**
Warm repository knowledge travels as artifacts, not sessions: the symbol index
(`/router:symbol`) gives a fresh session the same knowledge without inheriting stale beliefs.

Cap resumes at **two attempts**, then take the package over or bring it to the user; re-dispatch
only when the contract itself was wrong. Send a **precise error summary, not a log dump**, and
send everything you found in **one** resume -- an executor's session is re-sent in full every
turn, so each extra round pays the whole accumulated prefix again. Measured across three attempts
of one task: **7.69M -> 9.18M -> 9.35M** input tokens, where the third changed *eight lines* and
still cost more input than the original 1181-line implementation. **For a few mechanical lines,
edit them yourself** -- a resume for two comment changes cost about what the whole implementation
cost.
