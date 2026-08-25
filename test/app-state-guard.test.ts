// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprintState, stateDiff } from '../src/app/stateGuard.ts';
import { activityKey } from '../src/io/activity.ts';
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
    // A pinned timestamp rather than "read the old one and put it back": utimes round-trips
    // through seconds+nanoseconds, so restoring a captured mtime lands within a millisecond of
    // the original rather than exactly on it -- and asserting exact equality against a captured
    // value made this test itself fail about one run in three. A fixed stamp applied to both
    // writes is the same fixture without the coin toss.
    const stamp = new Date(1_700_000_000_000);
    fx.write('tasks/victim/result.json', 'AAAA');
    utimesSync(victim, stamp, stamp);
    const stampedAt = statSync(victim).mtimeMs;

    const before = fingerprintState(fx.paths, 'mine');
    writeFileSync(victim, 'BBBB'); // same byte length
    utimesSync(victim, stamp, stamp); // and the same timestamp
    const after = fingerprintState(fx.paths, 'mine');

    assert.equal(statSync(victim).size, 4, 'the fixture changed the size after all');
    assert.equal(statSync(victim).mtimeMs, stampedAt, 'the fixture did not restore the mtime');
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

// Skipping the WHOLE `activity/` directory was a hole, and the reviewer walked through it: an
// executor could forge somebody else's liveness record with a live pid and a future `beat_at`,
// have it read `running` forever, and block a later `router supervise --label` on that name.
// Measured before this fix: `diff: []`, state `running`.
//
// So only OUR record is skipped -- we create it, beat it, and delete it -- and for every other
// record the heartbeat field is normalised away while the rest of it stays watched.
test('only our own liveness record is unwatched, and only its heartbeat', () => {
  const fx = freshState();
  const own = `activity/${activityKey('task:mine')}.json`;
  const rec = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ label: 'review:x', owner_token: 'p', pid: 1, started_at: 'A', beat_at: '1', ...over }, null, 2);
  try {
    // Ours: creating it and beating it must both be invisible, or every dispatch fails itself.
    let before = fingerprintState(fx.paths, 'mine');
    fx.write(own, rec({ label: 'task:mine', beat_at: 'B' }));
    assert.deepEqual(stateDiff(before, fingerprintState(fx.paths, 'mine')), []);
    before = fingerprintState(fx.paths, 'mine');
    fx.write(own, rec({ label: 'task:mine', beat_at: 'C' }));
    assert.deepEqual(stateDiff(before, fingerprintState(fx.paths, 'mine')), []);

    // Somebody else's beat: also invisible, so a concurrent `supervise` is not a false alarm.
    fx.write('activity/other.json', rec());
    before = fingerprintState(fx.paths, 'mine');
    fx.write('activity/other.json', rec({ beat_at: '2' }));
    assert.deepEqual(stateDiff(before, fingerprintState(fx.paths, 'mine')), []);

    // A forged record appearing IS the finding.
    before = fingerprintState(fx.paths, 'mine');
    fx.write('activity/forged.json', rec({ label: 'review:architect', beat_at: '2100-01-01T00:00:00.000Z' }));
    assert.deepEqual(stateDiff(before, fingerprintState(fx.paths, 'mine')), ['created activity/forged.json']);

    // So is changing whose record it is.
    before = fingerprintState(fx.paths, 'mine');
    fx.write('activity/other.json', rec({ owner_token: 'HIJACKED', beat_at: '2' }));
    assert.deepEqual(stateDiff(before, fingerprintState(fx.paths, 'mine')), ['modified activity/other.json']);

    // And a non-JSON file under activity/ is hashed raw rather than quietly ignored.
    fx.write('activity/junk.json', 'not json at all');
    before = fingerprintState(fx.paths, 'mine');
    fx.write('activity/junk.json', 'still not json');
    assert.deepEqual(stateDiff(before, fingerprintState(fx.paths, 'mine')), ['modified activity/junk.json']);
  } finally {
    fx.cleanup();
  }
});
