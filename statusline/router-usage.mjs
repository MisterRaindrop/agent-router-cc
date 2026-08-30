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
// script runs standalone under Claude Code and cannot import the executable CLI bundle).
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_STDIN_JSON_BYTES = 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024;
// Measured on this project's own maintainer machine: the chained claude-hud takes a median of
// 1206ms, p90 1685ms, max 1815ms. A 1000ms timeout -- shipped in 0.12.0 -- therefore killed it on
// 20 of 25 runs, and a killed child that had not flushed yet leaves stdout empty, which this
// script then renders as a bare `router`. Measured end to end: 10 of 12 renders lost the user's
// whole HUD line.
//
// That is the same accident as the original EPIPE one, arriving through a fix for an advisory
// about a HUNG inner statusline. The timeout is kept for that case, but it must sit far above
// anything a healthy HUD does, so it can only ever fire on something genuinely stuck.
const INNER_STATUSLINE_TIMEOUT_MS = 10_000;

async function loadActivityApi() {
  try {
    // This script also runs from old installed plugin versions whose sibling dist/ directory has
    // no activity bundle. Keep the import best-effort so their inner HUD remains fully usable.
    const { observeActivities, activityState, readActivities } = await import(
      new URL('../dist/statusline-activity.mjs', import.meta.url).href
    );
    if (
      typeof observeActivities === 'function' &&
      typeof activityState === 'function' &&
      typeof readActivities === 'function'
    ) {
      return { observeActivities, activityState, readActivities };
    }
  } catch {
    /* no activity segment when the separately published observer cannot be loaded */
  }
  return null;
}

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
  return elapsedAge(now - then);
}
function elapsedAge(ageMs) {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

// The pinned clock requires two explicit test-only gates. ROUTER_STATUSLINE_NOW by itself is
// ignored so an inherited production environment variable cannot freeze liveness rendering.
function currentTimeMs() {
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.ROUTER_STATUSLINE_TEST_CLOCK === '1' &&
    process.env.ROUTER_STATUSLINE_NOW !== undefined
  ) {
    const pinned = Number(process.env.ROUTER_STATUSLINE_NOW);
    if (Number.isFinite(pinned)) return pinned;
  }
  return Date.now();
}

function statusFilePath(statusPath, routerDir) {
  if (typeof statusPath !== 'string' || statusPath.length === 0) return null;

  const workspaceDir = dirname(resolve(routerDir));
  const resolvedRouterDir = resolve(workspaceDir, '.router');
  const tasksDir = join(resolvedRouterDir, 'tasks');
  const candidate = resolve(workspaceDir, statusPath);
  const taskDir = dirname(candidate);

  if (
    basename(candidate) !== 'status.json' ||
    dirname(taskDir) !== tasksDir ||
    basename(taskDir).length === 0
  ) {
    return null;
  }

  for (const directory of [resolvedRouterDir, tasksDir, taskDir]) {
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
  }

  const entry = lstatSync(candidate);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_STATUS_BYTES) return null;
  return { candidate, entry };
}

function readStatusFile(statusPath, routerDir) {
  let file = null;
  let fd = null;
  try {
    file = statusFilePath(statusPath, routerDir);
    if (file === null) return null;

    fd = openSync(
      file.candidate,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== file.entry.dev ||
      opened.ino !== file.entry.ino ||
      opened.size > MAX_STATUS_BYTES
    ) {
      return null;
    }

    const bytes = Buffer.allocUnsafe(MAX_STATUS_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_STATUS_BYTES) return null;
    return bytes.subarray(0, length).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort close on a display-only read */
      }
    }
  }
}

