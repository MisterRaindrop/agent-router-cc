// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprintState, stateDiff } from '../src/app/stateGuard.ts';
import { routerPaths } from '../src/io/paths.ts';

function freshState() {
  const repo = mkdtempSync(join(tmpdir(), 'router-state-guard-'));
  const paths = routerPaths(join(repo, '.router'));
  mkdirSync(join(paths.root, 'tasks', 'victim'), { recursive: true });
  mkdirSync(join(paths.root, 'tasks', 'mine'), { recursive: true });
  return {
    paths,
    write(rel: string, text: string): void {
      const abs = join(paths.root, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, text);
    },
    cleanup(): void {
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

// The fingerprint used to be `size:mtimeMs`. Overwriting a file with same-length content and
// putting the original mtime back is two lines for anything with a filesystem API, and the diff
// came back empty -- so an executor could rewrite another task's verdict, or its own frozen
// contract, and still be reported clean. The reviewer's evidence was a `result.json` whose
// before and after fingerprints were the identical string `4:1787570059014`.
test('a same-length overwrite with the mtime restored is still detected', () => {
  const fx = freshState();
  try {
    const victim = join(fx.paths.root, 'tasks', 'victim', 'result.json');
    fx.write('tasks/victim/result.json', 'AAAA');
    const original = statSync(victim);

    const before = fingerprintState(fx.paths, 'mine');
    writeFileSync(victim, 'BBBB'); // same byte length
    utimesSync(victim, original.atime, original.mtime); // and the same timestamps
    const after = fingerprintState(fx.paths, 'mine');

    assert.equal(statSync(victim).size, original.size, 'the fixture changed the size after all');
    assert.equal(
      Math.floor(statSync(victim).mtimeMs),
      Math.floor(original.mtimeMs),
      'the fixture did not actually restore the mtime',
    );
    assert.deepEqual(stateDiff(before, after), ['modified tasks/victim/result.json']);
  } finally {
    fx.cleanup();
  }
});

// Every exclusion is a hole, so each one is asserted rather than assumed. The three that carry
// no "somebody else legitimately writes this" reason were removed, and this pins that: an
// executor forging a metrics row falsifies the usage report, and nothing else appends to that
// file before the comparison point.
test('the state guard watches what nobody else writes, and only skips what somebody does', () => {
  const fx = freshState();
  try {
    fx.write('metrics.jsonl', '{"task_id":"real"}\n');
    fx.write('usage.json', '{"a":1}');
    fx.write('gate.lock', '{"pid":1}');
    fx.write('symbols/abc.json', '{}');
    fx.write('tasks/mine/status.json', '{"phase":"executor_working"}');
    fx.write('tasks/mine/task.yaml', 'id: mine\n');
    fx.write('tasks/mine/logs/worker.log', 'line 1\n');

    const before = fingerprintState(fx.paths, 'mine');
    fx.write('metrics.jsonl', '{"task_id":"real"}\n{"task_id":"forged"}\n');
    fx.write('usage.json', '{"a":2}');
    fx.write('gate.lock', '{"pid":2}');
    fx.write('symbols/abc.json', '{"poisoned":true}');
    fx.write('tasks/mine/status.json', '{"phase":"verify"}');
    fx.write('tasks/mine/task.yaml', 'id: mine\nallowed_globs: ["**"]\n');
    fx.write('tasks/mine/logs/worker.log', 'line 1\nline 2\n');
    const after = fingerprintState(fx.paths, 'mine');

    assert.deepEqual(stateDiff(before, after), [
      'modified metrics.jsonl',
      'modified tasks/mine/task.yaml', // the run's own FROZEN contract, not its running state
    ]);
  } finally {
    fx.cleanup();
  }
});

test('creations and deletions are reported alongside modifications', () => {
  const fx = freshState();
  try {
    fx.write('tasks/victim/result.json', '{"verifier":{"result":"FAILED"}}');
    const before = fingerprintState(fx.paths, 'mine');
    fx.write('tasks/forged/result.json', '{"verifier":{"result":"PASSED"}}');
    rmSync(join(fx.paths.root, 'tasks', 'victim', 'result.json'));
    assert.deepEqual(stateDiff(before, fingerprintState(fx.paths, 'mine')), [
      'created tasks/forged/result.json',
      'deleted tasks/victim/result.json',
    ]);
  } finally {
    fx.cleanup();
  }
});
