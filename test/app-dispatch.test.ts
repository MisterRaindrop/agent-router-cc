// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from '../testkit/gitRepo.ts';
import { routerPaths } from '../src/io/paths.ts';
import { fixedClock } from '../src/io/clock.ts';
import { orderByQuota, dispatchTask } from '../src/app/dispatch.ts';

const NODE = process.execPath;
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));

const POLICY = `schema_version: 1
worker:
  kind: codex
scope:
  test_globs: ["tests/**"]
  max_changed_lines: 400
verification:
  build:
    - ["${NODE}", "-e", "process.exit(0)"]
  test:
    - ["${NODE}", "-e", "process.exit(0)"]
`;
const TASK_YAML = `schema_version: 1
id: t1
title: demo
base_sha: null
max_wall_minutes: 1
allowed_globs: ["src/**"]
build_ref: build
test_ref: test
`;
const CONTRACT = '# Contract\nEdit src.\n';

function setup(policy = POLICY): { repo: string; paths: ReturnType<typeof routerPaths>; deps: { paths: ReturnType<typeof routerPaths>; clock: ReturnType<typeof fixedClock> } } {
  const repo = fx.initRepo();
  fx.write(repo, 'src/a.ts', 'export const x = 1;\n');
  fx.write(repo, '.router/policy.yaml', policy);
  fx.write(repo, '.gitignore', '.router/worktrees/\n');
  fx.addCommit(repo, 'base');
  const paths = routerPaths(join(repo, '.router'));
  return { repo, paths, deps: { paths, clock: fixedClock('2026-07-15T00:00:00.000Z') } };
}

function stageTask(paths: ReturnType<typeof routerPaths>): void {
  mkdirSync(paths.taskDir('t1'), { recursive: true });
  writeFileSync(paths.taskYaml('t1'), TASK_YAML);
  writeFileSync(paths.contractMd('t1'), CONTRACT);
}

test('dispatchTask runs the executor synchronously to a PASSED verifier result', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths, deps } = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions'); // force fallback (no quota data)
  try {
    stageTask(paths);
    const result = await dispatchTask(deps, 't1');
    assert.equal(result.exit_class, 'ok');
    assert.equal(result.verifier?.result, 'PASSED');
    assert.equal(result.worker.kind, 'codex');
    // the verified diff is on the run branch inside the worktree
    assert.match(readFileSync(join(paths.worktree('t1', 'run-001'), 'src', 'a.ts'), 'utf8'), /fake codex/);
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }
});

test('orderByQuota puts the executor with the most real headroom first', () => {
  const twoWorkers = POLICY.replace('worker:\n  kind: codex', 'workers:\n  - kind: codex\n  - kind: claude');
  const { repo, paths } = setup(twoWorkers);
  const sessions = join(repo, 'codex-sessions', '2026', '07', '15');
  mkdirSync(sessions, { recursive: true });
  // codex 90% used; claude 10% used -> claude should lead.
  writeFileSync(
    join(sessions, 'rollout-x.jsonl'),
    JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 90, window_minutes: 300, resets_at: 1 }, rate_limit_reached_type: null } } }) + '\n',
  );
  writeFileSync(join(paths.root, 'usage.json'), JSON.stringify({ used_percent: 10, resets_at: 2, reached: false }));
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'codex-sessions');
  try {
    const workers = [{ kind: 'codex' as const }, { kind: 'claude' as const }];
    const { order } = orderByQuota(paths, workers);
    assert.equal(order[0]!.kind, 'claude');
    assert.equal(order[1]!.kind, 'codex');
  } finally {
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }
});
