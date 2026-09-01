# Assurance core (shared by the design flow and /router:review)

Shared vocabulary and rules. The design flow uses these to define *what must be proven* --
risk tier and Must NOT at `/router:design`, the Verification Matrix at `/router:workplan`
(`/router:go` sets the same bar in the contract for work that skips the flow); `review`
uses them to judge *whether it was proven*. Load only the parts a given task needs.

## Risk tiers

Rate the change; the tier decides which checks are required (see the Verification Matrix).

- **Low** — only: docs/comments; metadata with no runtime effect; changes provably without
  semantic effect. Nothing that alters behaviour.
- **Normal** — ordinary bug fix; new business logic; parsing/validation/state changes;
  error-handling changes; changes to the test harness or build config.
- **High** — ANY of: auth/permission/security; money/billing/quota; data deletion,
  migration, or a persisted format; concurrency/locks/async state; a public API or
  protocol; a new dependency or a new external capability; a performance-critical path; a
  change that is hard to roll back; logic that ordinary tests cannot fully verify.

**When unsure, escalate.** Never downgrade a tier to justify running fewer checks.

## Four-state status

Every check reports exactly one of: `pass` | `fail` | `unverified` | `not-applicable`.
- `unverified` is honest and expected when a check genuinely cannot run here (e.g. tooling
  absent, or a C++ compile database that only exists inside a Docker build). Do NOT dress a
  gap up as `pass`, and do NOT invent a hollow test just to turn `unverified` into `pass`.
- **Known Limits:** list anything that stays `unverified` and why. A required check left
  `unverified` means the change is *not* fully proven — say so.

## Anti-gaming contract

These are prohibited, in both authoring tests (go) and judging them (review):
- Do not delete, skip, or weaken a test to make the suite pass.
- Do not change the test and the implementation together and then declare GREEN — the test
  must fail against the OLD implementation first (RED). **Not only for bug fixes.** A test
  written for behaviour that already works needs the same proof: green shows the test runs,
  only red shows it is attached to what it claims to fence. Break the code it covers — delete
  the guard, narrow the condition — watch that exact test go red, then put the code back.
  - **Break it once per part of the fix.** `detached` plus a drain that runs on every path is
    three separate regressions: remove `detached`, remove the drain, narrow the drain to the
    timeout path. Each needs its own failing test; one RED run against "delete the whole
    thing" passes over two of them.
  - **Assert the fixture did what you needed, before asserting what you care about.**
    `assert.equal(rc, 0, 'the fixture did not exit cleanly: nothing was tested')`. Without it a
    test cannot tell "the bug is gone" from "the setup never happened" — both are green.
  - Measured, three times in one plan, each a test that looked better than what it replaced and
    passed with the fix **and** with the fix removed: an assertion that a shell's process group
    was empty (without `detached` the shell is not a group leader, so its pid is nobody's pgid
    and the check is vacuously true); a "the HUD exits normally" test that ran the full timeout
    every time, because a background child inherits the stdout pipe and `spawnSync` waits for
    every writer to close it; and the same shape again where an active child handle held its
    parent's event loop open.
- Do not mock or stub the very logic under test.
- Do not count a test that only raises coverage but asserts nothing.
- Do not mark a check `pass` that you did not actually run.
- A tool that failed to start, or a run that collected zero tests, is `unverified` or a
  tooling `fail` — it is NEVER a passing test run, and never a mutation "kill".
- If the bar is wrong, stop and revise the Design/Plan (with a visible Revision Log entry)
  — do not edit tests to match a wrong implementation.

## Failure Model (the design flow fills, review verifies)

| failure mode | consequence | detection | status |
|---|---|---|---|
| <how it breaks> | <impact> | <the check that would catch it> | planned / unverified |

Every High-risk failure mode needs a check that can actually surface it. If no available
check can, mark it `unverified` — do not substitute an ordinary unit test that cannot see
the failure.

## Verification Matrix (the Plan fills, review executes/checks)

| scenario / risk | verification layer | necessity |
|---|---|---|
| normal behaviour | unit/integration test | required |
| bug no longer occurs | RED regression test | required (bug fix) |
| changed code actually runs | changed-line coverage | required-if-tooling, else unverified |
| tests are not hollow | targeted mutation | conditional (High, if tooling) |
| large input space | property/fuzz | conditional |
| public interface changed | API-compatibility | conditional |
| concurrent state | race/stress | conditional (High) |
| new dependency | audit/license | declare required; scan conditional |
| performance budget | benchmark | only if an explicit budget was set |

`required` items that end `unverified` block an `assurance: verified` verdict.
