// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runQueueGate } from '../src/app/gateQueue.ts';
import { gateYamlPath } from '../src/app/gateConfig.ts';
import type { RunResult } from '../src/domain/types.ts';
import { fixedClock } from '../src/io/clock.ts';
import { acquireLock, type LockHandle } from '../src/io/lock.ts';
import { routerPaths, runBranch } from '../src/io/paths.ts';
import * as store from '../src/io/store.ts';
import * as fx from '../testkit/gitRepo.ts';

const RUN = 'run-001';
const INTEGRATION = 'router/integration';
const NODE = process.execPath;

interface Fixture {
  repo: string;
  paths: ReturnType<typeof routerPaths>;
  deps: {
    paths: ReturnType<typeof routerPaths>;
    clock: ReturnType<typeof fixedClock>;
  };
  base: string;
}

function setup(): Fixture {
  const repo = fx.initRepo();
  fx.write(repo, '.gitignore', '.router/\n');
  fx.write(repo, 'tracked.txt', 'base\n');
  const base = fx.addCommit(repo, 'base');
  const paths = routerPaths(join(repo, '.router'));
  return {
    repo,
    paths,
    deps: { paths, clock: fixedClock('2026-07-31T00:00:00.000Z') },
    base,
  };
}

function passedResult(id: string): RunResult {
  return {
    run_id: RUN,
    task_id: id,
    attempt_number: 1,
    exit_class: 'ok',
    rc: 0,
    timed_out: false,
    stalled: false,
    env_error: false,
    started_at: '2026-07-31T00:00:00.000Z',
    ended_at: '2026-07-31T00:00:01.000Z',
    wall_seconds: 1,
    worker: { kind: 'codex' },
    verifier: { result: 'PASSED', checks: [] },
  };
}

function stageTask(
  fixture: Fixture,
  id: string,
  mutate: (repo: string) => void,
  base = fixture.base,
): string {
  const branch = runBranch(id, RUN);
  fx.git(fixture.repo, ['checkout', '-q', '-b', branch, base]);
  mutate(fixture.repo);
  const sha = fx.addCommit(fixture.repo, `task ${id}`);
  fx.git(fixture.repo, ['checkout', '-q', 'main']);
  store.writeResult(fixture.paths, id, RUN, passedResult(id));
  return sha;
}

function writeGate(
  fixture: Fixture,
  gate: string[][],
  extra: {
    cleanGate?: string[][];
    cleanTriggers?: string[];
    reset?: string[][];
    lockWaitMinutes?: number;
  } = {},
): void {
  const config: string[] = [
    'mode: queue',
    `integration_branch: ${INTEGRATION}`,
    `gate: ${JSON.stringify(gate)}`,
    'gate_wall_minutes: 1',
  ];
  if (extra.cleanGate !== undefined) {
    config.push(`clean_gate: ${JSON.stringify(extra.cleanGate)}`);
  }
  if (extra.cleanTriggers !== undefined) {
    config.push(`clean_triggers: ${JSON.stringify(extra.cleanTriggers)}`);
  }
  if (extra.reset !== undefined) config.push(`reset: ${JSON.stringify(extra.reset)}`);
  if (extra.lockWaitMinutes !== undefined) {
    config.push(`lock_wait_minutes: ${extra.lockWaitMinutes}`);
  }
  mkdirSync(fixture.paths.root, { recursive: true });
  writeFileSync(gateYamlPath(fixture.paths), `${config.join('\n')}\n`);
}

function currentBranch(repo: string): string {
  return fx.git(repo, ['branch', '--show-current']).trim();
}

