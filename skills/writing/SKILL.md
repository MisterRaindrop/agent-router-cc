---
name: writing
description: Write and revise this project's documents -- designs, work plans, brainstorms, commit messages, command files, code comments. Use when authoring or revising prose that another person (or a future you) has to act on. Enforces "explain your own terms, and cut the padding" in Chinese and English alike.
---
# Writing

Two failures, opposite directions, and this project has committed both.

**Obscure.** Internal terms used with no explanation, compressed until the author cannot read it
back. An independent reviewer of one of our design documents reported it could not follow the
document — the terms were ours and nowhere defined.

**Padded.** Length standing in for substance: preamble before the point, a summary of what was
just said, hedges around a claim that is either true or not.

Fixing one by committing the other is the usual mistake. Both rules apply at once.

## The rules

Fourteen. Read this list; reach for a reference file only where noted.

**Say the thing**

1. **Lead with the conclusion.** First sentence carries it. No warm-up, no restating the question.
2. **Cut the summary paragraph.** If the reader needed it, the body was too long. Fix the body.
3. **One claim per sentence.** Two claims joined by "and" hide which one is load-bearing.
4. **Delete every sentence that survives its own removal.** Read the paragraph without it: if
   nothing is lost, it was padding.
5. **No hedging.** "It may be worth considering" → say it, or drop it. Uncertainty gets stated as
   uncertainty ("unverified", "I have not measured this"), never smeared over the whole sentence.

**Explain your own terms**

6. **A project term gets one clause on first use in every document.** Not a glossary link — the
   reader is reading *here*. `references/glossary.md` is the source; the clause is inline.
7. **Split an ambiguous word rather than defining it.** If a word does three jobs, three names.
   Ambiguity is worse than absence: the reader does not know they have misunderstood.
8. **Never assume the reader knows why.** The hardest failure to see, because *you* know. This is
   the curse of knowledge, and it is the one thing no mechanical check will catch — see
   `references/curse-of-knowledge.md` for how to find it in your own draft.
9. **Name the mechanism, not the adjective.** Not "this is safer" but "this takes the lock before
   the first write, so a second run cannot commit in between".

**Earn the claim**

10. **Every measurement carries its number and its origin.** "393s of executor time against 0.26s
    of orchestration" beats "the overhead is negligible". A claim you cannot source is an opinion,
    and should read as one.
11. **State the cost next to the benefit.** A trade-off written as an improvement is a trap for
    the next reader.
12. **Record what was rejected and why.** A closed road with no sign gets walked again.

**Shape**

13. **Break a long sentence.** English: over ~30 words, look for the split. Chinese: over ~60
    characters. A guide for the eye, not a limit to enforce — see below.
14. **Table over prose for anything with more than two parallel cases.** Prose comparing four
    options is a table someone refused to draw.

## What is deliberately not checked

There is no linter, and adding one would be a mistake. Everything mechanically checkable —
sentence length, whether a term is defined on first use, paragraph count — is the part that
matters least. The part that matters, rule 8, has no measurable form: the author cannot see it by
definition, which is why it is caught by an outside reader instead. `/router:design-review` asks
its reviewer to report where it could not follow the document, and that reviewer has never seen
this project. Use it.

So rule 13's thresholds are for the eye. A 70-character Chinese sentence that reads cleanly is
fine; a 40-character one with three clauses is not.

## Chinese and English

Both, with the same rules. Two notes:

- Write the document in the language the user is conversing in. Code, identifiers, file paths and
  commit messages stay in English.
- The thresholds in rule 13 differ because the units do (~1.5–2 characters per English word in
  written Chinese). Nothing else changes.

Do not install `agent-style` for this. Its own scope statement excludes non-English prose, so on a
Chinese document it delivers about half of what it costs.

## Reference files — load only when you need them

| File | When |
|---|---|
| `references/curse-of-knowledge.md` | Rule 8. How to find unexplained assumptions in your own draft, and what to do instead of guessing. |
| `references/document-shapes.md` | Authoring a design, work plan, brainstorm, commit message or command file — what each one owes its reader. |
| `references/revision-pass.md` | Revising an existing draft: the order to attack it in, and how to tell padding from necessary repetition. |

## When context is tight

Do not skip the revision pass — delegate it. Hand a subagent the draft and one instruction:

> Revise this document against these rules: lead with the conclusion; one claim per sentence;
> delete any sentence that survives its own removal; no hedging; every project term gets one
> explanatory clause on first use; every measurement carries its number and source; state the cost
> beside the benefit; tables for more than two parallel cases. Do not change any technical claim,
> number, file path or identifier. Return the revised document and a list of what you cut.

Read the list of cuts before accepting. A copy-editor that removed a load-bearing qualifier is the
failure mode, and the list is how you catch it.
