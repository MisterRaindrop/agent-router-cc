---
description: Adversarially review the code after tests pass -- an architect and a senior-dev lens (independent model) hunt for problems; YOU and the user judge
allowed-tools: Bash, Read, Write, Task
---
Run this **after `/router:go` has finished and the tests are green**. Green tests are a
precondition, **not proof the code is correct** -- the tests are themselves under review
and may not test the right thing. So this is a full senior review of the change, judged
independently, not a rubber stamp.

Scope out what a linter/CI already covers (formatting, brace style, import order, "did
the build pass", "did the changelog change") -- do not spend the review on those. Spend
it on judgment: correctness the tests miss, design, robustness, and whether the tests are
meaningful.

**You do not review your own work.** Launch an **independent reviewer -- a different model
from yourself** (you are Claude, so prefer a non-Claude reviewer via `codex exec` or a
`Task` subagent pinned to another model). Review the change (`git diff` of what
`/router:go` landed) from **two lenses** -- run them as two passes (ideally two models for
extra independence):

**Architect lens (holistic / functional):** read end-to-end, not just the diff.
- Does the change actually solve the problem correctly? Is the realized approach and
  structure sound? Is there a better/simpler correct approach?
- Root cause vs symptom: was the fix applied at the shared root, and are sibling callers
  also correct? (grep every caller of a touched function.)
- Reuse vs reinvent: did it re-implement a helper/stdlib/platform feature that already exists?
- Independent correctness: reason about correctness yourself; name edge/failure cases the
  green tests do NOT cover.

**Senior-dev lens (diff-level craft):**
- Robustness/edge cases beyond the tests; failure modes and error handling (no silent
  fallbacks that hide bugs).
- Test design: would each test actually FAIL if its target bug returned? Meaningful
  assertions vs tautological? Behavior via the public API vs implementation details? Any
  sleep/timing flakiness? Missing edge coverage the green suite hides.
- Readability/naming; consistency with THIS project's conventions (not your taste);
  comments explain *why*; security and resource lifetime; obvious performance regressions.

## Findings (print verbatim for the user)

Emit each finding as:
`{level: functional|diff, dimension, severity: blocking|advisory|nit, location: file:line,
what: <specific, cited>, why: <concrete consequence, not "best practice">, suggestion:
<concrete fix>, confidence: high|medium|low}`
plus a top-level verdict: `improves code health? yes | needs-changes | no`.
- **blocking** = a correctness/robustness/security defect, or a test that would not catch
  its own bug. **advisory** = design/maintainability. **nit** = pure preference (do not block).
- Earn the block: if nothing is blocking, say so plainly -- do not manufacture findings.

## Judge and close the loop

Print all findings verbatim; **the user decides** which are valid (the reviewer errs and
misses things too). Fix the accepted **blocking** findings (yourself, or dispatch a focused
task via `/router:go`), then **re-run the tests**, then **resume the same reviewer session**
to confirm each blocking finding is genuinely resolved -- verify against the new code, never
on a "fixed it" claim. Repeat until the user is satisfied.
