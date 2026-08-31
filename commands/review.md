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
plain query only re-parses files already in the index, so new files need this step).
**Read what it says it indexed.** On a repository whose languages it cannot parse it reports
`0 files` and exits 0, so an index that found nothing is indistinguishable from one that worked
unless you look -- and every later `find`/`enclosing` query then quietly returns nothing, which
reads as "no such caller" rather than "no index". If the count is 0, fall back to `rg` and say so.
Then
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

**Run each reviewer in the background through `router supervise`**, so a review that takes
minutes is visible while it runs instead of being a silent process:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" supervise \
  --label review:<lens> --log .router/plans/<plan_id>/review-<lens>.md \
  -- codex exec -m <model> -c model_reasoning_effort=<effort> ... < /dev/null
```

`supervise` publishes an activity record with a cross-process heartbeat (the statusline then
shows `review:<lens>` with a spinner while it is alive, and `已失联` if it dies), writes the
child's stdout **and stderr** to `--log` byte-for-byte as `> file 2>&1` would, and passes the
child's exit code through unchanged. It deliberately does **not** take `gate.lock`, so a review
and a dispatch can run at the same time and two lenses never queue behind each other.

`supervise` landed in 0.12.0. If the installed plugin is older -- run it once with `--help` and
look, do not assume -- fall back to plain redirection (`codex exec ... > <file> 2>&1 < /dev/null`)
for this round and say the review is running without a visible liveness line. Silently getting
`unknown command 'supervise'` and reporting "review started" is the exact failure shape this
whole plan exists to remove.

Then tell the user (e.g. "code review running in the background (<model>, effort <effort>);
I'll surface the critique when it lands"). `max` effort is opt-in, used only when the user
explicitly asks for the deepest pass (still backgrounded).

**Always redirect stdin from `/dev/null`.** Measured: an architect lens sat for 20 minutes and
produced 39 bytes, ending in `Reading additional input from stdin...` -- it was waiting on a
stdin that a background call never closes. From the outside that is indistinguishable from a
slow review, so you wait out the whole budget and get nothing.

**Give each reviewer its OWN background call.** Never `( reviewer_a & reviewer_b ) &` or any
other shape that puts both in one process group: killing or timing out that group kills both,
and what you get back is two large files that end mid-sentence with zero findings in them.
Measured: 117KB and 656KB of transcript, no verdicts, and the run looked like it had simply
found nothing. Two separate tracked calls cost nothing and cannot take each other down.

**Guard against truncation, and know what truncation looks like.** A findings list can be cut
off at the reviewer's output cap, at the shell/tool buffer, or by the provider. Mitigate:
(1) read from the file above (complete regardless of tool buffers), in chunks if large;
(2) re-invoke to continue from where it stopped, and **never present a truncated critique as
complete**. The two-lens split already helps -- each pass is a separate, shorter call.

Check for all three of these before believing a review is done, because a truncated file and a
finished one look identical from a distance:

- **the structured verdicts are missing.** You asked for `{level, dimension, severity, ...}`
  blocks; a file with none is not a clean review. Grep for the shape, do not eyeball the tail.
- **the text ends mid-finding**, or ends in tool output (a test run, a file listing) rather than
  in a report. Investigation is not a verdict.
- **the provider refused the answer.** `codex` returns
  `ERROR: This content was flagged for possible cybersecurity risk` and exits 0 -- so the exit
  code says success and the file says nothing.

  **Match on position, not on the string.** A plain grep for `flagged for possible` gives a false
  positive in this repository, because a reviewer that reads this very file quotes the phrase back
  into its transcript. Measured on six real logs: the two healthy ones each matched twice, in the
  middle of the file, on a line indented under a line number. The two refused ones matched on the
  **last two lines**, on a line that **starts** with `ERROR:`. So: a refusal is `^ERROR: This
  content was flagged` within the last few lines. Anywhere else is a quotation.

**Never list the trigger words in order to avoid them.** Writing "do not produce a repro script
that spawns a detached child, kills a process group, or forges a state file" into a brief is a
list of trigger words, and it got a reviewer refused **on the prompt** -- 4.3KB of log, zero
findings, it never started work. Say the same thing positively: "give reproduction steps only; I
will run them."

**On that filter specifically.** It fires on what the reviewer *writes*, not only on your brief.
Rewording the brief away from offensive-security vocabulary ("process group", "sandbox escape",
"forge", "tamper") gets it through the investigation -- and it can still be blocked at the moment
it emits a reproduction script that spawns a detached child, kills a group, or writes state it
does not own. Two independent lenses hit this at the same point, on the same fixture, and neither
report survived. If it happens: **say the review produced no verdicts** rather than presenting
the passing tests it happened to run as confirmation, and either ask the reviewer for reproduction
STEPS that you execute yourself, or switch to a reviewer not behind that filter.

**On THIS codebase, treat the architect lens as expected to be blocked, not as bad luck.** It was
blocked in three consecutive review rounds (packages A, B and C of the executor-observability
plan), every time at the moment it emitted a fixture that spawns a detached child, kills a process
group, or forges a state file -- which is what router's own subject matter makes any honest
reproduction look like. Plan for one lens plus your own mutation testing, and **record in the
adjudication that the second lens produced no conclusion**. "The architect lens raised nothing"
is a false statement about a review that was cut off before it could speak.

**`codex exec resume` is not `codex exec`.** It rejects `-C` outright and has no `-s`; pass the
sandbox as `-c sandbox_mode=read-only` instead. `src/app/codexLauncher.ts` documents this; check
it before assuming a flag carries over.

## Phase 1 -- Preflight

Before reviewing, establish what you are reviewing (see the Preflight section of
`${CLAUDE_PLUGIN_ROOT}/references/report-template.md`): the `base_sha`/`head_sha` of the
landed diff; whether the diff is within the declared scope; whether the bar this change is
judged against was approved by the user (the Design/Plan for work that went through the
design flow, the plan agreed at `/router:go` otherwise); and whether the code changed again
after the last verification run (if so, prior evidence is stale). **If scope drifted or the
bar was never approved, stop and return to `/router:design` / `/router:workplan`** -- do not
review against a bar that no longer matches the code.

**Start from router's own record rather than from scratch.** For each package `/router:go`
landed, `node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" result <id> --json` returns the run
record. Read these fields first -- they say what is already proven, what is only claimed, and
where this review must start:

