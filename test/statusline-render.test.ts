// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Tests that RUN statusline/router-usage.mjs.
//
// This file exists because nothing did. cli-setup-statusline and core-statusline-setup both test
// *wiring* the script into settings.json and never execute it, so when the run dimension was
// folded away -- `tasks/<id>/runs/<run>/status.json` -> `tasks/<id>/status.json` -- the script
// kept scanning the old path, found nothing, and shipped in a release. It failed silently and
// identically to "nothing is running", which is the worst possible way for a liveness indicator
// to break.
//
// The script is standalone (it runs under Claude Code and cannot import the bundle), so the only
// honest way to test it is to spawn it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../statusline/router-usage.mjs', import.meta.url));

/** Run the statusline the way Claude Code does: payload on stdin, output on stdout. */
function render(cwd: string, payload: unknown = {}, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ROUTER_INNER_STATUSLINE: '', ...env },
  });
}

function repo(): { dir: string; task(id: string, status: Record<string, unknown>): void; legacy(id: string, status: Record<string, unknown>): void; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'router-statusline-'));
  return {
    dir,
    task(id, status) {
      mkdirSync(join(dir, '.router', 'tasks', id), { recursive: true });
      writeFileSync(join(dir, '.router', 'tasks', id, 'status.json'), JSON.stringify(status));
    },
    legacy(id, status) {
      mkdirSync(join(dir, '.router', 'tasks', id, 'runs', 'run-001'), { recursive: true });
      writeFileSync(join(dir, '.router', 'tasks', id, 'runs', 'run-001', 'status.json'), JSON.stringify(status));
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A live run started `minutesAgo` ago, with its last output `logSecondsAgo` ago. */
function live(minutesAgo: number, logSecondsAgo: number | null): Record<string, unknown> {
  const now = Date.now();
  const started = new Date(now - minutesAgo * 60_000).toISOString();
  return {
    phase: 'executor_working',
    started_at: started,
    phase_started_at: started,
    budget_minutes: 30,
    last_output_at: logSecondsAgo === null ? null : new Date(now - logSecondsAgo * 1000).toISOString(),
    stall_deadline: null,
  };
}

// The regression itself. A run's status at the CURRENT path must be found.
test('a live run at tasks/<id>/status.json is rendered', () => {
  const fx = repo();
  try {
    fx.task('alpha', live(18, 45));
    const out = render(fx.dir, { cwd: fx.dir });
    assert.match(out, /router ▶ alpha executor_working 18m\/30m ·log 45s/);
  } finally {
    fx.cleanup();
  }
});

// The other half of the same regression: the pre-fold path must NOT resurrect anything. A live
// run cannot predate the upgrade that moved the path, so anything found there is stale, and a
// stale file rendered as a running task is a phantom that never goes away.
test('a status file at the pre-fold runs/run-001 path is ignored', () => {
  const fx = repo();
  try {
    fx.legacy('ghost', live(5, 10));
    const out = render(fx.dir, { cwd: fx.dir });
    assert.doesNotMatch(out, /ghost/);
    assert.doesNotMatch(out, /router ▶/);
  } finally {
    fx.cleanup();
  }
});

test('a finished run (terminal_state present) is not shown as running', () => {
  const fx = repo();
  try {
    fx.task('done', { ...live(60, 30), terminal_state: 'succeeded', phase: 'verify' });
    assert.doesNotMatch(render(fx.dir, { cwd: fx.dir }), /router ▶/);
  } finally {
    fx.cleanup();
  }
});

test('several live runs render in start order, separated', () => {
  const fx = repo();
  try {
    fx.task('later', live(10, null));
    fx.task('earlier', live(20, 120));
    const out = render(fx.dir, { cwd: fx.dir });
    assert.match(out, /router ▶ earlier .* \| later /);
  } finally {
    fx.cleanup();
  }
});

// The stall countdown only appears when it is close, so it is a warning rather than noise.
test('the stall countdown appears within five minutes and not before', () => {
  const fx = repo();
  try {
    fx.task('near', { ...live(5, 200), stall_deadline: new Date(Date.now() + 3 * 60_000).toISOString() });
    fx.task('far', { ...live(5, 200), stall_deadline: new Date(Date.now() + 40 * 60_000).toISOString() });
    const out = render(fx.dir, { cwd: fx.dir });
    assert.match(out, /near[^|]*静默判死 3m/);
    assert.doesNotMatch(out, /far[^|]*静默判死/);
  } finally {
    fx.cleanup();
  }
});

test('recent_action is appended when the executor reported one', () => {
  const fx = repo();
  try {
    fx.task('acting', { ...live(2, 5), recent_action: 'Bash: npm test' });
    assert.match(render(fx.dir, { cwd: fx.dir }), /acting .*· Bash: npm test/);
  } finally {
    fx.cleanup();
  }
});

// Chaining is how router coexists with a HUD the user already chose. If this breaks, the fix for
// the path regression is unreachable: wiring router in would cost them their existing statusline.
test('an inner statusline is preserved and router appends after it', () => {
  const fx = repo();
  try {
    fx.task('alpha', live(3, 8));
    const out = render(fx.dir, { cwd: fx.dir }, { ROUTER_INNER_STATUSLINE: "printf 'my-hud: ctx 42%%'" });
    assert.match(out, /^my-hud: ctx 42% \| router ▶ alpha /);
  } finally {
    fx.cleanup();
  }
});

test('a malformed status file does not hide the other runs', () => {
  const fx = repo();
  try {
    mkdirSync(join(fx.dir, '.router', 'tasks', 'broken'), { recursive: true });
    writeFileSync(join(fx.dir, '.router', 'tasks', 'broken', 'status.json'), '{ truncated');
    fx.task('alpha', live(4, 12));
    const out = render(fx.dir, { cwd: fx.dir });
    assert.match(out, /router ▶ alpha /);
    assert.doesNotMatch(out, /broken/);
  } finally {
    fx.cleanup();
  }
});

test('no .router at all renders the plain marker, not a crash', () => {
  const fx = repo();
  try {
    const out = render(fx.dir, { cwd: fx.dir });
    assert.equal(out.trim(), 'router');
  } finally {
    fx.cleanup();
  }
});
