// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyStateChanges, fingerprintState, stateDiff } from '../src/app/stateGuard.ts';
import { activityKey } from '../src/io/activity.ts';
import { routerPaths } from '../src/io/paths.ts';

function freshState() {
  const repo = mkdtempSync(join(tmpdir(), 'router-state-guard-'));
  const paths = routerPaths(join(repo, '.router'));
  mkdirSync(join(paths.root, 'tasks', 'victim'), { recursive: true });
  mkdirSync(join(paths.root, 'tasks', 'mine'), { recursive: true });
  mkdirSync(paths.activityDir, { recursive: true });
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
    mkdirSync(join(fx.paths.root, 'tasks', 'forged'));
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

test('activity record directories and file-directory replacements are fatal without directory noise', () => {
  const fx = freshState();
  const activityRel = 'activity/reviewer.json';
  const activityPath = join(fx.paths.root, activityRel);
  const record = JSON.stringify({
    label: 'review:architect',
    owner_token: 'theirs',
    pid: 4242,
    started_at: 'A',
    beat_at: 'B',
  });
  try {
    let before = fingerprintState(fx.paths, 'mine');
    assert.deepEqual(
      stateDiff(before, fingerprintState(fx.paths, 'mine')),
      [],
      'stable router directories produced fingerprint noise',
    );

    mkdirSync(activityPath);
    let after = fingerprintState(fx.paths, 'mine');
    assert.deepEqual(classifyStateChanges(before, after, 'mine'), {
      reported: [],
      fatal: [`created ${activityRel}`],
    });

    before = after;
    rmSync(activityPath, { recursive: true });
    fx.write(activityRel, record);
    after = fingerprintState(fx.paths, 'mine');
    assert.deepEqual(classifyStateChanges(before, after, 'mine'), {
      reported: [],
      fatal: [`modified ${activityRel}`],
    });

    before = after;
    rmSync(activityPath);
    mkdirSync(activityPath);
    after = fingerprintState(fx.paths, 'mine');
    assert.deepEqual(classifyStateChanges(before, after, 'mine'), {
      reported: [],
      fatal: [`modified ${activityRel}`],
    });

    rmSync(activityPath, { recursive: true });
    before = fingerprintState(fx.paths, 'mine');
    fx.write('activity/ordinary.json', record);
    assert.deepEqual(classifyStateChanges(before, fingerprintState(fx.paths, 'mine'), 'mine'), {
      reported: ['created activity/ordinary.json'],
      fatal: [],
    });
  } finally {
    fx.cleanup();
  }
});

// Skipping the WHOLE `activity/` directory was a hole, and the reviewer walked through it: an
// executor could forge somebody else's liveness record with a live pid and a future `beat_at`,
// have it read `running` forever, and block a later `router supervise --label` on that name.
// Measured before this fix: `diff: []`, state `running`.
//
// Every record, including our own, must have its identity watched. Dispatch creates its record
// before the first fingerprint and removes it after the last comparison, so the only legitimate
// in-window write to that file is its heartbeat.
test('every activity identity is watched while heartbeat-only changes are ignored', () => {
  const fx = freshState();
  const own = `activity/${activityKey('task:mine')}.json`;
  const rec = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ label: 'review:x', owner_token: 'p', pid: 1, started_at: 'A', beat_at: '1', ...over }, null, 2);
  try {
    fx.write(own, rec({ label: 'task:mine', beat_at: 'B' }));
    let before = fingerprintState(fx.paths, 'mine');
    fx.write(own, rec({ label: 'task:mine', beat_at: 'C' }));
    assert.deepEqual(stateDiff(before, fingerprintState(fx.paths, 'mine')), []);

    for (const [field, value] of [
      ['pid', 42],
      ['owner_token', 'HIJACKED'],
      ['status_path', '/tmp/forged-status.json'],
    ] as const) {
      fx.write(own, rec({ label: 'task:mine', beat_at: 'C' }));
      before = fingerprintState(fx.paths, 'mine');
      fx.write(own, rec({ label: 'task:mine', beat_at: 'D', [field]: value }));
      assert.deepEqual(
        stateDiff(before, fingerprintState(fx.paths, 'mine')),
        [`modified ${own}`],
        `changing our own ${field} was invisible`,
      );
    }

    fx.write(own, rec({ label: 'task:mine', beat_at: 'E' }));
    before = fingerprintState(fx.paths, 'mine');
    rmSync(join(fx.paths.root, own));
    assert.deepEqual(stateDiff(before, fingerprintState(fx.paths, 'mine')), [`deleted ${own}`]);

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

test('state changes are separated into reporting and failure tiers', () => {
  const fx = freshState();
  const own = `activity/${activityKey('task:mine')}.json`;
  const other = 'activity/reviewer.json';
  const activity = (label: string) =>
    JSON.stringify({ label, owner_token: 'o', pid: 1, started_at: 'A', beat_at: 'B' });
  try {
    fx.write(own, activity('task:mine'));
    fx.write(other, activity('review:architect'));
    fx.write('plans/p1/WORKPLAN.md', '# Before\n');
    fx.write('tasks/victim/result.json', '{}');
    const before = fingerprintState(fx.paths, 'mine');

    rmSync(join(fx.paths.root, own));
    rmSync(join(fx.paths.root, other));
    fx.write('activity/new-reviewer.json', activity('review:senior'));
    fx.write('plans/p1/WORKPLAN.md', '# After\n');
    fx.write('tasks/victim/result.json', '{"forged":true}');
    const tiers = classifyStateChanges(before, fingerprintState(fx.paths, 'mine'), 'mine');

    assert.deepEqual(tiers.reported, [
      'created activity/new-reviewer.json',
      'deleted activity/reviewer.json',
      'modified plans/p1/WORKPLAN.md',
    ]);
    assert.deepEqual(tiers.fatal, [
      `deleted ${own}`,
      'modified tasks/victim/result.json',
    ]);
  } finally {
    fx.cleanup();
  }
});

// The tier test above never modifies ANOTHER run's activity record, so making a foreign identity
// change benign left all thirty-three tests green (main-session mutation, 2026-08-25). Forging
// somebody else's record is the original hole a reviewer walked through: a live pid plus a fresh
// beat reads `running` forever and blocks a later `router supervise --label` on that name.
test('forging ANOTHER activity identity is fatal, while its heartbeat alone is not', () => {
  const fx = freshState();
  const other = 'activity/reviewer.json';
  const record = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      label: 'review:architect',
      owner_token: 'theirs',
      pid: 4242,
      started_at: 'A',
      beat_at: 'B',
      ...over,
    });
  try {
    fx.write(`activity/${activityKey('task:mine')}.json`,
      JSON.stringify({ label: 'task:mine', owner_token: 'o', pid: 1, started_at: 'A', beat_at: 'B' }));

    // A concurrent heartbeat is the one legitimate change to somebody else's record.
    fx.write(other, record());
    let before = fingerprintState(fx.paths, 'mine');
    fx.write(other, record({ beat_at: 'B2' }));
    let tiers = classifyStateChanges(before, fingerprintState(fx.paths, 'mine'), 'mine');
    assert.deepEqual(tiers, { reported: [], fatal: [] }, 'a foreign heartbeat is not a change');

    // Every other field under the same owner is an identity, and no legitimate path rewrites it.
    for (const over of [
      { pid: process.pid },
      { label: 'review:senior' },
      { status_path: '/tmp/evil' },
    ]) {
      fx.write(other, record());
      before = fingerprintState(fx.paths, 'mine');
      fx.write(other, record(over));
      tiers = classifyStateChanges(before, fingerprintState(fx.paths, 'mine'), 'mine');
      assert.deepEqual(
        tiers.fatal,
        [`modified ${other}`],
        `forging ${Object.keys(over)[0]} on another run's record was not fatal`,
      );
      assert.deepEqual(tiers.reported, []);
    }

    // A new token at the deterministic label path is a later run replacing the completed one.
    // It is equivalent to a delete/create pair: visible, but not evidence against this run.
    fx.write(other, record());
    before = fingerprintState(fx.paths, 'mine');
    fx.write(other, record({ owner_token: 'next-run', started_at: 'C', beat_at: 'C' }));
    tiers = classifyStateChanges(before, fingerprintState(fx.paths, 'mine'), 'mine');
    assert.deepEqual(tiers, { reported: [`modified ${other}`], fatal: [] });
  } finally {
    fx.cleanup();
  }
});

