// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
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
