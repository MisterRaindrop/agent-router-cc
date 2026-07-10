// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE_PLANNER = fileURLToPath(new URL('../testkit/fakeClaudePlanner.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
const NODE = process.execPath;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function router(dir: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...envExtra } });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

function repo(): string {
  const dir = fx.initRepo();
  fx.write(dir, 'src/slugify.mjs', 'export const x=1;\n');
  fx.write(
    dir,
    '.router/policy.yaml',
    'schema_version: 1\nworker:\n  kind: codex\nscope:\n  max_changed_lines: 400\nverification:\n  build:\n    - ["node", "-e", "0"]\n  test:\n    - ["node", "-e", "0"]\n',
  );
  fx.addCommit(dir, 'base');
  return dir;
}

test('router plan materializes a DRAFT task from a valid proposal', () => {
  chmodSync(FAKE_PLANNER, 0o755);
  const dir = repo();
  try {
    const r = router(dir, ['plan', 'implement slugify', '--json'], { ROUTER_CLAUDE_BIN: FAKE_PLANNER, ROUTER_FAKE_PLAN: 'valid' });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.out);
    assert.equal(out.id, 'slugify');
    const st = JSON.parse(router(dir, ['status', 'slugify', '--json']).out);
    assert.equal(st.state, 'DRAFT');
  } finally {
    fx.cleanup(dir);
  }
});

test('router plan rejects a broad-scope proposal and creates no task', () => {
  chmodSync(FAKE_PLANNER, 0o755);
  const dir = repo();
  try {
    const r = router(dir, ['plan', 'do everything'], { ROUTER_CLAUDE_BIN: FAKE_PLANNER, ROUTER_FAKE_PLAN: 'broad' });
    assert.equal(r.code, 1);
    assert.match(r.out, /too broad/);
    assert.equal(existsSync(`${dir}/.router/tasks/slugify`), false);
  } finally {
    fx.cleanup(dir);
  }
});

test('router plan --execute runs the pipeline to PASSED', async () => {
  chmodSync(FAKE_PLANNER, 0o755);
  chmodSync(FAKE_CODEX, 0o755);
  // fakeCodex edits src/a.ts; the valid proposal's allowed_globs is src/**, which covers it.
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(
    dir,
    '.router/policy.yaml',
    `schema_version: 1\nworker:\n  kind: codex\nscope:\n  test_globs: ["tests/**"]\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n`,
  );
  fx.addCommit(dir, 'base');
  try {
    const r = router(dir, ['plan', 'edit a', '--execute', '--json'], {
      ROUTER_CLAUDE_BIN: FAKE_PLANNER,
      ROUTER_FAKE_PLAN: 'valid',
      ROUTER_CODEX_BIN: FAKE_CODEX,
    });
    assert.equal(r.code, 0);
    let state = 'RUNNING';
    for (let i = 0; i < 40; i++) {
      state = JSON.parse(router(dir, ['status', 'slugify', '--json']).out).state;
      if (['PASSED', 'FAILED'].includes(state)) break;
      await sleep(200);
    }
    assert.equal(state, 'PASSED', `expected PASSED, got ${state}`);
  } finally {
    fx.cleanup(dir);
  }
});