- **`delivery.header`** -- the executor's own report (`gate_ran`, `scope_drift`,
  `escalate_review`), with the prose at `delivery.path`. `escalate_review: true` forces the full
  two-lens pass whatever the tier says: the executor is telling you something in there needs
  judgment. `scope_drift: true` is a Phase 1 finding, not a Phase 2 one. A missing or unparsed
  header (`delivery_header: missing`, `delivery.header_error`) is a **contract violation** --
  investigate that before the code, and never read it as "probably fine".
- **`risk` and `risk_raised_by`** -- the *effective* risk after the CLI's one-way escalation.
  Review at that level or higher and **never below it**; the tier the plan declared is a floor, not a
  ceiling. `risk_raised_by` names the deterministic signal that lifted it (changed-line count, a
  diff touching a path the contract declared invariant, a change spread across several top-level
  directories). Treat a named signal as a **lead to check**, never as a finding on its own.
- **`verifier.checks`** -- which environment-free gates ran (`diff_applies`, `scope`,
  `secret_scan`, `exec_bit`, `verify`) and their per-check result. `verifier: null` means no gate
  ran at all (contract conflict, timeout, stall) -- that is `unverified`, not a defect in the
  code, and it makes this stage the first real verification.
- **`gate`** -- the queue verdict when the project verifies in its own checkout, with `log` as a
  **path**. `gate_failed_pre_existing` means the same gate also failed on the pre-merge baseline:
  the failure belongs to the project, not to this change -- and it is equally not evidence *for*
  this change.
- **`base_sha` and `merge_commit`** -- the version binding. `land` deletes the run branch, so
  `git diff <merge_commit>^1 <merge_commit>` is the durable way to see exactly what one package
  changed.

Judge drift against the contract's declared **`invariants`** in `.router/tasks/<id>/task.yaml`
and its `TASK_CONTRACT.md`, not against your impression of the scope -- "it changed something it
was told not to" is only checkable because the contract said so. **Cite log paths; never paste
build output into the report.**

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

## Phase 3 -- Assurance (run the Plan's Verification Matrix)

Judge not just the code but whether it was actually PROVEN. Work through the Verification
Matrix the Plan declared -- or the contract's own, for work that never had a Plan (see
`${CLAUDE_PLUGIN_ROOT}/references/assurance-core.md`) -- running the
items you genuinely can here: the full test suite; the criteria->test mapping (does a test
exist for each required scenario from the acceptance criteria?); test validity (would each fail if its bug returned --
not hollow/tautological); Must NOT not violated; and, for a bug fix, the RED baseline (the
regression test fails against the OLD code). **Honesty rules from assurance-core apply:** a
tool that will not run here (e.g. C++ coverage/mutation needing a Docker-only compile db) is
`unverified`, never a faked `pass`; obey the anti-gaming contract. Tooling-dependent matrix
rows that cannot run become Known Limits, not silent passes.

