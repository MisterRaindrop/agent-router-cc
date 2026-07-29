---
description: Adversarially review the code after tests pass -- an architect and a senior-dev lens (independent model) hunt for problems; YOU and the user judge
allowed-tools: Bash, Read, Write, Task
---
This is the **final, strict stage** before the change is considered done -- deliberately a
separate stage from `/router:go`, which ends at a *floor* check (the change is green in the
real environment and survived the main model's own review) so the user can confirm the
direction first. By the time you get here the floor has already passed, so **assume it and
hunt for what it cannot see**.

Green tests and a green CI run are the **precondition, not the evidence** -- the tests are
themselves under review and may be testing the wrong thing. Be strict: this is the last
gate, and it is the only stage that can catch "all tests pass but the judgment is one notch
off". Measured on real bugs, exactly that happened -- a fix cleared the held-out oracle
test, every regression test, and the floor review, while its guard condition was too broad
and silently disabled an optimization no test could observe.

Scope out what a linter/CI already covers (formatting, brace style, import order, "did
the build pass", "did the changelog change") -- do not spend the review on those. Spend
it on judgment: correctness the tests miss, design, robustness, and whether the tests are
meaningful.

**You do not review your own work.** Launch an **independent reviewer -- a different model
from yourself** (you are Claude, so prefer a non-Claude reviewer). Get the reviewer chain
from `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models --json` (the `review` array,
strongest + most independent first): launch the first entry, e.g.
`codex exec -m <model> -c model_reasoning_effort=<effort>`. If codex is unavailable or out
of quota, fall to the next same-strength entry (e.g. `claude ... --model <model> --effort
<effort>`) -- keep the strength, don't drop to a weak model for adversarial review. Review
the change (`git diff` of what `/router:go` landed) from **two lenses** -- run them as two passes (ideally two models for
extra independence):

**Architect lens (holistic / functional):** read end-to-end, not just the diff.
- Does the change actually solve the problem correctly? Is the realized approach and
  structure sound? Is there a better/simpler correct approach?
- Root cause vs symptom: was the fix applied at the shared root, and are sibling callers
  also correct? (grep every caller of a touched function.)
- **Is every new guard/condition as narrow as the problem?** A condition that is correct but
  broader than the bug silently switches off behaviour for cases that were fine -- lost
  push-down, lost caching, a fast path abandoned. Tests keep passing because the results are
  still right, only slower or weaker. Check what else the condition now captures, and name it.
- **Does the change break existing persisted state or older data?** New validation that also
  runs while loading what an older version already stored can make a previously working
  system refuse to start (measured: a new check on a stored entity ran on the authentication
  path, so one legacy record locked every user out). Trace every caller that re-parses or
  re-validates stored data, not just the user-facing entry point.
- Reuse vs reinvent: did it re-implement a helper/stdlib/platform feature that already exists?
- Independent correctness: reason about correctness yourself; name edge/failure cases the
  green tests do NOT cover.

**Senior-dev lens (diff-level craft):**
- Robustness/edge cases beyond the tests; failure modes and error handling (no silent
  fallbacks that hide bugs).
- Test design: would each test actually FAIL if its target bug returned? Meaningful
  assertions vs tautological? Behavior via the public API vs implementation details? Any
  sleep/timing flakiness? Missing edge coverage the green suite hides.
- **Test hygiene -- check all three; both cheap and strong models get these wrong:**
  (a) **isolation**: does the test create anything globally scoped under a fixed name
  (server-wide entities, fixed table/user names, paths outside a per-run temp dir)? Runners
  repeat and parallelise tests, so a fixed global name races with itself. (b) **cleanup on
  the failure path**: a test that aborts at its first failed assertion must not leave state
  behind -- leftover state from a failed run can break every later run. (c) **file mode**: a
  test script that the runner executes directly must carry the executable bit; compare
  against the other test scripts in that directory.
- Readability/naming; consistency with THIS project's conventions (not your taste);
  comments explain *why*; security and resource lifetime; obvious performance regressions.

## Findings (print verbatim for the user)

Emit each finding as:
`{level: functional|diff, dimension, severity: blocking|advisory|nit, location: file:line,
what: <specific, cited>, why: <concrete consequence, not "best practice">, suggestion:
<concrete fix>, confidence: high|medium|low}`
plus a top-level verdict: `improves code health? yes | needs-changes | no`.
- **blocking** = a correctness/robustness/security defect; a test that would not catch its own
  bug or cannot run at all; a guard broader than the problem that silently drops behaviour; or
  new validation that rejects already-stored data. **advisory** = design/maintainability.
  **nit** = pure preference (do not block).
- Earn the block: if nothing is blocking, say so plainly -- do not manufacture findings.
- **A blocking finding may also apply to the reference implementation.** Say so when it does,
  instead of softening it -- "the original fix has the same flaw" is a valid, useful finding,
  not a reason to downgrade it.

## Judge and close the loop

Print all findings verbatim; **the user decides** which are valid (the reviewer errs and
misses things too). Fix the accepted **blocking** findings (yourself, or dispatch a focused
task via `/router:go`), then **re-run the tests**, then **resume the same reviewer session**
to confirm each blocking finding is genuinely resolved -- verify against the new code, never
on a "fixed it" claim. Repeat until the user is satisfied.
