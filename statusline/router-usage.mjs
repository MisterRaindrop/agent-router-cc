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
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

function minutesSince(iso, now) {
  const then = Date.parse(iso);
  return Number.isFinite(then) ? Math.max(0, Math.floor((now - then) / 60000)) : null;
}
function activityAge(iso, now) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}
// `.router/tasks/<id>/status.json`. It used to be `tasks/<id>/runs/<run>/status.json`; the run
// dimension was folded away because it only ever held one value.
//
// Deliberately NO legacy fallback, unlike store.readResult which keeps one. That reads history,
// where old records must stay visible; this reads only what is LIVE, and a live run cannot
// predate the upgrade that moved the path. The single thing a fallback could surface here is a
// stale pre-upgrade file, which is exactly what must not come back as a phantom run.
function activeRuns(routerDir, now) {
  const runs = [];
  let tasks;
  try {
    tasks = readdirSync(join(routerDir, 'tasks'), { withFileTypes: true });
  } catch {
    return runs;
  }
  for (const task of tasks) {
    if (!task.isDirectory()) continue;
    try {
      const status = JSON.parse(readFileSync(join(routerDir, 'tasks', task.name, 'status.json'), 'utf8'));
      if (
        !status ||
        typeof status !== 'object' ||
        Object.prototype.hasOwnProperty.call(status, 'terminal_state') ||
        typeof status.phase !== 'string' ||
        typeof status.started_at !== 'string' ||
        typeof status.budget_minutes !== 'number'
      ) continue;
      const elapsed = minutesSince(status.started_at, now);
      const started = Date.parse(status.started_at);
      if (elapsed === null || !Number.isFinite(started)) continue;
      runs.push({ taskId: task.name, status, elapsed, started });
    } catch {
      /* one missing or malformed status must not hide other runs */
    }
  }
  return runs.sort((a, b) => a.started - b.started);
}
function routerSegment(routerDir) {
  const now = Date.now();
  const runs = activeRuns(routerDir, now);
  if (runs.length === 0) return '';
  return `router ▶ ${runs.map(({ taskId, status, elapsed }) => {
    let line = `${taskId} ${status.phase} ${elapsed}m/${status.budget_minutes}m`;
    if (status.last_output_at !== null) {
      const age = activityAge(status.last_output_at, now);
      if (age !== null) line += ` ·log ${age}`;
    }
    if (status.stall_deadline !== null) {
      const remaining = (Date.parse(status.stall_deadline) - now) / 60000;
      if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 5) line += ` ·静默判死 ${Math.ceil(remaining)}m`;
    }
    if (typeof status.recent_action === 'string' && status.recent_action) line += ` · ${status.recent_action}`;
    return line;
  }).join(' | ')}`;
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
  // spawnSync, not execSync: an inner statusline that does not READ stdin makes the parent's
  // write to it fail with EPIPE, and execSync turns that into a throw -- so the user's whole HUD
  // line was replaced by the word "router" because their HUD exited before draining a pipe it
  // never wanted. dash does this where bash does not, which is why it only showed up on Linux.
  // spawnSync reports the error instead of raising it, and still hands back what the child
  // printed, so output survives a stdin it ignored.
  const r = spawnSync(inner, { shell: true, input: raw, encoding: 'utf8' });
  const text = typeof r.stdout === 'string' ? r.stdout : '';
  process.stdout.write(text.trim() === '' ? 'router' : text.replace(/\n+$/, ''));
} else {
  process.stdout.write(snap ? `router: claude ${snap.used_percent}% used` : 'router');
}
const live = routerSegment(routerDir);
if (live) process.stdout.write(` | ${live}`);

/*
This script is covered by test/statusline-render.test.ts, which RUNS it: fixed clock, fixture
`.router/` trees, asserted output strings. It replaces a "manual verification" comment block that
used to live here -- that block documented the pre-fold paths and nobody ran it, which is exactly
how the path change below shipped broken.
*/
