#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// A wrapper statusline: it snapshots the session's plan rate-limit usage to
// <cwd>/.router/usage.json (so router's quota balancer can read claude-side usage),
// then chains the user's existing statusline so their HUD is not clobbered.
//
// Setup (settings.json): "statusLine": { "type": "command",
//   "command": "node /path/to/agent-router-cc/statusline/router-usage.mjs" }
// Optionally set ROUTER_INNER_STATUSLINE to your previous statusline command; its
// output is passed through. Best-effort: writes nothing if the payload has no
// recognizable rate_limits (router then uses codex quota + the reactive 429).
//
// NOTE: extraction mirrors src/core/usageExtract.ts (kept intentionally in sync; this
// script runs standalone under Claude Code and cannot import the bundle).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const num = (x) => (typeof x === 'number' ? x : null);
function findRateLimits(x) {
  if (x && typeof x === 'object') {
    if (x.rate_limits && typeof x.rate_limits === 'object') return x.rate_limits;
    for (const k of Object.keys(x)) {
      const r = findRateLimits(x[k]);
      if (r) return r;
    }
  }
  return null;
}
function pct(o) {
  if (typeof o.used_percent === 'number') return o.used_percent;
  if (typeof o.used_percentage === 'number') return o.used_percentage;
  if (typeof o.remaining_percentage === 'number') return 100 - o.remaining_percentage;
  return null;
}
function extractUsage(root) {
  const rl = findRateLimits(root);
  const cands = [];
  if (rl) {
    cands.push(rl);
    if (rl.primary && typeof rl.primary === 'object') cands.push({ ...rl, ...rl.primary });
  }
  if (root && typeof root === 'object') cands.push(root);
  for (const o of cands) {
    const up = pct(o);
    if (up !== null) return { used_percent: up, resets_at: num(o.resets_at), reached: o.rate_limit_reached_type != null || up >= 100 };
  }
  return null;
}

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}
let data = {};
try {
  data = JSON.parse(raw || '{}');
} catch {
  /* not json */
}
const cwd = (data.workspace && data.workspace.current_dir) || data.cwd || process.cwd();
const routerDir = join(cwd, '.router');
const snap = extractUsage(data);
if (snap && existsSync(routerDir)) {
  try {
    writeFileSync(join(routerDir, 'usage.json'), JSON.stringify(snap));
  } catch {
    /* best-effort */
  }
}
const inner = process.env.ROUTER_INNER_STATUSLINE;
if (inner) {
  try {
    process.stdout.write(execSync(inner, { input: raw, encoding: 'utf8' }));
  } catch {
    process.stdout.write('router');
  }
} else {
  process.stdout.write(snap ? `router: claude ${snap.used_percent}% used` : 'router');
}
