---
description: Show the resolved model-tier config (bundled default + .router/models.yaml)
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" models`

Present the model tiers above: the weak/strong model (and reasoning effort) per executor,
and the reviewer chain used by `/router:spec` and `/router:review`. Note whether this is
the bundled default or includes a `.router/models.yaml` override -- to change a slug or
effort, edit `.router/models.yaml` (nothing else reads model choices).
