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
// The script is standalone and imports only its dedicated side-effect-free observer bundle, so
// the honest way to test both pieces is to spawn it exactly as Claude Code does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../statusline/router-usage.mjs', import.meta.url));
const ACTIVITY_MODULE = new URL('../dist/statusline-activity.mjs', import.meta.url).href;
const SPINNER_FRAMES = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'];
const NOW = Date.parse('2026-08-25T12:00:00.000Z');

test('the standalone activity bundle exposes the shared observation API', () => {
  const source = [
    `const activity = await import(${JSON.stringify(ACTIVITY_MODULE)});`,
    "console.log(['observeActivities', 'activityState', 'readActivities']",
    "  .map((name) => typeof activity[name]).join(','));",
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'function,function,function');
});

/** Run a statusline script the way Claude Code does: payload on stdin, output on stdout. */
function renderScript(
  script: string,
  cwd: string,
  payload: unknown = {},
  env: NodeJS.ProcessEnv = {},
): string {
  return execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ROUTER_INNER_STATUSLINE: '', ...env },
  });
}

function render(cwd: string, payload: unknown = {}, env: NodeJS.ProcessEnv = {}): string {
  return renderScript(SCRIPT, cwd, payload, env);
}

interface Fixture {
  dir: string;
  activity(name: string, record: Record<string, unknown>): void;
  status(id: string, status: Record<string, unknown>): string;
  copyWithoutBundle(): string;
  cleanup(): void;
}

