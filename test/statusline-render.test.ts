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
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    cwd,
    env: { ...process.env, ROUTER_INNER_STATUSLINE: '', ...env },
  });
}

function renderRaw(
  cwd: string,
  raw: string,
  env: NodeJS.ProcessEnv = {},
  timeout: number = 5_000,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: raw,
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ROUTER_INNER_STATUSLINE: '', ...env },
    timeout,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
  return {
    NODE_ENV: 'test',
    ROUTER_STATUSLINE_TEST_CLOCK: '1',
    ROUTER_STATUSLINE_NOW: String(now),
  };
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

test('a status_path outside the current task directory is ignored', () => {
  const fx = repo();
  try {
    // Every real repository has this directory. Without it, lstat on `.router/tasks` throws and
    // the path is rejected for the wrong reason -- which let a mutation that removes the in-tree
    // rule entirely keep this test green (main-session mutation, 2026-08-25).
    mkdirSync(join(fx.dir, '.router', 'tasks'), { recursive: true });
    const outside = join(fx.dir, 'outside-status.json');
    writeFileSync(outside, JSON.stringify({ phase: 'outside-secret-phase' }));
    fx.activity('outside', activity('task:outside', { statusPath: outside }));

    const out = render(fx.dir, { cwd: fx.dir }, pinned());
    assert.match(out, /task:outside/);
    assert.doesNotMatch(out, /outside-secret-phase/);
  } finally {
    fx.cleanup();
  }
});

// The name alone is not the rule: a file genuinely called status.json, sitting anywhere other
// than `.router/tasks/<id>/`, must still be ignored. This is the case the basename check cannot
// decide and only the parent-directory check can.
test('a file named status.json outside .router/tasks is still ignored', () => {
  const fx = repo();
  try {
    mkdirSync(join(fx.dir, '.router', 'tasks'), { recursive: true });
    const decoy = join(fx.dir, 'status.json');
    writeFileSync(decoy, JSON.stringify({ phase: 'decoy-secret-phase' }));
    fx.activity('decoy', activity('task:decoy', { statusPath: decoy }));

    const sibling = join(fx.dir, '.router', 'status.json');
    writeFileSync(sibling, JSON.stringify({ phase: 'sibling-secret-phase' }));
    fx.activity('sibling', activity('task:sibling', { statusPath: sibling }));

    const out = render(fx.dir, { cwd: fx.dir }, pinned());
    assert.match(out, /task:decoy/);
    assert.match(out, /task:sibling/);
    assert.doesNotMatch(out, /decoy-secret-phase/);
    assert.doesNotMatch(out, /sibling-secret-phase/);
  } finally {
    fx.cleanup();
  }
});

test('a FIFO status_path is rejected without blocking the statusline', () => {
  const fx = repo();
  try {
    const taskDir = join(fx.dir, '.router', 'tasks', 'fifo');
    mkdirSync(taskDir, { recursive: true });
    const fifo = join(taskDir, 'status.json');
    execFileSync('mkfifo', [fifo]);
    fx.activity('fifo', activity('task:fifo', { statusPath: fifo }));

    const result = renderRaw(
      fx.dir,
      JSON.stringify({ cwd: fx.dir }),
      pinned(),
      1_500,
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /task:fifo/);
  } finally {
    fx.cleanup();
  }
});

test('a symbolic-link status_path is ignored', () => {
  const fx = repo();
  try {
    const target = join(fx.dir, 'symlink-target.json');
    writeFileSync(target, JSON.stringify({ phase: 'symlink-secret-phase' }));
    const taskDir = join(fx.dir, '.router', 'tasks', 'linked');
    mkdirSync(taskDir, { recursive: true });
    const link = join(taskDir, 'status.json');
    symlinkSync(target, link);
    fx.activity('linked', activity('task:linked', { statusPath: link }));

    const out = render(fx.dir, { cwd: fx.dir }, pinned());
    assert.match(out, /task:linked/);
    assert.doesNotMatch(out, /symlink-secret-phase/);
  } finally {
    fx.cleanup();
  }
});

