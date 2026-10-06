# What each document owes its reader

The rules in SKILL.md apply everywhere. This is what each kind of document additionally has to do.

## BRAINSTORM.md

**Reader:** you, three months from now, wondering why this direction and not another.

Four sections: goal (and *why* — what breaks today, what it costs); how others solve it; the case
against, with alternatives; where it converged.

The section that pays for itself is the rejection list. It must be readable by someone who was not
in the conversation: name the option, the reason it lost, and the evidence. "Considered and
rejected" is not a record — the next person re-proposes it.

Write the argument against at its strongest. A weak version is worse than none, because it looks
like the idea survived scrutiny.

## DESIGN.md

**Reader:** an independent reviewer attacking the approach, then the main session building
against it -- and, when the user names one, a codex writer that only gets this and the code.

Eight sections, each a few hundred words: background and goals; scope (in *and* explicitly out);
current state with `file:line` evidence; approach with alternatives considered; risks and
invariants; acceptance criteria; open questions; verification matrix.

- **Current state cites lines.** A claim about the code without a `file:line` is a guess, and
  reviewers spot-check them.
- **Alternatives considered is load-bearing**, not a formality: the review requires its reviewer
  to read it so a closed road is not re-proposed as a fresh idea.
- **Must NOT is a list of behaviours, not intentions.** "Never lose the user's uncommitted work"
  is checkable. "Be careful with git" is not.
- **Acceptance criteria are behaviour**, not implementation. *Where* each is proven is the
  verification matrix, the document's last section.
- **The verification matrix maps every acceptance criterion to where it is actually proven** — and
  keeps `unverified` visible rather than papering it over with a test that does not test it. It is
  written before implementation, so it is a commitment rather than a report.
- **Open questions get a type**: probe candidate, needs the user, or deferred with a trigger. An
  open question with no disposition is an unowned decision.

There is no second document. A work plan used to follow this one and carry the task breakdown;
it was removed in 0.14.0. How the work is sliced is left to whoever builds it, and never
written down.

## Commit messages

**Reader:** someone running `git log` on a line you wrote, wanting to know why it is like that.

Subject: what changed, imperative, under ~70 characters. Then a blank line, then **why** — the
body's job is the reason, since the diff already shows the what.

- Name the failure it prevents, concretely. "Takes the lock before the first write, so two runs
  cannot commit over each other" beats "improve locking".
- Cite the measurement if there is one.
- If a test changed with the code, say why the old expectation was wrong. That is the sentence a
  reviewer looks for.

## Command files (`commands/*.md`)

**Reader:** a model that will follow it literally, with no chance to ask.

- **Instructions, not description.** "Read the frontmatter before anything else", not "the
  frontmatter is important".
- **State the refusal conditions explicitly.** A model will not infer that it should stop.
- **Give the reason next to the rule.** A rule with a reason survives an edge case the rule alone
  does not cover; a bare rule gets worked around when it seems not to apply.
- **Detail goes in `references/`.** A command file is a flow. When it grows past roughly 250 lines,
  something in it is detail that belongs one file away.
