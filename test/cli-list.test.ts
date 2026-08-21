// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const NODE = process.execPath;
const RUN = 'run-001';

function router(dir: string, argv: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

function writeTask(dir: string, id: string, title: string): void {
  const taskDir = join(dir, '.router', 'tasks', id);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.yaml'), `id: ${id}\ntitle: ${title}\n`);
}

function writeResult(dir: string, id: string, extra: Record<string, unknown>): void {
  const runDir = join(dir, '.router', 'tasks', id, 'runs', RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'result.json'),
    JSON.stringify({ run_id: RUN, task_id: id, exit_class: 'completed', ...extra }),
  );
}

test('list shows risk and delivery-report presence in table and JSON', () => {
  const dir = fx.initRepo();
  try {
    writeTask(dir, 'no-run', 'No recorded run');
    writeTask(dir, 'risk-report', 'Risk and report');
    writeTask(dir, 'plain-run', 'Neither signal');
    writeResult(dir, 'risk-report', {
      risk: 'high',
      delivery: { path: '/tmp/DELIVERY.md', header: null },
    });
    writeResult(dir, 'plain-run', {});

    const text = router(dir, ['list']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /id\s+status\s+branch\s+risk\s+report\s+title/);
    assert.match(text.out, /no-run\s+none\s+-\s+-\s+-\s+No recorded run/);
    assert.match(text.out, /risk-report\s+completed\s+-\s+high\s+yes\s+Risk and report/);
    assert.match(text.out, /plain-run\s+completed\s+-\s+-\s+-\s+Neither signal/);

    const json = router(dir, ['list', '--json']);
    assert.equal(json.code, 0, json.out);
    const rows = (JSON.parse(json.out) as { tasks: Record<string, unknown>[] }).tasks;
    // `live` is the run's status.json; none of these tasks has one (see cli-list-live.test.ts).
    // `branch` replaced `worktree`: there are no per-task worktrees to have on disk, and the
    // question worth answering is whether the task's branch is still there to review or merge.
    // These fixtures write result.json directly and never create a branch, so all three are null.
    assert.deepEqual(rows, [
      { id: 'no-run', title: 'No recorded run', status: 'none', branch: null, risk: '-', report: '-', live: null },
      { id: 'plain-run', title: 'Neither signal', status: 'completed', branch: null, risk: '-', report: '-', live: null },
      { id: 'risk-report', title: 'Risk and report', status: 'completed', branch: null, risk: 'high', report: 'yes', live: null },
    ]);
  } finally {
    fx.cleanup(dir);
  }
});

// The column has to actually report the branch, not just be renamed: a present task branch is
// how the user finds the work again after a dispatch that leaves them standing on it.
test('list reports a task branch that exists on disk', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'base\n');
    fx.addCommit(dir, 'base');
    writeTask(dir, 'has-branch', 'Branch still present');
    writeResult(dir, 'has-branch', {});
    fx.git(dir, ['branch', 'router/has-branch']);

    const text = router(dir, ['list']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /has-branch\s+completed\s+present/);
    assert.match(text.out, /1 task branch\(es\) still present/);
    const rows = (JSON.parse(router(dir, ['list', '--json']).out) as { tasks: { branch: string | null }[] }).tasks;
    assert.equal(rows[0]!.branch, 'router/has-branch');
  } finally {
    fx.cleanup(dir);
  }
});
