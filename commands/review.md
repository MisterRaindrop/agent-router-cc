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

**Navigate with the symbol index, not by reading whole files** (see `/router:symbol`).
Run `router symbol index <dirs>` at the START of the review: it is incremental and cheap,
and rebuilding here is what pulls in the files the change just **added or modified** (a
plain query only re-parses files already in the index, so new files need this step). Then
`symbol find` / `enclosing` / `methods` locate definitions, a line's enclosing scope, and
class members a few lines at a time; each query also auto-refreshes any file you edit
mid-review, so results stay current. Open only bounded slices to confirm exact code.
Call-sites are a grep job (`find` returns definitions only); if a query degrades to
"using rg", fall back to rg. This keeps the review's context small so its budget goes to
judgment.

**You do not review your own work.** Launch an **independent reviewer -- a different model
from yourself** (you are Claude, so prefer a non-Claude reviewer). Get the reviewer chain
from `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models --json` (the `review` array,
strongest + most independent first): launch the first entry, e.g.
`codex exec -m <model> -c model_reasoning_effort=<effort>` with the `effort` from that
entry (default `xhigh` -- a completed xhigh review beats a max one that times out). If
codex is unavailable or out of quota, fall to the next same-strength entry (e.g.
`claude ... --model <model> --effort <effort>`) -- keep the strength, don't drop to a weak
model for adversarial review.

**Run the reviewer in the background**, **redirecting its full output to a file** (e.g.
`codex exec ... > .router/review/critique-<lens>.md 2>&1`), and tell the user (e.g. "code
review running in the background (<model>, effort <effort>); I'll surface the critique
when it lands") -- reviews take minutes and running detached avoids the interactive
timeout. `max` effort is opt-in, used only when the user explicitly asks for the deepest
pass (still backgrounded).

**Guard against truncation.** A long findings list can be cut off at the reviewer's output
cap or the shell/tool buffer. Mitigate: (1) read from the file above (complete regardless
of tool buffers), in chunks if large; (2) if the output is truncated (codex finish signal,
or text ending mid-finding), re-invoke to continue from where it stopped and **never
present a truncated critique as complete**. The two-lens split already helps -- each pass
is a separate, shorter call, so it is less likely to hit the cap than one giant review.

## Phase 1 -- Preflight

Before reviewing, establish what you are reviewing (see the Preflight section of
`${CLAUDE_PLUGIN_ROOT}/references/report-template.md`): the `base_sha`/`head_sha` of the
landed diff; whether the diff is within the spec's declared scope; whether the spec was
approved; and whether the code changed again after the last verification run (if so, prior
evidence is stale). **If scope drifted or the spec was never approved, stop and return to
`/router:spec`** -- do not review against a spec that no longer matches the code.

## Phase 2 -- Independent semantic review

Review the change (`git diff` of what `/router:go` landed) from **two lenses** -- run them as two passes (ideally two models for
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

## Phase 3 -- Assurance (run the spec's Verification Matrix)

Judge not just the code but whether it was actually PROVEN. Work through the spec's
Verification Matrix (see `${CLAUDE_PLUGIN_ROOT}/references/assurance-core.md`), running the
items you genuinely can here: the full test suite; the spec->test mapping (does a test
exist for each required scenario?); test validity (would each fail if its bug returned --
not hollow/tautological); Must NOT not violated; and, for a bug fix, the RED baseline (the
regression test fails against the OLD code). **Honesty rules from assurance-core apply:** a
tool that will not run here (e.g. C++ coverage/mutation needing a Docker-only compile db) is
`unverified`, never a faked `pass`; obey the anti-gaming contract. Tooling-dependent matrix
rows that cannot run become Known Limits, not silent passes.

## Phase 4 -- Evidence audit & verdict (print verbatim for the user)

Report per `${CLAUDE_PLUGIN_ROOT}/references/report-template.md`. Emit each finding as:
`{level: functional|diff|evidence|spec, dimension, severity: blocking|advisory|nit,
location: file:line, what: <specific, cited>, why: <concrete consequence, not "best
practice">, suggestion: <concrete fix>, evidence: <command/output or "none">,
confidence: high|medium|low}`. Include the evidence block (command/cwd/exit/tests/skipped/
status, four-state) for each check actually run. **Any code change invalidates prior
evidence -- the report must reflect a fresh run against the final `head_sha`.**

End with the **two-axis verdict, never collapsed into one**:
`code_health: yes | needs-changes | no` (did you find code defects?) and
`assurance: verified | partial | unverified` (is it proven per the matrix?). "No defect
found" is not "proven" -- a required check left `unverified` means `assurance` is at most
`partial`.
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
task via `/router:go`), then re-run the relevant tests, then a **fresh run of the full
Verification Matrix against the final code** (prior evidence is now stale), then **resume
the same reviewer session** to confirm each blocking finding is genuinely resolved --
verify against the new code, never on a "fixed it" claim. Repeat until the user is satisfied.

If a finding is `level: spec` (the spec itself is wrong -- e.g. an acceptance criterion is
incorrect), **do not quietly change the bar in review**: stop, return to `/router:spec`,
record a Spec Revision (visible), have the user re-approve, then re-implement and re-review.
The acceptance criteria are never weakened inside review to make a change pass.
