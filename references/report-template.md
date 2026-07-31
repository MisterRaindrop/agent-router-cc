# Review report template (used by /router:review phase four)

Fixed output shape for the final review report. Print findings verbatim; the user judges.

## Preflight result

State up front:
- `base_sha` / `head_sha` under review (the diff `/router:go` landed), and each package's
  `merge_commit` when there was more than one.
- Is the diff within the spec's declared scope? (note any drift)
- Was the spec approved by the user?
- Did the code change again after the last verification run? (if yes, prior evidence is stale)

Then, per landed package, from `router result <id> --json` — what is already established
before this review spends anything:

```
package:        <task id>            (plan_id / plan_revision)
effective risk: low | normal | high  (+ risk_raised_by, when the CLI escalated)
delivery:       gate_ran / scope_drift / escalate_review   (or "header missing")
gates:          <which verifier checks ran, and their results>
real gate:      pass | fail | pre-existing failure | never ran   -> <log path>
```

`escalate_review: true` or an effective risk above the spec's tier **raises** the depth of this
review; nothing lowers it. A missing delivery header, `scope_drift: true`, or a package the gate
never ran on is a Phase 1 finding in its own right.

If scope drifted or the spec was never approved, stop and return to `/router:spec` rather
than reviewing against a spec that no longer matches the code.

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

`level: spec` means the spec itself is wrong — that returns to `/router:spec`, it is not
fixed silently in review.

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