**A package the gate never ran on is unproven, and this stage is where that shows.** When
Phase 1 turned up `gate_ran: false`, `verifier: null`, or a queue verdict that never reached a
pass, the matrix rows whose only evidence would have been that gate are `unverified` until you
run them here -- run the real gate yourself (`/router:gate <id>` on a queue project, the
project's own command otherwise) and read the whole output, or record them as Known Limits.
Do not carry the executor's word across from the delivery report: the report is what it
*claims*, the gate record is what *ran*, and a claim is not an evidence row.

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
- **Reproduction decides `blocking` versus `unverified`. It does not decide reported versus
  discarded.** A finding that names a mechanism and cites `file:line`, but that no available test
  can surface, is `unverified`: it does not block, and **it does not disappear**. Only a finding
  with no mechanism at all -- "possibly", "consider hardening", no concrete input or state -- is
  discarded.

  Getting this backwards throws away real bugs. This project's own heartbeat defect (`spawnSync`
  blocks the event loop, so an in-process timer stops during a long compile) was raised with no
  reproduction, was entirely real, and was later reproduced and fixed by a test that had to block
  the loop for real to see it.

  And `unverified` earns its keep in the other direction too: one such finding was left on the list
  rather than acted on, and the fix later attempted for it turned out to be a net regression and was
  reverted. "Record it, do not act yet" was the correct call.

  **Write `unverified` findings into the reviewed work's own `DESIGN.md`, in its known-limits
  section** -- that is where the next feature will read them. A per-round decisions file is where
  they go to die: measured, one `unverified` finding was re-raised and re-adjudicated in all three
  rounds because it lived only there. When the work has no `DESIGN.md`, put the limit in a comment
  at the code site, which is the one place that cannot drift away from what it describes.
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
verify against the new code, never on a "fixed it" claim.

### Before you call a round finished

**Classify every lens, and write the classification into the decisions record.** Not "did it find
anything" -- *did it speak at all*. A reviewer that was refused does not know it was refused and
does not say so; its log is simply short. Silence and a clean bill of health look identical, which
is the whole reason this step exists.

| Class | How you tell |
|---|---|
| `verdicts` | the file carries structured findings |
| `blocked` | `^ERROR: This content was flagged` in the last few lines, **or** it stopped before reporting |
| `truncated` | the text ends in tool output, or mid-finding |
| `empty` | neither findings nor an explicit "I read it and found nothing" |

**Check in that order, because a file can be two of them.** Measured: one lens read 666KB of code,
emitted a single finding, and was then refused at the moment it wrote its report. A "does it have
findings" test calls that a review.

**A lens that is not `verdicts` did not produce a conclusion. It did not "find nothing".** Report
it that way, and do not let it count toward a quiet round.

### The stop rule

**A round that produces zero blocking findings, with every lens classified `verdicts`, ends the
review.** Not a round count: a cap does not produce convergence, it hides the absence of it, and a
reviewer that says "nothing blocking" in round three may just be out of budget.

Round two and later review **`<previous round's head_sha>..HEAD`**, not the original range. **The
fixes are what this round is reviewing.** Measured: of nine findings in rounds two and three of one
plan, most were about round one's fixes, and two were defects the fixes had introduced -- one of
them failed a successful six-minute run because a legitimate re-run of the same label was judged
fatal. A round that re-runs the original range cannot see any of that. Put the range in the report,
so the next reader can see what was actually reviewed.

Two or three rounds is the expected *result*, never the target. Four rounds where each one found
something real is convergence working; two rounds where a lens never spoke is not.

The user can always ask for another round. The stop rule is the default, not a prohibition.

**Expect your own fixes to be the next round's findings.** Measured over three rounds on one
change: round 1's fixes contained a regression that let unverified code reach `main`, and round
2's fixes introduced six new blocking defects. The full suite was green at every one of those
moments, and not one of the twenty-one findings was in the test matrix. So a re-review is not
ceremony, and "the tests still pass" is not a reason to skip it.

One shape accounted for most of them, and it is worth grepping for by name before you re-submit:
**a fix applied to one call path and not to its sibling.** A head-pin check that went into `land`
and not into the queue gate; a `groupSurvived` flag handled in `dispatch` and ignored in
`gateQueue`; a guard whose window closed before the verification commands -- which are the
executor's own committed code -- ran. After each fix, `rg` the new symbol across `src/` and ask
of every hit whether it needed the same change.

## Close the plan

When the user accepts the review and the work is finished, set the work plan's frontmatter to
`status: done`.

This is the only place that writes it. `done` was a legal status from the day the flow was
written and **nothing ever set it**: `/router:go` moves a plan to `executing` and no stage moved
it on, so `router plans` showed finished work as still running -- two plans sat that way for
nearly two weeks. A state the schema allows and the flow cannot reach is worse than no state, and
it fails the way everything in this project fails: silently, still looking fine.

If the user is not finished -- findings deferred, a follow-up expected -- leave it `executing` and
say so. `done` means the plan is closed, not that this review round ended.

If a finding is `level: spec` (the bar itself is wrong -- e.g. a Design acceptance
criterion is incorrect, or a Plan verification row proves the wrong thing), **do not
quietly change the bar in review**: stop, return to `/router:design` (or `/router:workplan`
when only the how is wrong), record the revision in the document's Revision Log -- a bumped
Design revision drops the Plan back to draft -- have the user re-approve, then re-implement
and re-review. The acceptance criteria are never weakened inside review to make a change pass.
