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
    let taskRuns;
    try {
      taskRuns = readdirSync(join(routerDir, 'tasks', task.name, 'runs'), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const run of taskRuns) {
      if (!run.isDirectory()) continue;
      try {
        const status = JSON.parse(readFileSync(join(routerDir, 'tasks', task.name, 'runs', run.name, 'status.json'), 'utf8'));
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
  try {
    process.stdout.write(execSync(inner, { input: raw, encoding: 'utf8' }));
  } catch {
    process.stdout.write('router');
  }
} else {
  process.stdout.write(snap ? `router: claude ${snap.used_percent}% used` : 'router');
}
const live = routerSegment(routerDir);
if (live) process.stdout.write(` | ${live}`);

/*
Manual verification (run each from a disposable directory; the timestamps below assume
the command is run at 2026-08-12T12:00:00.000Z, with ROUTER_INNER_STATUSLINE unset):

1) mkdir -p .router/tasks/zero/runs/r0; printf '{"phase":"verify","terminal_state":"succeeded","started_at":"2026-08-12T11:00:00.000Z","phase_started_at":"2026-08-12T11:00:00.000Z","budget_minutes":60,"last_output_at":null,"stall_deadline":null}' > .router/tasks/zero/runs/r0/status.json; printf '{}' | node /path/to/statusline/router-usage.mjs
   Expected: router

2) mkdir -p .router/tasks/alpha/runs/r1; printf '{"phase":"executor_working","started_at":"2026-08-12T11:42:00.000Z","phase_started_at":"2026-08-12T11:42:00.000Z","budget_minutes":30,"last_output_at":"2026-08-12T11:59:15.000Z","stall_deadline":"2026-08-12T12:03:10.000Z","recent_action":"Bash: git status"}' > .router/tasks/alpha/runs/r1/status.json; printf '{}' | node /path/to/statusline/router-usage.mjs
   Expected: router | router ▶ alpha executor_working 18m/30m ·log 45s ·静默判死 4m · Bash: git status

3) mkdir -p .router/tasks/alpha/runs/r1 .router/tasks/beta/runs/r2; printf '{"phase":"worktree","started_at":"2026-08-12T11:40:00.000Z","phase_started_at":"2026-08-12T11:40:00.000Z","budget_minutes":30,"last_output_at":null,"stall_deadline":null}' > .router/tasks/alpha/runs/r1/status.json; printf '{"phase":"gating","started_at":"2026-08-12T11:50:00.000Z","phase_started_at":"2026-08-12T11:50:00.000Z","budget_minutes":20,"last_output_at":"2026-08-12T11:58:00.000Z","stall_deadline":null}' > .router/tasks/beta/runs/r2/status.json; printf '{}' | node /path/to/statusline/router-usage.mjs
   Expected: router | router ▶ alpha worktree 20m/30m | beta gating 10m/20m ·log 2m
*/
