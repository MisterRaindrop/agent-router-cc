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
const FAKE_CODEX_QUOTA = fileURLToPath(new URL('../testkit/fakeCodexQuota.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../testkit/fakeClaude.mjs', import.meta.url));
const NODE = process.execPath;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function router(dir: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ROUTER_CODEX_BIN: FAKE_CODEX, ...envExtra },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? '' };
  }
}

function repo(): string {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(
    dir,
    '.router/policy.yaml',
    `schema_version: 1\nmax_concurrent_workers: 1\nworker:\n  kind: codex\n  api_key_env: OPENAI_API_KEY\n  stall_minutes: 1\nscope:\n  test_globs: ["tests/**"]\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n`,
  );
  fx.addCommit(dir, 'base');
  return dir;
}

async function waitTerminal(dir: string, id: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = JSON.parse(router(dir, ['status', id, '--json']).out);
    if (['PASSED', 'FAILED', 'MERGED', 'STALE', 'CANCELLED'].includes(s.state)) return s.state;
    if (Date.now() > deadline) return `TIMEOUT(${s.state})`;
    await sleep(150);
  }
}

test('end-to-end: run (detached worker + fake codex) reaches PASSED, then merge', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = repo();
  try {
    assert.equal(router(dir, ['new', 'e2e', '--title', 'E2E']).code, 0);
    assert.equal(router(dir, ['validate', 'e2e']).code, 0);
    assert.equal(router(dir, ['queue', 'e2e']).code, 0);

    const started = JSON.parse(router(dir, ['run', 'e2e', '--json']).out);
    assert.equal(started.state, 'RUNNING');
    assert.ok(started.run);

    const final = await waitTerminal(dir, 'e2e');
    assert.equal(final, 'PASSED', `expected PASSED, got ${final}`);

    const res = JSON.parse(router(dir, ['result', 'e2e', '--json']).out);
    assert.equal(res.result.verifier.result, 'PASSED');
    assert.equal(res.result.exit_class, 'ok');
    assert.equal(res.result.worker.model, 'fake-model-1'); // model from --json stream

    // the worker's edit is on the run branch; merge fast-forwards it into main
    assert.equal(router(dir, ['merge', 'e2e']).code, 0);
    const st = JSON.parse(router(dir, ['status', 'e2e', '--json']).out);
    assert.equal(st.state, 'MERGED');
    assert.match(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /fake codex/);
  } finally {
    fx.cleanup(dir);
  }
});

test('end-to-end: codex quota -> falls back to claude executor -> PASSED', async () => {
  chmodSync(FAKE_CODEX_QUOTA, 0o755);
  chmodSync(FAKE_CLAUDE, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(
    dir,
    '.router/policy.yaml',
    `schema_version: 1\nmax_concurrent_workers: 1\nworkers:\n  - kind: codex\n  - kind: claude\nscope:\n  test_globs: ["tests/**"]\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n`,
  );
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX_QUOTA, ROUTER_CLAUDE_BIN: FAKE_CLAUDE };
  try {
    router(dir, ['new', 'fb'], env);
    router(dir, ['validate', 'fb'], env);
    router(dir, ['queue', 'fb'], env);
    router(dir, ['run', 'fb'], env);
    // poll (status doesn't need the fake env)
    const deadline = Date.now() + 20_000;
    let state = 'RUNNING';
    for (;;) {
      state = JSON.parse(router(dir, ['status', 'fb', '--json']).out).state;
      if (['PASSED', 'FAILED', 'STALE', 'CANCELLED'].includes(state)) break;
      if (Date.now() > deadline) break;
      await sleep(150);
    }
    assert.equal(state, 'PASSED', `expected PASSED, got ${state}`);
    const res = JSON.parse(router(dir, ['result', 'fb', '--json']).out);
    assert.equal(res.result.exit_class, 'ok');
    assert.equal(res.result.worker.kind, 'claude'); // final executor was the fallback
    assert.equal(res.result.executor_switches, 1);
    assert.equal(res.result.cost_usd, 0.0123); // claude's reported total_cost_usd
    assert.match(readFileSync(join(dir, '.router', 'worktrees', 'fb', 'run-001', 'src', 'a.ts'), 'utf8'), /fake claude/);
  } finally {
    fx.cleanup(dir);
  }
});

test('end-to-end: stats reflects the verified run', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = repo();
  try {
    router(dir, ['new', 'e2e']);
    router(dir, ['validate', 'e2e']);
    router(dir, ['queue', 'e2e']);
    router(dir, ['run', 'e2e']);
    await waitTerminal(dir, 'e2e');
    const stats = JSON.parse(router(dir, ['stats', '--json']).out);
    assert.equal(stats.verifiedRuns, 1);
  } finally {
    fx.cleanup(dir);
  }
});