test('replacing an activity record with a symlink, or retargeting that link, is fatal', () => {
  const fx = freshState();
  const activityRel = 'activity/reviewer.json';
  const activityPath = join(fx.paths.root, activityRel);
  const record = JSON.stringify({
    label: 'review:architect',
    owner_token: 'theirs',
    pid: 4242,
    started_at: 'A',
    beat_at: 'B',
  });
  try {
    fx.write(activityRel, record);
    fx.write('plans/target-a.json', record);
    fx.write('plans/target-b.json', record);
    let before = fingerprintState(fx.paths, 'mine');

    rmSync(activityPath);
    symlinkSync('../plans/target-a.json', activityPath);
    let tiers = classifyStateChanges(before, fingerprintState(fx.paths, 'mine'), 'mine');
    assert.deepEqual(tiers, { reported: [], fatal: [`modified ${activityRel}`] });

    before = fingerprintState(fx.paths, 'mine');
    rmSync(activityPath);
    symlinkSync('../plans/target-b.json', activityPath);
    tiers = classifyStateChanges(before, fingerprintState(fx.paths, 'mine'), 'mine');
    assert.deepEqual(tiers, { reported: [], fatal: [`modified ${activityRel}`] });
  } finally {
    fx.cleanup();
  }
});

test('replacing an activity record with a FIFO is fatal without opening the FIFO', () => {
  const fx = freshState();
  const activityRel = 'activity/reviewer.json';
  const activityPath = join(fx.paths.root, activityRel);
  try {
    fx.write(
      activityRel,
      JSON.stringify({
        label: 'review:architect',
        owner_token: 'theirs',
        pid: 4242,
        started_at: 'A',
        beat_at: 'B',
      }),
    );
    const before = fingerprintState(fx.paths, 'mine');

    rmSync(activityPath);
    execFileSync('mkfifo', [activityPath]);
    const tiers = classifyStateChanges(before, fingerprintState(fx.paths, 'mine'), 'mine');
    assert.deepEqual(tiers, { reported: [], fatal: [`modified ${activityRel}`] });
  } finally {
    fx.cleanup();
  }
});

test('ordinary heartbeat and plan-file changes retain their existing reporting tiers', () => {
  const fx = freshState();
  const activityRel = 'activity/reviewer.json';
  const record = (beatAt: string) =>
    JSON.stringify({
      label: 'review:architect',
      owner_token: 'theirs',
      pid: 4242,
      started_at: 'A',
      beat_at: beatAt,
    });
  try {
    fx.write(activityRel, record('B'));
    fx.write('plans/p1/WORKPLAN.md', '# Before\n');
    const before = fingerprintState(fx.paths, 'mine');

    fx.write(activityRel, record('C'));
    fx.write('plans/p1/WORKPLAN.md', '# After\n');
    assert.deepEqual(
      classifyStateChanges(before, fingerprintState(fx.paths, 'mine'), 'mine'),
      { reported: ['modified plans/p1/WORKPLAN.md'], fatal: [] },
    );
  } finally {
    fx.cleanup();
  }
});
