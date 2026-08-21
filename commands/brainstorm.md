---
description: Question an idea before designing it -- ask why, compare it against how others solve it, argue the case against, and propose the option you were not offered
allowed-tools: Bash, Read, Write, WebSearch, WebFetch, Task
---
The stage before `/router:design`. Design assumes you already know what to build and need the
boundaries worked out. Brainstorm is for when **the goal itself is not settled**: it needs
research, a look at how other people solved this, and a few rounds of being asked why.

Going straight to design from an unsettled idea produces a document that argues carefully about
the boundaries of the wrong thing. That is the failure this stage exists to prevent.

**This is a conversation, not a document-production run.** Ask, listen, push back, ask again. Do
not write the whole file and present it -- write as you converge.

## Files

Ask for a **slug** in the first exchange (kebab-case, meaningful next month) and write to
`.router/plans/<slug>/BRAINSTORM.md` from then on, updating it as the conversation moves. The slug
becomes the `plan_id` -- one identifier, no mapping layer, so the directory name and the document
always agree. Renaming later is a `mv` plus a `renamed_from` line in the frontmatter.

On disk from the start, not at the end, for two reasons: an interrupted conversation keeps its
conclusions, and the implementation stage can compress this conversation away safely because
nothing important lives only in it.

```yaml
plan_id: <slug>
status: brainstorming   # brainstorming | converged | rejected
```

`rejected` is a real terminal state. **Killing an idea with a documented reason is a successful
outcome of this stage, not a failure of it** -- and the record is what stops the same idea coming
back in three months with nobody remembering why it was dropped.

## First: is this one thing or several?

Before any detail, judge whether the description covers **one feature or several**. Two triggers,
either one is enough:

- Two or more deliverables that would each have **their own acceptance criteria**.
- Changes spanning two or more top-level source directories **with no existing shared interface
  between them**.

If it triggers: stop, split it into independent blocks, state how they relate and what order they
have to be built in, and get the user to confirm the split. Then brainstorm **only the first
block**. Do not start asking detail questions about something that has to be decomposed first --
the answers will be about the wrong scope, and you will not notice.

If it does not trigger, say so in one line and move on. Do not perform the check theatrically.

## Four things every round must contain

Skipping any of these is what turns a brainstorm back into an agreement machine.

### 1. Ask why, from an angle they have not considered

When the user states what they want, do not start planning it. Ask what makes them want it: what
breaks today, what they tried, what happens if nothing is done, who else touches this, what would
make them abandon the approach. **One question at a time** -- a list of five gets one answer.

Push where the answer is thin. "It would be cleaner" is not a reason yet; ask what specifically is
unclean and what that costs.

### 2. Compare against how others solve it

Find out how comparable products and open-source projects handle the same problem, and say
whether they succeeded. Search; do not reason from memory alone -- memory is where a plausible
non-existent design comes from.

Report it as a comparison, not a list: *this product does it this way, that one does it that way,
you want a third way -- why?* The answer is often "I did not know the second way existed", which
is precisely the value. Where a mainstream approach was tried and abandoned, that is the most
useful thing on the page: say who abandoned it and why.

### 3. Argue the case against

**Every round must state the strongest reason this is not worth building.** Not a hedge, not a
risk register -- the best argument you can actually make: it solves a problem that does not
happen, the cost is larger than it looks, something existing already does it, it will rot because
nobody will maintain it.

If you genuinely cannot find one, **say so in those words**. Never omit the section, and never
soften it into "one possible concern". An unopposed idea has not been examined.

### 4. Propose the option they did not offer

The user's stated approach is **the best one they have right now, not necessarily the best one**.
Every round, offer at least one alternative they did not raise, and say on which dimension it is
better and what it costs.

If their approach really is the best you can see, **say exactly that** rather than inventing a
rival. And do not pad: an obviously worse option, the same idea reworded, or the original chopped
up and repackaged does not count. One real alternative beats three fake ones.

## The boundary with `/router:design`

Both stages present options; they are options about different things.

| | Brainstorm | Design |
|---|---|---|
| Options are about | **direction** -- do this at all, or the other thing instead | **implementation** -- which of 2-3 ways to build the agreed thing |
| Evidence | comparison with other products, counter-arguments | this codebase, with `file:line` |
| Output | a settled direction, or a documented rejection | boundaries, invariants, acceptance criteria |

Do not do design's job here. Interface shapes, edge cases, module boundaries, invariants: all of
those are design, and reaching for them now is how a brainstorm quietly becomes a bad design
document. When the user pulls toward detail, name the stage and note the question for design.

## The document

Four sections, written as you go:

1. **Goal** -- what they want and, more importantly, **why**: what breaks today, what it costs,
   what "done" would feel like.
2. **How others do it** -- comparable products and projects, their approach, and whether it worked.
3. **The case against** -- the strongest argument for not building this, and the alternatives
   raised (including the ones the user did not offer), each with the dimension it wins on and its
   cost.
4. **Where it converged** -- the direction chosen, **what was rejected and why**, and the
   questions handed to design.

Section 4's rejection list is the part that pays for itself later. `/router:design` has its own
"Alternatives considered" table, and `/router:design-review` requires its reviewer to read it
precisely so a road already closed is not re-proposed as a fresh idea. This is where the first
entries come from.

Write the document in the language the user is conversing in.

## Interaction discipline

Shared with the rest of the flow:

- Every exchange shows **[stage] + what changed this round + what needs confirming + explicit
  actions**.
- Never dump the whole document; show the section that changed. Full text only when asked.
- The Markdown file is the source of truth; the conversation carries summaries and decisions.

## Finishing

When the direction is settled: set `status: converged` and tell the user the next stage is
`/router:design`, which will take the direction as given and work out the boundaries.

When it is not worth building: set `status: rejected`, make sure section 3 records why in a form
that will still make sense to someone who does not remember the conversation, and stop. That is a
finished brainstorm.