function readMaybe(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

test('passing queue gate keeps the integration merge, restores the ref, releases the lock, and records evidence', async () => {
  const fixture = setup();
  try {
    stageTask(fixture, 'pass', (repo) => fx.write(repo, 'pass.txt', 'task\n'));
    writeGate(fixture, [[NODE, '-e', 'console.log("gate passed")']]);

    const gate = await runQueueGate(fixture.deps, 'pass');

    assert.equal(gate.ok, true);
    assert.equal(gate.level, 'task');
    assert.equal(gate.base_sha, fixture.base);
    assert.equal(fx.git(fixture.repo, ['rev-parse', INTEGRATION]).trim(), gate.head_sha);
    assert.notEqual(gate.head_sha, fixture.base);
    assert.equal(currentBranch(fixture.repo), 'main');
    assert.equal(existsSync(fixture.paths.gateLock()), false);
    assert.match(readFileSync(fixture.paths.gateLog('pass', RUN), 'utf8'), /gate passed/);
    assert.deepEqual(store.readResult(fixture.paths, 'pass', RUN)?.gate, gate);
  } finally {
    fx.cleanup(fixture.repo);
  }
});

test('failing queue gate rolls back tracked files but preserves an untracked build artifact', async () => {
  const fixture = setup();
  try {
    stageTask(fixture, 'fail', (repo) => fx.write(repo, 'fail.txt', 'task\n'));
    const script =
      'const fs=require("fs");fs.mkdirSync("build",{recursive:true});' +
      'fs.writeFileSync("build/gate-artifact.txt","warm\\n");process.exit(7)';
    writeGate(fixture, [[NODE, '-e', script]]);

    const gate = await runQueueGate(fixture.deps, 'fail');

    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'gate_failed');
    assert.notEqual(gate.head_sha, gate.base_sha);
    assert.equal(fx.git(fixture.repo, ['rev-parse', INTEGRATION]).trim(), gate.base_sha);
    assert.equal(existsSync(join(fixture.repo, 'build', 'gate-artifact.txt')), true);
    assert.equal(currentBranch(fixture.repo), 'main');
    assert.equal(existsSync(fixture.paths.gateLock()), false);
  } finally {
    fx.cleanup(fixture.repo);
  }
});

test('dirty checkout refuses before changing refs or taking the task commit', async () => {
  const fixture = setup();
  try {
    stageTask(fixture, 'dirty', (repo) => fx.write(repo, 'dirty-task.txt', 'task\n'));
    writeGate(fixture, [[NODE, '-e', 'process.exit(0)']]);
    fx.write(fixture.repo, 'tracked.txt', 'user work\n');
    const before = fx.git(fixture.repo, ['rev-parse', 'HEAD']).trim();

    const gate = await runQueueGate(fixture.deps, 'dirty');

    assert.deepEqual(gate, { ok: false, reason: 'checkout_dirty' });
    assert.equal(currentBranch(fixture.repo), 'main');
    assert.equal(fx.git(fixture.repo, ['rev-parse', 'HEAD']).trim(), before);
    assert.equal(readFileSync(join(fixture.repo, 'tracked.txt'), 'utf8'), 'user work\n');
    assert.equal(existsSync(fixture.paths.gateLock()), false);
    assert.equal(fx.git(fixture.repo, ['branch', '--list', INTEGRATION]).trim(), '');
  } finally {
    fx.cleanup(fixture.repo);
  }
});

test('held gate lock returns lock_unavailable with its holder', async () => {
  const fixture = setup();
  let held: LockHandle | undefined;
  try {
    stageTask(fixture, 'locked', (repo) => fx.write(repo, 'locked.txt', 'task\n'));
    writeGate(fixture, [[NODE, '-e', 'process.exit(0)']], { lockWaitMinutes: 0 });
    const acquired = acquireLock(fixture.paths.gateLock(), { waitMs: 0 });
    assert.ok(!('blocked' in acquired));
    held = acquired;

    const gate = await runQueueGate(fixture.deps, 'locked');

    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'lock_unavailable');
    assert.equal(gate.holder?.pid, process.pid);
    assert.equal(currentBranch(fixture.repo), 'main');
    assert.equal(fx.git(fixture.repo, ['branch', '--list', INTEGRATION]).trim(), '');
  } finally {
    held?.release();
    fx.cleanup(fixture.repo);
  }
});

test('apply conflict leaves the integration branch unchanged and restores the original ref', async () => {
  const fixture = setup();
  try {
    stageTask(fixture, 'conflict', (repo) => fx.write(repo, 'tracked.txt', 'task\n'));
    fx.git(fixture.repo, ['checkout', '-q', '-b', INTEGRATION, fixture.base]);
    fx.write(fixture.repo, 'tracked.txt', 'integration\n');
    const integrationHead = fx.addCommit(fixture.repo, 'integration change');
    fx.git(fixture.repo, ['checkout', '-q', 'main']);
    writeGate(fixture, [[NODE, '-e', 'process.exit(0)']]);

    const gate = await runQueueGate(fixture.deps, 'conflict');

    assert.deepEqual(gate, { ok: false, reason: 'apply_conflict' });
    assert.equal(fx.git(fixture.repo, ['rev-parse', INTEGRATION]).trim(), integrationHead);
    assert.equal(currentBranch(fixture.repo), 'main');
    assert.equal(existsSync(fixture.paths.gateLock()), false);
    assert.equal(fx.git(fixture.repo, ['status', '--porcelain']).trim(), '');
  } finally {
    fx.cleanup(fixture.repo);
  }
});