test('a status file over the read limit is ignored', () => {
  const fx = repo();
  try {
    const path = fx.status('oversized', {
      phase: 'oversized-secret-phase',
      padding: 'x'.repeat(64 * 1024),
    });
    fx.activity('oversized', activity('task:oversized', { statusPath: path }));

    const out = render(fx.dir, { cwd: fx.dir }, pinned());
    assert.match(out, /task:oversized/);
    assert.doesNotMatch(out, /oversized-secret-phase/);
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

test('the production entry ignores ROUTER_STATUSLINE_NOW without both test-only gates', () => {
  const fx = repo();
  try {
    const actualNow = Date.now();
    fx.activity('clock', activity('review:clock', { now: actualNow }));
    const out = render(fx.dir, { cwd: fx.dir }, {
      NODE_ENV: 'production',
      ROUTER_STATUSLINE_TEST_CLOCK: '',
      ROUTER_STATUSLINE_NOW: String(actualNow + 24 * 60 * 60 * 1000),
    });
    assert.ok(spinnerIn(out), `expected a live spinner in: ${out}`);
    assert.match(out, /review:clock/);
    assert.doesNotMatch(out, /已失联/);
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

test('a hung inner statusline returns within the refresh period and keeps prior stdout', () => {
  const fx = repo();
  try {
    mkdirSync(join(fx.dir, '.router', 'activity'), { recursive: true });
    const startedAt = Date.now();
    const result = renderRaw(
      fx.dir,
      JSON.stringify({ cwd: fx.dir }),
      {
        ...pinned(),
        ROUTER_INNER_STATUSLINE: "printf 'partial-hud'; sleep 10",
      },
      2_500,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'partial-hud | router ▶ idle');
    assert.ok(Date.now() - startedAt < 2_000, 'statusline exceeded its two-second refresh period');
  } finally {
    fx.cleanup();
  }
});

function assertMalformedInputKeepsHud(raw: string): void {
  const fx = repo();
  try {
    mkdirSync(join(fx.dir, '.router', 'activity'), { recursive: true });
    const result = renderRaw(fx.dir, raw, {
      ...pinned(),
      ROUTER_INNER_STATUSLINE: "printf 'malformed-input-hud'",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'malformed-input-hud | router ▶ idle');
  } finally {
    fx.cleanup();
  }
}

test('literal null stdin preserves the complete inner HUD and exits zero', () => {
  assertMalformedInputKeepsHud('null');
});

test('a numeric cwd preserves the complete inner HUD and exits zero', () => {
  assertMalformedInputKeepsHud('{"cwd":42}');
});

test('a numeric workspace current_dir preserves the complete inner HUD and exits zero', () => {
  assertMalformedInputKeepsHud('{"workspace":{"current_dir":123}}');
});

for (const [name, raw] of [
  ['numeric', '42'],
  ['array', '[]'],
  ['non-JSON', 'not json'],
  ['empty', ''],
  ['oversized', 'x'.repeat(2 * 1024 * 1024)],
] as const) {
  test(`${name} stdin preserves the complete inner HUD and exits zero`, () => {
    assertMalformedInputKeepsHud(raw);
  });
}

// The read itself is bounded, not just the parse. This runs before the inner HUD starts, so an
// oversized payload must not be buffered whole just to be discarded afterwards.
test('an oversized stdin payload is not buffered whole and the inner HUD still runs', () => {
  const fx = repo();
  try {
    mkdirSync(join(fx.dir, '.router', 'activity'), { recursive: true });
    const oversized = JSON.stringify({ cwd: fx.dir, pad: 'x'.repeat(2 * 1024 * 1024) });
    const out = execFileSync(process.execPath, [SCRIPT], {
      input: oversized,
      encoding: 'utf8',
      // The writer may see EPIPE once we stop reading; that is the caller's business, not ours.
      env: { ...process.env, ...pinned(), ROUTER_INNER_STATUSLINE: "cat >/dev/null; printf 'my-hud'" },
    });
    assert.match(out, /^my-hud/, `inner HUD was lost: ${out}`);
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
