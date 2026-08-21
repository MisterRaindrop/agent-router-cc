---
description: Adversarial review of a Design by an independent model -- every objection is adjudicated by the user, one by one; nothing is ever auto-applied
allowed-tools: Bash, Read, Write, Task, AskUserQuestion
---
Get an independent, adversarial second opinion on a **`DESIGN.md`** -- the approach, its
risks, whether a simpler road exists. This reviews the *design*, not implementation steps
and not task breakdown (those live in `WORKPLAN.md`, which gets no adversarial pass). Optional,
user-invoked, any number of rounds; run it **before** the Design is approved. If the Design
was already approved, any change accepted here bumps its revision and requires re-approval.

**You do not review your own design.** Launch an independent reviewer -- a different model
from yourself: take the first entry of the `review` array from
`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models --json` and launch it via
`codex exec -m <model> -c model_reasoning_effort=<effort>` with that entry's effort.
Independence is the point: it catches blind spots a self-review shares.

**Run it in the background**, redirecting full output to
`.router/plans/<plan_id>/critique-<round>.md` -- a review takes minutes; tell the user it is
running and continue. Guard against truncation exactly as a long critique demands: the file
is the complete record, read it back in chunks, and if generation was cut off, resume the
reviewer to finish -- never present a truncated critique as complete. Tell the reviewer which
`plan_id` it must be looking at; if the document it reads disagrees, it must refuse rather
than review the wrong design. Respect the plan's `spec.lock` (the per-plan lock, historical
name): if another session holds it, say so and stop.

## The reviewer's brief

Hand over the full `DESIGN.md` plus this instruction (translate the bracketed language rule
to a concrete language name before sending):

> You are a demanding staff engineer reviewing a PROPOSED DESIGN -- not code, not a task
> breakdown. Be adversarial: attack whether the approach is correct, what risks or failure
> modes are hidden, whether a simpler design would do, and whether it fits this codebase's
> constraints. Judge against "does this improve the system", not perfection. Rules:
>
> - Read the WHOLE document first, including **Alternatives considered**. Never propose an
>   alternative that section already rejects -- if you believe a rejection is wrong, say so
>   explicitly and quote the recorded reason you are disputing.
> - When you are unsure about a constraint or a fact, phrase it as a QUESTION -- never as an
>   assertion of error. Cite specifics; name the concrete consequence, never "best practices".
> - Emit each objection as `{severity: blocking|advisory|nit, confidence: high|medium|low,
>   argument: <specific problem + concrete consequence>, suggestion: <concrete fix>}`.
> - **End with a section titled "Where I could not follow this document."** List every place you
>   had to guess: a term used without explanation, a sentence you had to read twice, a reference
>   to something the document assumes you know. Quote the passage and say what you took it to
>   mean. Report nothing only if there was genuinely nothing -- an empty list from a reader who
>   has never seen this project before is a real result, and so is a long one.
> - If the design is sound, say so plainly instead of manufacturing objections.
> - Write every `argument` and `suggestion` in **[the language the user is conversing in]**.

**Why the readability section is part of an adversarial review and not a style pass.** The
failure it catches is the curse of knowledge: a document written by someone who already knows the
project, read later by someone who does not -- including its own author, three months on. That
cannot be measured mechanically. Sentence length and "is a term defined on first use" are exactly
the checkable properties, and exactly the ones that do not matter; what matters is *assuming the
reader knows your vocabulary*, which only an outside reader can detect. The reviewer is already
that reader -- it has no access to this project's conventions -- so the finding is nearly free
here and unavailable anywhere else.

Treat those findings as findings: they go through the same adjudication as any other objection.
An explanation the user judges unnecessary is a `reject` with a reason, not a silent skip.

## Adjudication -- mechanism, not promises

The historical failure this command exists to prevent: a reviewer objection that was wrong
being silently applied, breaking a correct design. So the judge protocol is mechanical:

1. Print the critique **verbatim** (from the file). Then present the objections **one at a
   time**, ordered by severity -- nits may be batched -- each with explicit actions:
   **accept / reject / discuss**.
2. Record every verdict in `.router/plans/<plan_id>/DECISIONS.md`: round, objection summary,
   verdict, the user's reason when given.
3. **Zero edits to `DESIGN.md` before its verdict exists.** Applying an objection the user
   did not accept -- or "improving" the design on the reviewer's say-so -- is a contract
   violation, not initiative.
4. Edits implementing accepted objections cite their `DECISIONS.md` entry, and the section
   they touch goes back through the user's section confirmation.
5. The user decides how many rounds and when to stop. There is no automatic convergence and
   no auto-accept threshold -- a unanimous reviewer is still just one opinion.

## Across rounds

The reviewer is a persistent session: on the next round, **resume it** and send only what
changed since its last critique -- it remembers its objections and can check whether they
were actually addressed. If the installed reviewer CLI cannot resume, re-run it with the
previous critique attached as context.