function statusDetails(statusPath, routerDir, now) {
  try {
    const contents = readStatusFile(statusPath, routerDir);
    if (contents === null) return '';
    const status = JSON.parse(contents);
    if (!status || typeof status !== 'object') return '';

    const details = [];
    if (typeof status.phase === 'string' && status.phase) details.push(status.phase);
    if (typeof status.started_at === 'string' && typeof status.budget_minutes === 'number') {
      const elapsed = minutesSince(status.started_at, now);
      if (elapsed !== null) details.push(`${elapsed}m/${status.budget_minutes}m`);
    }
    if (typeof status.last_output_at === 'string') {
      const age = activityAge(status.last_output_at, now);
      if (age !== null) details.push(`·log ${age}`);
    }
    if (typeof status.stall_deadline === 'string') {
      const remaining = (Date.parse(status.stall_deadline) - now) / 60000;
      if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 5) {
        details.push(`·静默判死 ${Math.ceil(remaining)}m`);
      }
    }
    if (typeof status.recent_action === 'string' && status.recent_action) {
      details.push(`· ${status.recent_action}`);
    }
    return details.length === 0 ? '' : ` ${details.join(' ')}`;
  } catch {
    return '';
  }
}

function routerSegment(routerDir, now, activityApi) {
  if (activityApi === null) return '';
  try {
    const activities = activityApi.observeActivities(join(routerDir, 'activity'), now);
    if (activities.length === 0) return 'router ▶ idle';
    // No spinner. It was added when the refresh interval was 2 seconds, on a cost estimate that
    // turned out to be wrong by twenty times -- the chained statusline actually takes ~1.2s per
    // render because it runs `git status`. At the honest interval (10s) a spinner shows one frame
    // for ten seconds, which reads as motion that has STOPPED: worse than no spinner at all,
    // and exactly the kind of confident-looking lie this whole feature exists to remove.
    //
    // The numbers carry liveness instead, and they are honest at any refresh rate: every field is
    // computed at render time, so a stale line is uniformly stale rather than partly moving.
    return `router ▶ ${activities.map(({ record, state, beatAgeMs }) => {
      if (state === 'disconnected') {
        return `${record.label} 已失联 ${elapsedAge(beatAgeMs)}`;
      }
      const details =
        typeof record.status_path === 'string'
          ? statusDetails(record.status_path, routerDir, now)
          : '';
      return `${record.label}${details}`;
    }).join(' | ')}`;
  } catch {
    // Activity rendering is display-only. Never let it replace or truncate the inner HUD.
    return '';
  }
}

// Bounded, because this runs before the inner HUD does. `readFileSync(0)` buffers whatever the
// caller writes -- and a payload we would discard anyway (parsePayload rejects over the cap) must
// not be able to hold the whole statusline hostage while it is read. Reading one byte past the cap
// is enough to know it is oversized; we stop there and let the payload be discarded as before.
// Deliberately readFileSync, not a hand-rolled bounded loop.
//
// A reviewer advisory pointed out -- correctly -- that this buffers whatever the caller writes,
// before the inner HUD has even started, and a bounded version did measurably survive a 60MB
// payload under a 40MB heap where this one dies in GC.
//
// It was still reverted. The bounded loop WEDGED on a large stdin, roughly one run in four:
// `spawnSync ... ETIMEDOUT` after 20s, with the statusline child alive and blocked at 0% CPU.
// Two orphans from that bug were found alive on a developer machine, one of them 11 hours old,
// and a third hung a package gate for 50 minutes. This script runs on the user's screen every
// two seconds; a rare permanent wedge there is far worse than buffering a payload that
// parsePayload would discard anyway. readFileSync handles the EOF and EAGAIN cases that the
// hand-rolled loop got wrong.
//
// The test below pins the property that actually matters (an oversized payload must not cost
// the inner HUD) and carries a timeout, so a future attempt at this cannot hang the suite.
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  if (Buffer.byteLength(raw) > MAX_STDIN_JSON_BYTES) return {};
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function payloadCwd(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return process.cwd();
  const workspace = data.workspace;
  if (
    workspace &&
    typeof workspace === 'object' &&
    !Array.isArray(workspace) &&
    typeof workspace.current_dir === 'string' &&
    workspace.current_dir.length > 0
  ) {
    return workspace.current_dir;
  }
  return typeof data.cwd === 'string' && data.cwd.length > 0 ? data.cwd : process.cwd();
}

