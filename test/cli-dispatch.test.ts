// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
const FAKE_SCOPED = fileURLToPath(new URL('../testkit/fakeCodexScoped.mjs', import.meta.url));
const NODE = process.execPath;

function router(dir: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...envExtra } });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

test('dispatch -> land: synchronous run to a verified diff, then merge', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(
    dir,
    '.router/policy.yaml',
    `schema_version: 1\nworker:\n  kind: codex\nscope:\n  test_globs: ["tests/**"]\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n`,
  );
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    // task.yaml default allowed_globs is src/**; fakeCodex edits src/a.ts.
    const d = router(dir, ['dispatch', 'demo', '--json'], env);
    assert.equal(d.code, 0, d.out);
    const out = JSON.parse(d.out);
    assert.equal(out.verifier, 'PASSED');
    assert.equal(out.executor, 'codex');
    // land merges the verified branch into the working tree.
    const l = router(dir, ['land', 'demo']);
    assert.equal(l.code, 0, l.out);
    assert.match(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /fake codex/);
    // land deletes the run branch, so it must hand back the merge commit -- the only
    // remaining handle on what the task changed.
    const sha = /-> ([0-9a-f]{12})/.exec(l.out)?.[1];
    assert.ok(sha !== undefined, `land output should carry the merge commit: ${l.out}`);
    assert.match(fx.git(dir, ['show', '--stat', sha]), /src\/a\.ts/);
    const landed = JSON.parse(readFileSync(join(dir, '.router', 'tasks', 'demo', 'runs', 'run-001', 'result.json'), 'utf8'));
    assert.match(landed.merge_commit, new RegExp(`^${sha}`));
  } finally {
    fx.cleanup(dir);
  }
});

test('policy-free + no init: dispatch uses the task-carried verify command', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base'); // NB: no .router, no policy.yaml, no `router init`
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') };
  try {
    // `new` auto-scaffolds .router (no init needed); then author the task with a verify cmd.
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    writeFileSync(
      join(dir, '.router', 'tasks', 'demo', 'task.yaml'),
      `schema_version: 1\nid: demo\ntitle: Demo\nmax_wall_minutes: 1\nallowed_globs: ["src/**"]\nmax_changed_lines: 400\nverify: [[${JSON.stringify(NODE)}, "-e", "process.exit(0)"]]\n`,
    );
    const jsonLine = (out: string): Record<string, unknown> =>
      JSON.parse(out.split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? '{}');
    const ok = jsonLine(router(dir, ['dispatch', 'demo', '--json'], env).out);
    assert.equal(ok.verifier, 'PASSED');

    // a failing verify command -> FAILED (fresh id to avoid the prior run branch)
    router(dir, ['new', 'demo2', '--title', 'Demo2'], env);
    writeFileSync(
      join(dir, '.router', 'tasks', 'demo2', 'task.yaml'),
      `schema_version: 1\nid: demo2\ntitle: Demo2\nmax_wall_minutes: 1\nallowed_globs: ["src/**"]\nverify: [[${JSON.stringify(NODE)}, "-e", "process.exit(1)"]]\n`,
    );
    const bad = router(dir, ['dispatch', 'demo2', '--json'], env);
    assert.equal(bad.code, 1);
    assert.equal(jsonLine(bad.out).verifier, 'FAILED');
  } finally {
    fx.cleanup(dir);
  }
});

test('land refuses when there is no PASSED dispatch result', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(dir, '.router/policy.yaml', `schema_version: 1\nworker:\n  kind: codex\nscope:\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "0"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "0"]\n`);
  fx.addCommit(dir, 'base');
  try {
    router(dir, ['new', 'demo']);
    const l = router(dir, ['land', 'demo']);
    assert.equal(l.code, 1);
    assert.match(l.out, /no dispatch result/);
  } finally {
    fx.cleanup(dir);
  }
});

test('dispatch rejects --max-parallel below one', () => {
  const dir = fx.initRepo();
  try {
    const d = router(dir, ['dispatch', 'demo', '--max-parallel', '0']);
    assert.equal(d.code, 2, d.out);
    assert.match(d.out, /--max-parallel must be an integer >= 1/);
  } finally {
    fx.cleanup(dir);
  }
});

test('batch land merges PASSED tasks sequentially in the given order', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/base.ts', 'export const base = true;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_SCOPED, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    for (const id of ['p1', 'p2']) {
      router(dir, ['new', id], env);
      writeFileSync(
        join(dir, '.router', 'tasks', id, 'task.yaml'),
        `schema_version: 1\nid: ${id}\ntitle: ${id}\nmax_wall_minutes: 1\nallowed_globs: ["src/${id}.ts"]\nworker: {kind: codex}\nverify: []\n`,
      );
    }
    const d = router(dir, ['dispatch', 'p1', 'p2', '--json'], env);
    assert.equal(d.code, 0, d.out);
    const l = router(dir, ['land', 'p1', 'p2']);
    assert.equal(l.code, 0, l.out);
    assert.match(l.out, /^p1 landed /);
    assert.match(l.out, /\np2 landed /);
    assert.match(readFileSync(join(dir, 'src', 'p1.ts'), 'utf8'), /p1/);
    assert.match(readFileSync(join(dir, 'src', 'p2.ts'), 'utf8'), /p2/);
    assert.equal(fx.git(dir, ['log', '-2', '--pretty=%s']).trim(), "Merge branch 'router/p2/run-001'\nMerge branch 'router/p1/run-001'");
  } finally {
    fx.cleanup(dir);
  }
});
