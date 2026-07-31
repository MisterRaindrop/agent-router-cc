---
description: Show the resolved model-tier config (bundled default + .router/models.yaml)
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models`

Present the model tiers above: the `weak` / `strong` / `critical` model (and reasoning
effort) per executor, and the reviewer chain used by `/router:spec` and `/router:review`.
Note whether this is the bundled default or includes a `.router/models.yaml` override -- to
change a slug or effort, edit `.router/models.yaml` (nothing else reads model choices, and
router never modifies it).

Explain how a tier is chosen, because it is the one routing rule that matters: **decide the
minimum capability the task actually requires, then let real remaining quota pick among the
executors that meet it.** Quota reorders executors *within* a tier -- it never moves a task to
a weaker tier, so a security, concurrency, or architectural-invariant package is not demoted
because the strong lane is short. Effort is matched to the work rather than maxed: mechanical
implementation at `medium`, work that needs real capability at `high`, and `xhigh` reserved
for `critical` -- effort sits on the critical path of every dispatch, and a contract that
already states what to write gains little from deeper deduction.

Note too that the orchestrator's own model appears **only** at `critical`: spending it as an
ordinary executor would consume the very budget routing exists to protect.