test('failing reset rolls back without running the gate and leaves the gate log empty', async () => {
  const fixture = setup();
  try {
    stageTask(fixture, 'reset', (repo) => fx.write(repo, 'reset-task.txt', 'task\n'));
    const marker = join(fixture.repo, 'gate-ran.txt');
    writeGate(
      fixture,
      [[NODE, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)},"ran")`]],
      { reset: [[NODE, '-e', 'process.exit(9)']] },
    );

    const gate = await runQueueGate(fixture.deps, 'reset');

    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'reset_failed');
    assert.equal(gate.rc, 9);
    assert.equal(existsSync(marker), false);
    assert.equal(readMaybe(fixture.paths.gateLog('reset', RUN)), '');
    // An empty gate log is honest -- no gate command ran -- but the reason must still be
    // reachable from the result rather than stranded in an unreferenced sibling file.
    assert.equal(gate.reset_log, `${fixture.paths.gateLog('reset', RUN)}.reset`);
    assert.ok(existsSync(gate.reset_log ?? ''), 'the reset log the result points at must exist');
    assert.equal(fx.git(fixture.repo, ['rev-parse', INTEGRATION]).trim(), fixture.base);
    assert.equal(currentBranch(fixture.repo), 'main');
    assert.equal(existsSync(fixture.paths.gateLock()), false);
  } finally {
    fx.cleanup(fixture.repo);
  }
});

test('a deletion selects the configured clean gate', async () => {
  const fixture = setup();
  try {
    fx.git(fixture.repo, ['checkout', '-q', 'main']);
    fx.write(fixture.repo, 'delete-me.txt', 'old\n');
    fixture.base = fx.addCommit(fixture.repo, 'file to delete');
    stageTask(fixture, 'delete', (repo) => fx.rm(repo, 'delete-me.txt'));
    writeGate(fixture, [[NODE, '-e', 'process.exit(23)']], {
      cleanGate: [[NODE, '-e', 'console.log("clean gate")']],
      cleanTriggers: ['package.json'],
    });

    const gate = await runQueueGate(fixture.deps, 'delete');

    assert.equal(gate.ok, true);
    assert.equal(gate.level, 'clean');
    assert.match(readFileSync(fixture.paths.gateLog('delete', RUN), 'utf8'), /clean gate/);
  } finally {
    fx.cleanup(fixture.repo);
  }
});

test('sequential tasks verify the second commit on top of the first integration head', async () => {
  const fixture = setup();
  try {
    stageTask(fixture, 'first', (repo) => fx.write(repo, 'first.txt', 'one\n'));
    stageTask(fixture, 'second', (repo) => fx.write(repo, 'second.txt', 'two\n'));
    writeGate(fixture, [[NODE, '-e', 'process.exit(require("fs").existsSync("first.txt")?0:30)']]);
    const first = await runQueueGate(fixture.deps, 'first');

    const bothFiles =
      'const fs=require("fs");process.exit(fs.existsSync("first.txt")&&fs.existsSync("second.txt")?0:31)';
    writeGate(fixture, [[NODE, '-e', bothFiles]]);
    const second = await runQueueGate(fixture.deps, 'second');

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.base_sha, first.head_sha);
    assert.equal(fx.git(fixture.repo, ['rev-parse', INTEGRATION]).trim(), second.head_sha);
    assert.equal(currentBranch(fixture.repo), 'main');
  } finally {
    fx.cleanup(fixture.repo);
  }
});

test('a thrown gate error still restores the original ref and releases the lock', async () => {
  const fixture = setup();
  try {
    stageTask(fixture, 'throws', (repo) => fx.write(repo, 'throws.txt', 'task\n'));
    writeGate(fixture, [[NODE, '-e', 'process.exit(0)']]);
    const logsDir = dirname(fixture.paths.gateLog('throws', RUN));
    mkdirSync(dirname(logsDir), { recursive: true });
    writeFileSync(logsDir, 'not a directory');

    await assert.rejects(() => runQueueGate(fixture.deps, 'throws'));

    assert.equal(currentBranch(fixture.repo), 'main');
    assert.equal(fx.git(fixture.repo, ['rev-parse', INTEGRATION]).trim(), fixture.base);
    assert.equal(existsSync(fixture.paths.gateLock()), false);
  } finally {
    fx.cleanup(fixture.repo);
  }
});