function repo(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'router-statusline-'));
  return {
    dir,
    activity(name, record) {
      mkdirSync(join(dir, '.router', 'activity'), { recursive: true });
      writeFileSync(join(dir, '.router', 'activity', `${name}.json`), JSON.stringify(record));
    },
    status(id, status) {
      mkdirSync(join(dir, '.router', 'tasks', id), { recursive: true });
      const path = join(dir, '.router', 'tasks', id, 'status.json');
      writeFileSync(path, JSON.stringify(status));
      return path;
    },
    copyWithoutBundle() {
      const directory = join(dir, 'old-plugin', 'statusline');
      mkdirSync(directory, { recursive: true });
      const copy = join(directory, 'router-usage.mjs');
      copyFileSync(SCRIPT, copy);
      return copy;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function activity(
  label: string,
  options: { now?: number; beatAgeMs?: number; startedAgeMs?: number; statusPath?: string } = {},
): Record<string, unknown> {
  const now = options.now ?? NOW;
  return {
    label,
    owner_token: `owner-${label}`,
    pid: process.pid,
    started_at: new Date(now - (options.startedAgeMs ?? 60_000)).toISOString(),
    beat_at: new Date(now - (options.beatAgeMs ?? 1_000)).toISOString(),
    ...(options.statusPath === undefined ? {} : { status_path: options.statusPath }),
  };
}

function pinned(now: number = NOW): NodeJS.ProcessEnv {
  return { ROUTER_STATUSLINE_NOW: String(now) };
}

function spinnerIn(output: string): string | undefined {
  return SPINNER_FRAMES.find((frame) => output.includes(frame));
}

test('an empty activity directory always renders idle', () => {
  const fx = repo();
  try {
    mkdirSync(join(fx.dir, '.router', 'activity'), { recursive: true });
    assert.equal(render(fx.dir, { cwd: fx.dir }, pinned()).trim(), 'router | router ▶ idle');
  } finally {
    fx.cleanup();
  }
});

test('task status files are enhancements, not an authoritative source of activity', () => {
  const fx = repo();
  try {
    fx.status('ghost', {
      phase: 'executor_working',
      started_at: new Date(NOW - 5 * 60_000).toISOString(),
      budget_minutes: 30,
    });
    const out = render(fx.dir, { cwd: fx.dir }, pinned());
    assert.doesNotMatch(out, /ghost/);
    assert.match(out, /router ▶ idle/);
  } finally {
    fx.cleanup();
  }
});

test('a running activity renders its label, spinner, and status enhancements', () => {
  const fx = repo();
  try {
    const statusPath = fx.status('alpha', {
      phase: 'executor_working',
      started_at: new Date(NOW - 18 * 60_000).toISOString(),
      budget_minutes: 30,
      last_output_at: new Date(NOW - 45_000).toISOString(),
      stall_deadline: new Date(NOW + 3 * 60_000).toISOString(),
      recent_action: 'Bash: npm test',
    });
    fx.activity('alpha', activity('task:alpha', { statusPath }));

    const out = render(fx.dir, { cwd: fx.dir }, pinned());
    const spinner = spinnerIn(out);
    assert.ok(spinner, `expected a spinner frame in: ${out}`);
    assert.ok(out.includes(`router ▶ ${spinner} task:alpha`));
    assert.match(
      out,
      /task:alpha executor_working 18m\/30m ·log 45s ·静默判死 3m · Bash: npm test/,
    );
  } finally {
    fx.cleanup();
  }
});

test('the running spinner changes across two-second refreshes', () => {
  const fx = repo();
  try {
    fx.activity('review', activity('review:architect'));
    const first = spinnerIn(render(fx.dir, { cwd: fx.dir }, pinned(NOW)));
    const second = spinnerIn(render(fx.dir, { cwd: fx.dir }, pinned(NOW + 2_000)));
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first, second);
  } finally {
    fx.cleanup();
  }
});

test('a disconnected activity renders its heartbeat age without spinner or stale phase', () => {
  const fx = repo();
  try {
    const statusPath = fx.status('dead', {
      phase: 'deceptive_verify_phase',
      started_at: new Date(NOW - 20 * 60_000).toISOString(),
      budget_minutes: 30,
    });
    fx.activity(
      'dead',
      activity('task:dead', { beatAgeMs: 3 * 60_000, startedAgeMs: 20 * 60_000, statusPath }),
    );

    const out = render(fx.dir, { cwd: fx.dir }, pinned());
    assert.match(out, /router ▶ task:dead 已失联 3m/);
    assert.doesNotMatch(out, /deceptive_verify_phase/);
    for (const frame of SPINNER_FRAMES) assert.doesNotMatch(out, new RegExp(frame));
  } finally {
    fx.cleanup();
  }
});

test('a malformed activity file does not hide a valid activity', () => {
  const fx = repo();
  try {
    mkdirSync(join(fx.dir, '.router', 'activity'), { recursive: true });
    writeFileSync(join(fx.dir, '.router', 'activity', 'broken.json'), '{ truncated');
    fx.activity('healthy', activity('review:senior'));
    const out = render(fx.dir, { cwd: fx.dir }, pinned());
    const spinner = spinnerIn(out);
    assert.ok(spinner);
    assert.ok(out.includes(`router ▶ ${spinner} review:senior`));
    assert.doesNotMatch(out, /broken/);
  } finally {
    fx.cleanup();
  }
});

// Chaining is how router coexists with a HUD the user already chose. If this breaks, the fix for
// the path regression is unreachable: wiring router in would cost them their existing statusline.
test('an inner statusline is preserved and router appends after it', () => {
  const fx = repo();
  try {
    // Reads stdin, as a real statusline does -- it needs the session JSON.
    const inner = "cat >/dev/null; printf 'my-hud: ctx 42%%'";
    const out = render(fx.dir, { cwd: fx.dir }, { ...pinned(), ROUTER_INNER_STATUSLINE: inner });
    assert.equal(out, 'my-hud: ctx 42% | router ▶ idle');
  } finally {
    fx.cleanup();
  }
});

// The case that only failed on Linux. A statusline that exits without draining stdin makes the
// parent's write fail with EPIPE; dash does this where bash does not. That used to be caught and
// turned into the bare word "router", so the user silently lost their whole HUD line because
// their HUD ignored a pipe it never asked for.
test('an inner statusline that ignores stdin still has its output kept', () => {
  const fx = repo();
  try {
    const out = render(fx.dir, { cwd: fx.dir }, {
      ...pinned(),
      ROUTER_INNER_STATUSLINE: "printf 'no-stdin-hud'",
    });
    assert.equal(out, 'no-stdin-hud | router ▶ idle');
  } finally {
    fx.cleanup();
  }
});

test('an inner statusline that prints nothing falls back to the plain marker', () => {
  const fx = repo();
  try {
    const out = render(fx.dir, { cwd: fx.dir }, {
      ...pinned(),
      ROUTER_INNER_STATUSLINE: 'true',
    });
    assert.equal(out.trim(), 'router | router ▶ idle');
  } finally {
    fx.cleanup();
  }
});

test('a missing activity bundle omits only the activity segment and preserves the inner output', () => {
  const fx = repo();
  try {
    const script = fx.copyWithoutBundle();
    const inner = "printf '%s' 'legacy-hud: ctx 42%'";
    const out = renderScript(script, fx.dir, { cwd: fx.dir }, { ROUTER_INNER_STATUSLINE: inner });
    assert.equal(out, 'legacy-hud: ctx 42%');
  } finally {
    fx.cleanup();
  }
});

test('no .router at all still renders idle, not a crash', () => {
  const fx = repo();
  try {
    const out = render(fx.dir, { cwd: fx.dir }, pinned());
    assert.equal(out.trim(), 'router | router ▶ idle');
  } finally {
    fx.cleanup();
  }
});
