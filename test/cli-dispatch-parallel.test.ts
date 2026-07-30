// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE_BARRIER = fileURLToPath(new URL('../testkit/fakeCodexBarrier.mjs', import.meta.url));
const FAKE_SCOPED = fileURLToPath(new URL('../testkit/fakeCodexScoped.mjs', import.meta.url));
const NODE = process.execPath;

function router(dir: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...envExtra },
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

function setup(): string {
  const dir = fx.initRepo();
  fx.write(dir, 'src/base.ts', 'export const base = true;\n');
  fx.addCommit(dir, 'base');
  return dir;
}

// `apiKeyEnv` is the task's `worker.api_key_env`: the one explicit opt-in that lets a
// named variable through the executor environment allowlist (io/env.ts). The barrier
// fake needs its rendezvous directory, so the test smuggles it through that door.
function stageTask(dir: string, id: string, apiKeyEnv?: string): void {
  router(dir, ['new', id]);
  writeFileSync(
    join(dir, '.router', 'tasks', id, 'task.yaml'),
    `schema_version: 1
id: ${id}
title: ${id}
max_wall_minutes: 1
allowed_globs: ["src/${id}.ts"]
worker:
  kind: codex
${apiKeyEnv ? `  api_key_env: ${apiKeyEnv}\n` : ''}verify: []
`,
  );
}

test('batch dispatch overlaps executor runs and preserves input-ordered results', () => {
  chmodSync(FAKE_BARRIER, 0o755);
  const dir = setup();
  const barrierDir = mkdtempSync(join(tmpdir(), 'router-barrier-'));
  try {
    stageTask(dir, 'p1', 'ROUTER_TEST_BARRIER_DIR');
    stageTask(dir, 'p2', 'ROUTER_TEST_BARRIER_DIR');
    const d = router(dir, ['dispatch', 'p1', 'p2', '--json'], {
      ROUTER_CODEX_BIN: FAKE_BARRIER,
      ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions'),
      ROUTER_TEST_BARRIER_DIR: barrierDir,
    });
    assert.equal(d.code, 0, d.out);
    const out = JSON.parse(d.out) as {
      ok: boolean;
      parallel: number;
      results: { id: string; verifier: string }[];
    };
    assert.equal(out.ok, true);
    assert.equal(out.parallel, 2);
    assert.deepEqual(out.results.map((result) => result.id), ['p1', 'p2']);
    assert.deepEqual(out.results.map((result) => result.verifier), ['PASSED', 'PASSED']);
    assert.equal(existsSync(join(dir, '.router', 'worktrees', 'p1', 'run-001')), true);
    assert.equal(existsSync(join(dir, '.router', 'worktrees', 'p2', 'run-001')), true);
    const branches = fx.git(dir, ['branch', '--format=%(refname:short)']);
    assert.match(branches, /^router\/p1\/run-001$/m);
    assert.match(branches, /^router\/p2\/run-001$/m);
    const metrics = readFileSync(join(dir, '.router', 'metrics.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(metrics.length, 2);
    assert.deepEqual(new Set(metrics.map((row: { task_id: string }) => row.task_id)), new Set(['p1', 'p2']));
  } finally {
    rmSync(barrierDir, { recursive: true, force: true });
    fx.cleanup(dir);
  }
});

test('batch dispatch keeps every task diff scoped to its own file', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = setup();
  try {
    stageTask(dir, 'p1');
    stageTask(dir, 'p2');
    const d = router(dir, ['dispatch', 'p1', 'p2', '--json'], {
      ROUTER_CODEX_BIN: FAKE_SCOPED,
      ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions'),
    });
    assert.equal(d.code, 0, d.out);
    for (const id of ['p1', 'p2']) {
      const other = id === 'p1' ? 'p2' : 'p1';
      const patch = readFileSync(join(dir, '.router', 'tasks', id, 'runs', 'run-001', 'diff.patch'), 'utf8');
      assert.match(patch, new RegExp(`src/${id}\\.ts`));
      assert.doesNotMatch(patch, new RegExp(`src/${other}\\.ts`));
    }
  } finally {
    fx.cleanup(dir);
  }
});

// The reported pool has to be the pool that ran: asking for more parallelism than there
// are tasks must not report a concurrency the batch never had.
test('batch dispatch reports the pool it actually used, not the requested cap', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = setup();
  try {
    stageTask(dir, 'p1');
    stageTask(dir, 'p2');
    const d = router(dir, ['dispatch', 'p1', 'p2', '--max-parallel', '8', '--json'], {
      ROUTER_CODEX_BIN: FAKE_SCOPED,
      ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions'),
    });
    assert.equal(d.code, 0, d.out);
    assert.equal((JSON.parse(d.out) as { parallel: number }).parallel, 2);
  } finally {
    fx.cleanup(dir);
  }
});

test('batch land --json stays one document listing every merge', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = setup();
  const env = { ROUTER_CODEX_BIN: FAKE_SCOPED, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    stageTask(dir, 'p1');
    stageTask(dir, 'p2');
    assert.equal(router(dir, ['dispatch', 'p1', 'p2', '--json'], env).code, 0);
    const l = router(dir, ['land', 'p1', 'p2', '--json'], env);
    assert.equal(l.code, 0, l.out);
    const out = JSON.parse(l.out) as { ok: boolean; landed: { id: string; merge_commit: string }[] };
    assert.equal(out.ok, true);
    assert.deepEqual(out.landed.map((entry) => entry.id), ['p1', 'p2']);
    for (const entry of out.landed) assert.match(entry.merge_commit, /^[0-9a-f]{40}$/);
  } finally {
    fx.cleanup(dir);
  }
});
