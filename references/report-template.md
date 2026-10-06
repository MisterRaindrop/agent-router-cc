# Review report template (used by /router:review phase four)

Fixed output shape for the final review report. Print findings verbatim; the user judges.

## Preflight result

State up front:
- `base_sha` / `head_sha` under review (the change's diff).
- Is the diff within the declared scope? (note any drift)
- Was the bar approved by the user (the Design, or what they asked for in conversation)?
- Did the code change again after the last verification run? (if yes, prior evidence is stale)

Then, from what is on disk — what is already established before this review spends anything:

```
change:         <base>..HEAD, N commits       (plan_id + DESIGN.md revision, when there is one)
written by:     main session | codex write <id> (model, session, resumes)
left behind:    uncommitted files from a writer's record, or "none"
real gate:      ran and passed | failed | never ran   -> <log path>
```

Uncommitted work a writer left behind, a resume that did not re-attach, or a build that never ran
is a Phase 1 finding in its own right.

If scope drifted or the bar was never approved, stop and return to `/router:design` rather
than reviewing against a bar that no longer matches the code.

## Finding shape

Emit each finding as:

```
{ level: functional | diff | evidence | spec,
  dimension,
  severity: blocking | advisory | nit,
  location: <file:line>,
  what,
  why,
  suggestion,
  evidence,        // command / output excerpt, or "none"
  confidence: high | medium | low }
```

`level: spec` means the bar itself is wrong (an acceptance criterion, or a verification-matrix
row that proves the wrong thing) — that returns to `/router:design`, it is not fixed silently in
review.

## Evidence block

For each verification actually performed, record:

```
check:      <name from the Verification Matrix>
command:    <exact command run>
cwd:        <working directory>
exit:       <exit code>
tests:      <count run / passed / failed>   (or n/a)
skipped:    <what was not run, and why>
status:     pass | fail | unverified | not-applicable
```

## Evidence validity rules

- Any code change **invalidates all prior evidence**. The report must reflect a fresh run
  against the FINAL code state (same `head_sha`), not an intermediate run.
- A tool that failed to start is not a pass. A run that collected zero tests is not a pass.
- Do not report a check you did not run.

## Verdict (two axes, never collapsed into one)

```
code_health: yes | needs-changes | no      // did the review find defects in the code?
assurance:   verified | partial | unverified  // is it actually proven per the matrix?
```

These are independent. Examples:
- Code looks correct but a required concurrency test could not run here:
  `code_health: yes` / `assurance: partial`.
- Tests all pass but a new guard is broader than the bug:
  `code_health: needs-changes` / `assurance: verified`.

Never merge them into a single "LGTM" — "no defect found" is not the same as "proven".