function innerOutput(raw) {
  const inner = process.env.ROUTER_INNER_STATUSLINE;
  if (!inner) return null;
  try {
    // spawnSync, not execSync: an inner statusline that does not READ stdin makes the parent's
    // write to it fail with EPIPE, and execSync turns that into a throw -- so the user's whole
    // HUD line was replaced by the word "router" because their HUD exited before draining a
    // pipe it never wanted. dash does this where bash does not, which is why it only showed up
    // on Linux. spawnSync reports the error instead of raising it and preserves stdout.
    // `detached` so the inner HUD leads its OWN process group, and the kill below can reach the
    // whole tree. spawnSync's own timeout kills only the direct child -- the shell -- and anything
    // that shell started keeps running.
    //
    // Measured, and it is not theoretical: with a HUD that runs `git status` on a repository large
    // enough to exceed the timeout, every refresh left the git processes behind. 190 of them were
    // found alive on one machine, spaced exactly one refresh interval apart, with the oldest 14
    // minutes old -- load average 86 on 18 cores, under 1% idle.
    //
    // Router already knows this: reapExecutorGroup (src/io/lock.ts) and drainGroup
    // (src/io/supervisor.ts) kill executors by process group for exactly this reason, both on top
    // of killProcessGroup in src/io/signals.ts. The statusline never applied its own lesson.
    const result = spawnSync(inner, {
      shell: true,
      input: raw,
      encoding: 'utf8',
      timeout: INNER_STATUSLINE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      detached: true,
    });
    if (typeof result.pid === 'number' && result.pid > 0) {
      try {
        // Every render signals the inner HUD's own process group, on the normal path as well as
        // the timeout path: a shell that exits before its children do is not a timeout, and
        // narrowing this to ETIMEDOUT would leave that leak open. The cost is real and accepted --
        // an inner HUD that backgrounds work to warm a cache loses it on every render.
        //
        // The contract is exactly "background work left INSIDE THAT GROUP does not survive a
        // render", and deliberately not "nothing the HUD started survives". Three things sit
        // outside it: a descendant that calls setsid to leave the group, an EPERM this cannot act
        // on (see below), and the gap between this signal and the group actually emptying -- which
        // is not waited on, the way drainGroup in src/io/supervisor.ts waits.
        process.kill(-result.pid, 'SIGKILL');
      } catch {
        /*
         * ESRCH here means the group is empty -- the outcome we wanted. EPERM does NOT: the group
         * is still there and merely not ours to signal, which is exactly how processGroupIsGone in
         * src/io/signals.ts reads it. A statusline has no channel to report that and must not
         * replace the user's HUD line with an error, so it stays silent -- but do not read this
         * catch as "nothing was left behind".
         */
      }
    }
    const text = typeof result.stdout === 'string' ? result.stdout : '';
    return text.trim() === '' ? 'router' : text.replace(/\n+$/, '');
  } catch {
    /* the router marker is the last-resort output when an inner HUD cannot be started */
  }
  return 'router';
}

const raw = readStdin();
const chainedOutput = innerOutput(raw);

// The user's inner HUD is the primary product of this wrapper. Deliver it before parsing or
// observing router state so malformed input and optional router integrations cannot replace it.
if (chainedOutput !== null) process.stdout.write(chainedOutput);

try {
  const data = parsePayload(raw);
  const routerDir = join(payloadCwd(data), '.router');
  const snap = extractUsage(data);
  if (chainedOutput === null) {
    process.stdout.write(snap ? `router: claude ${snap.used_percent}% used` : 'router');
  }
  if (snap && existsSync(routerDir)) {
    try {
      writeFileSync(join(routerDir, 'usage.json'), JSON.stringify(snap));
    } catch {
      /* best-effort */
    }
  }
  const live = routerSegment(routerDir, currentTimeMs(), await loadActivityApi());
  if (live) process.stdout.write(` | ${live}`);
} catch {
  // Router usage and activity rendering are optional. The inner HUD was already delivered.
  if (chainedOutput === null) process.stdout.write('router');
}

/*
This script is covered by test/statusline-render.test.ts, which RUNS it: fixed clock, fixture
`.router/` trees, asserted output strings. It replaces a "manual verification" comment block that
used to live here -- that block documented the pre-fold paths and nobody ran it, which is exactly
how the path change below shipped broken.
*/
