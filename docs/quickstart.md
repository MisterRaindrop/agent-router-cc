# Quickstart

router is a Claude Code plugin for writing code with discipline. You and the main session agree
on the change; the main session writes it in units you can review, verifies it in your real
environment, and hands it back before anything merges. A different model can attack the design
before it is built and the code after. There is no `init` and no config: router creates a
gitignored `.router/` on first use.

## Prerequisites

- Claude Code, with router installed (`/plugin install router@agent-router-cc`).
- Optional: the `codex` CLI, logged in (a plan subscription is fine; no API key). It is used for
  two things only: as the independent reviewer in `/router:design-review` and `/router:review`, and
  as a second writer when you ask for one. Without it, both reviews fall back to a Claude reviewer.

## The loop

Talk the change through with the main session, then:

```
/router:go
```

It pauses at three points:

1. **Confirm the slicing** -- once, for the whole feature: the functional units it will commit,
   what each touches, how each will be verified. You say go.
2. **Unclear work** -- anything that needs a judgment the plan did not make, it settles with you
   before writing it.
3. **Hand back** -- it reads its own complete diff, runs the full chain in your real environment
   **exactly as your CI invokes it and without fixing the environment to make it pass**, and
   reports. That is the *floor*. `/router:review` is the **next stage** -- a strict, independent
   review by another model -- so you can confirm the direction first instead of paying for a
   strict review of the wrong thing.

Merging is yours. router never merges, pushes or switches branches.

For a **large feature** -- cross-module work, real approach trade-offs -- you can opt into the
design flow first: `/router:brainstorm` questions the idea itself when the goal is not settled;
`/router:design` clarifies and researches, producing a `DESIGN.md` you approve section by section
(its last section maps every acceptance criterion to where it will actually be proven);
`/router:design-review` gets an independent adversarial second opinion where you adjudicate every
objection. Whether a change deserves that is your call -- router never judges task size.

## Letting codex write part of it

Say so -- "let codex write the parser" -- and `/router:go` hands that part to codex instead of
writing it itself:

```
router write <id> --brief <file> [--model M] [--effort E]   # codex commits on your current branch
router resume <id> --feedback "<everything that is wrong>"  # back to the same codex session
```

The writer runs under codex's `workspace-write` sandbox with a minimal environment, refuses to
start over uncommitted changes, and records what it did in `.router/writes/<id>/`. The main session
reviews its commits exactly as it reviews its own. `references/codex-writer.md` says what a brief
contains and why resumes are capped at two.

## The CLI

`/router:go` drives the CLI for you; you can also run it directly:

```
router write | resume    # the codex writer, above
router plans             # every plan under .router/plans and the stage its documents declare
router models            # the writer and reviewer models (bundled default + .router/models.yaml)
router symbol <sub>      # the out-of-context symbol index (also /router:symbol)
router doctor            # self-check the symbol index's parser
router supervise ...     # run a long command under the watchdog (used by the reviews)
```

**Finding `router` when you installed only the plugin.** The plugin does not put it on your
`PATH`; the bundle lives in the plugin cache, under a directory named after the version, so the
path moves on every update. Resolve the newest one instead of hard-coding it:

```bash
alias router='node "$(ls -d ~/.claude/plugins/cache/agent-router-cc/router/*/ | sort -V | tail -1)dist/router.js"'
```

Or ask the main session to run one -- it will locate the bundle the same way.

**[docs/workflow.md](workflow.md)** has the whole protocol.
