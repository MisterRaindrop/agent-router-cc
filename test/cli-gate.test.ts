// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// End-to-end through the CLI: dispatch a task, then verify it in the "real" checkout via the
// serial queue. The queue's internals are covered in app-gate-queue.test.ts; what is proved
// here is the wiring -- the verb reads the config, refuses when the project does not use a
// queue, reports the holder, and moves the integration branch only on a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
const NODE = process.execPath;
const INTEGRATION = 'router/integration';

function router(dir: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(NODE, [ENTRY, ...argv], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...envExtra },
        timeout: 60_000,
      }),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/** A repo with a dispatched, PASSED task waiting to be verified. */
function setup(gateArgv: string[][]): { dir: string; env: NodeJS.ProcessEnv } {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(dir, '.gitignore', '.router/\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  router(dir, ['new', 't1'], env);
  mkdirSync(join(dir, '.router'), { recursive: true });
  writeFileSync(
    join(dir, '.router', 'gate.yaml'),
    `mode: queue\nintegration_branch: ${INTEGRATION}\ngate:\n${gateArgv
      .map((argv) => `  - ${JSON.stringify(argv)}`)
      .join('\n')}\n`,
  );
  assert.equal(router(dir, ['dispatch', 't1', '--json'], env).code, 0);
  return { dir, env };
}

test('gate --status reports the mode and that nothing holds the checkout', () => {
  const { dir, env } = setup([[NODE, '-e', 'process.exit(0)']]);
  try {
    const s = router(dir, ['gate', '--status', '--json'], env);
    assert.equal(s.code, 0, s.out);
    const out = JSON.parse(s.out) as Record<string, unknown>;
    assert.equal(out.mode, 'queue');
    assert.equal(out.integration_branch, INTEGRATION);
    assert.equal(out.holder, null);
  } finally {
    fx.cleanup(dir);
  }
});

test('a passing gate moves the integration branch and leaves the checkout where it was', () => {
  const { dir, env } = setup([[NODE, '-e', 'process.exit(0)']]);
  try {
    const before = fx.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const g = router(dir, ['gate', 't1', '--json'], env);
    assert.equal(g.code, 0, g.out);
    const out = JSON.parse(g.out) as { ok: boolean; results: { id: string; gate: Record<string, unknown> }[] };
    assert.equal(out.ok, true);
    assert.equal(out.results[0]?.gate.integration_branch, INTEGRATION);
    assert.equal(out.results[0]?.gate.level, 'task');

    // The task's change is on the integration branch, and the user is back on their branch
    // with nothing of ours left behind.
    const integration = fx.git(dir, ['show', `${INTEGRATION}:src/a.ts`]);
    assert.match(integration, /edited by fake codex/);
    assert.equal(fx.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), before);
    assert.equal(fx.git(dir, ['status', '--porcelain']).trim(), '');
    assert.equal(existsSync(join(dir, '.router', 'gate.lock')), false);
    // Evidence is a file path, never inlined output.
    const logPath = out.results[0]?.gate.log as string;
    assert.ok(existsSync(logPath), logPath);
  } finally {
    fx.cleanup(dir);
  }
});

test('a failing gate reports it, keeps the integration branch put, and exits non-zero', () => {
  // Fails only once the task's edit is present: a genuine regression, not a gate that was
  // already red (which is reported separately as gate_failed_pre_existing).
  const { dir, env } = setup([
    [NODE, '-e', 'process.exit(require("node:fs").readFileSync("src/a.ts","utf8").includes("fake codex") ? 4 : 0)'],
  ]);
  try {
    const integrationBefore = fx.git(dir, ['rev-parse', 'HEAD']).trim();
    const g = router(dir, ['gate', 't1', '--json'], env);
    assert.equal(g.code, 1, g.out);
    const out = JSON.parse(g.out) as { ok: boolean; results: { gate: Record<string, unknown> }[] };
    assert.equal(out.ok, false);
    assert.equal(out.results[0]?.gate.reason, 'gate_failed');
    assert.equal(out.results[0]?.gate.rc, 4);
    assert.equal(fx.git(dir, ['rev-parse', INTEGRATION]).trim(), integrationBefore);
    assert.equal(existsSync(join(dir, '.router', 'gate.lock')), false);
  } finally {
    fx.cleanup(dir);
  }
});

test('a dirty checkout is refused rather than stashed', () => {
  const { dir, env } = setup([[NODE, '-e', 'process.exit(0)']]);
  try {
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const x = 99; // the user is mid-edit\n');
    const g = router(dir, ['gate', 't1', '--json'], env);
    assert.equal(g.code, 1, g.out);
    const out = JSON.parse(g.out) as { results: { gate: Record<string, unknown> }[] };
    assert.equal(out.results[0]?.gate.reason, 'checkout_dirty');
    // Their edit is untouched: refusing must never "tidy up" someone's work.
    assert.match(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /the user is mid-edit/);
  } finally {
    fx.cleanup(dir);
  }
});

test('gate refuses on a project that verifies inside the worktree', () => {
  const { dir, env } = setup([[NODE, '-e', 'process.exit(0)']]);
  try {
    writeFileSync(join(dir, '.router', 'gate.yaml'), 'mode: worktree\n');
    const g = router(dir, ['gate', 't1'], env);
    assert.equal(g.code, 2, g.out);
    assert.match(g.out, /nothing to queue/);
  } finally {
    fx.cleanup(dir);
  }
});
