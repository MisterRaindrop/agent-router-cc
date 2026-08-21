# The curse of knowledge

Rule 8: never assume the reader knows why. This is the hardest rule to follow, because the
assumption is invisible from the inside — you cannot notice knowledge you already have.

It is also the rule with no mechanical form. Sentence length is measurable and barely matters;
"this document assumes the reader knows what a scope gate is" is unmeasurable and decides whether
the document works at all.

## Finding it in your own draft

Four passes. Each catches a different shape.

**1. Underline every noun phrase that names something specific to this project.** Terms, file
names, command names, invented concepts. For each: is there a clause explaining it *in this
document*, before this point? A glossary elsewhere does not count — the reader is reading here.

**2. Find every "because" that is missing.** Look for claims with no reason attached: "we do X",
"X is safer", "X is the right approach". Each one either has its reason in the sentence or is
asking the reader to trust you. Some of those are fine. Notice which you chose.

**3. Read the first paragraph as someone who arrived from a search result.** No conversation
history, no idea what problem this solves. Does the first paragraph say what this is about, or
does it continue a discussion the reader was not part of? Documents written straight out of a
conversation almost always do the second.

**4. Ask what a wrong-but-plausible reading would be.** For each key sentence, invent a reading
that is wrong and that the words allow. If one comes easily, the sentence needs splitting, not
softening. This is where ambiguous words show up: our own `detached` meant both "own process
group" and "Git detached HEAD", and `gate` meant three different things.

## What to write instead

**One clause, inline, on first use.** Not a paragraph, not a footnote:

> the scope gate (the check that a diff stays inside the files the task declared)

**Name the mechanism instead of the property.** "Safer" is a conclusion the reader cannot verify.
"Takes the lock before the first write, so a second run cannot commit in between" is a fact they
can check, and it teaches them the design.

**When the reason is long, say the reason exists and where it is.** "Rejected because a fresh
worktree cannot compile a real project (see DEPRECATIONS.md)" beats both the bare assertion and
three paragraphs inline.

**Say when you are asking for trust.** "I have not measured this" or "unverified" costs one clause
and keeps the document honest. A claim delivered in the same confident tone as a measured one
spends credibility that belongs to the measurements.

## The check you cannot do yourself

By definition. So use an outside reader: `/router:design-review` launches a model that has never
seen this project and asks it to report where it could not follow the document. Treat that section
as findings, adjudicated like any other objection — an explanation you judge unnecessary is a
reasoned reject, not a silent skip.
