---
description: Wire claude-side quota reads into Claude Code's statusLine (chains any existing one)
allowed-tools: Bash(node:*), Read
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" setup-statusline --statusline "${CLAUDE_PLUGIN_ROOT}/statusline/router-usage.mjs" --json`

This wired router's usage-snapshot wrapper into `~/.claude/settings.json` as the
`statusLine` command, so the quota balancer can read claude-side remaining quota (same
mechanism claude-hud uses). If the user already had a statusline, it was chained via
`ROUTER_INNER_STATUSLINE` and still renders.

Tell the user the result: which `action` was taken (created / chained / already-configured)
and that they must restart or reload Claude Code for it to take effect. If `statusline_exists`
is false, the wrapper path was not found -- surface that. Without this, router falls back to
codex quota plus the reactive 429 switch, which is still correct but less balanced.
