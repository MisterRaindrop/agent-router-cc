// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// A run that does not end `ok` is never committed, so its work is invisible unless the
// result says where it is. This came from a real run: the executor finished its package and
// its gate passed, then the stall watchdog killed it while it composed its final message --
// the verified work sat uncommitted in the worktree and the result claimed only FAILED.
//
// Also covers the delivery report's write guard: storing the report is auxiliary, so a
// failed write must surface as an error on the result and never take the run down with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from '../testkit/gitRepo.ts';
import { routerPaths } from '../src/io/paths.ts';
import { fixedClock } from '../src/io/clock.ts';
import { dispatchTask } from '../src/app/dispatch.ts';
import { uncommittedSourceFiles, worktreeDirty } from '../src/io/git.ts';

const FAKE_EDIT_THEN_FAIL = fileURLToPath(new URL('../testkit/fakeCodexEditThenFail.mjs', import.meta.url));

const TASK_YAML = `schema_version: 1
id: t1
title: demo
base_sha: null
max_wall_minutes: 1
allowed_globs: ["src/**"]
verify: []
`;

function setup(): { repo: string; paths: ReturnType<typeof routerPaths>; deps: { paths: ReturnType<typeof routerPaths>; clock: ReturnType<typeof fixedClock> } } {
  const repo = fx.initRepo();
  fx.write(repo, 'src/a.ts', 'export const x = 1;\n');
  fx.write(repo, '.gitignore', '.router/worktrees/\n');
  fx.addCommit(repo, 'base');
  const paths = routerPaths(join(repo, '.router'));
  mkdirSync(paths.taskDir('t1'), { recursive: true });
  writeFileSync(paths.taskYaml('t1'), TASK_YAML);
  writeFileSync(paths.contractMd('t1'), '# Contract\nEdit src.\n');
  return { repo, paths, deps: { paths, clock: fixedClock('2026-07-30T00:00:00.000Z') } };
}

function withFakeCodex<T>(bin: string, repo: string, body: () => Promise<T>): Promise<T> {
  const prevBin = process.env.ROUTER_CODEX_BIN;
  const prevSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;
  chmodSync(bin, 0o755);
  process.env.ROUTER_CODEX_BIN = bin;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  const restore = (): void => {
    if (prevBin === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prevBin;
    if (prevSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    else process.env.ROUTER_CODEX_SESSIONS_DIR = prevSessions;
  };
  return body().finally(restore);
}

test('a run that fails after doing work reports the work as recoverable', async () => {
  const { repo, paths, deps } = setup();
  try {
    const result = await withFakeCodex(FAKE_EDIT_THEN_FAIL, repo, () => dispatchTask(deps, 't1'));
    assert.notEqual(result.exit_class, 'ok');
    assert.equal(result.uncommitted_changes, true);
    // The claim has to be true, and the place has changed: the edit is sitting in the user's
    // own checkout now, not in a worktree they would never have thought to look in.
    assert.deepEqual(uncommittedSourceFiles(paths.repoRoot, ['.router']), [' M src/a.ts']);
    assert.match(readFileSync(join(paths.repoRoot, 'src', 'a.ts'), 'utf8'), /edited before failing/);
  } finally {
    fx.cleanup(repo);
  }
});

test('a failed run still stores its delivery report and parses the header', async () => {
  const { repo, paths, deps } = setup();
  try {
    const result = await withFakeCodex(FAKE_EDIT_THEN_FAIL, repo, () => dispatchTask(deps, 't1'));
    assert.ok(result.delivery, 'a failed run must still keep its report');
    assert.equal(result.delivery?.path, paths.delivery('t1', 'run-001'));
    assert.equal(result.delivery?.header?.gate_ran, false);
    assert.equal(result.delivery?.header?.escalate_review, true);
    assert.equal(result.delivery?.header_error, undefined);
    assert.match(readFileSync(paths.delivery('t1', 'run-001'), 'utf8'), /then hit a wall/);
  } finally {
    fx.cleanup(repo);
  }
});

test('a report that cannot be written surfaces the error instead of failing the run', async () => {
  const { repo, paths, deps } = setup();
  try {
    // A directory where the report file belongs makes the write fail deterministically on
    // every platform -- no permission games, and it never leaves the repo unusable.
    const runDir = join(paths.root, 'tasks', 't1', 'runs', 'run-001');
    mkdirSync(join(runDir, 'DELIVERY.md'), { recursive: true });
    const result = await withFakeCodex(FAKE_EDIT_THEN_FAIL, repo, () => dispatchTask(deps, 't1'));
    assert.match(result.delivery?.header_error ?? '', /^write failed: /);
    assert.equal(result.delivery?.header, null);
    // The run itself still produced a result rather than throwing.
    assert.equal(result.task_id, 't1');
    assert.equal(result.uncommitted_changes, true);
  } finally {
    fx.cleanup(repo);
  }
});

test('worktreeDirty reports clean for an untouched checkout and unreadable paths', () => {
  const repo = fx.initRepo();
  try {
    fx.write(repo, 'src/a.ts', 'export const x = 1;\n');
    fx.addCommit(repo, 'base');
    assert.equal(worktreeDirty(repo), false);
    fx.write(repo, 'src/a.ts', 'export const x = 2;\n');
    assert.equal(worktreeDirty(repo), true);
    assert.equal(worktreeDirty(join(repo, 'does-not-exist')), false);
  } finally {
    fx.cleanup(repo);
  }
});
