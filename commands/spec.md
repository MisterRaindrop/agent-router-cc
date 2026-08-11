---
description: "DEPRECATED -- replaced by the design flow: /router:design, /router:design-review, /router:plan"
allowed-tools: Read
---
**This command is deprecated. Do not run the old spec flow.** Tell the user it has been
replaced and stop -- do not launch a reviewer, do not write or freeze any `PLAN.md`.

`/router:spec` mixed three jobs into one command: converging on an approach, adversarially
reviewing it, and freezing a single document that carried both the what and the how. Those
jobs are now separate stages, each with its own command and its own user approval:

| old job | new home |
|---|---|
| Clarify the goal and converge on an approach | `/router:design` -- one question at a time, code research, alternatives with trade-offs, a `DESIGN.md` confirmed section by section |
| Adversarial second opinion (independent model) | `/router:design-review` -- reviews the Design only; every objection adjudicated by the user, nothing auto-applied |
| The implementation plan `/router:go` executes | `/router:plan` -- steps, task breakdown, dependencies, verification matrix, rollout; approved as a summary |

Small changes need none of this: talk them through and run `/router:go` directly, exactly
as before. Whether a change deserves the design flow is the user's call.

Existing `.router/plans/<plan_id>/PLAN.md` files frozen by the old spec flow remain valid
inputs to `/router:go`; no migration is needed.
