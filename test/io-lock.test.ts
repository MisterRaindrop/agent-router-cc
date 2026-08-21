// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  acquireLock,
  readLock,
  type LockHandle,
  type LockInfo,
} from '../src/io/lock.ts';

function freshLock() {
  const directory = mkdtempSync(join(tmpdir(), 'router-exclusive-lock-'));
  return {
    path: join(directory, 'gate.lock'),
    cleanup(): void {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function isHandle(value: LockHandle | { blocked: true; holder: LockInfo | null }): value is LockHandle {
  return 'release' in value;
}

test('acquireLock is exclusive and a second caller names the holder', () => {
  const fixture = freshLock();
  try {
    const first = acquireLock(fixture.path, { waitMs: 0, now: () => 100 });
    assert.ok(isHandle(first));

    const second = acquireLock(fixture.path, { waitMs: 0, now: () => 100 });
    assert.ok(!isHandle(second));
    assert.equal(second.blocked, true);
    assert.equal(second.holder?.pid, process.pid);
    assert.equal(second.holder?.startedAtMs, 100);

    first.release();
  } finally {
    fixture.cleanup();
  }
});

test('heartbeat rewrites beatAtMs and release is idempotent', () => {
  const fixture = freshLock();
  let now = 10;
  try {
    const handle = acquireLock(fixture.path, { waitMs: 0, now: () => now });
    assert.ok(isHandle(handle));
    assert.equal(readLock(fixture.path)?.beatAtMs, 10);

    now = 25;
    handle.heartbeat();
    assert.equal(readLock(fixture.path)?.beatAtMs, 25);

    handle.release();
    handle.release();
    assert.equal(existsSync(fixture.path), false);
  } finally {
    fixture.cleanup();
  }
});

test('a stale heartbeat is taken over and the takeover is recorded', () => {
  const fixture = freshLock();
  try {
    writeFileSync(
      fixture.path,
      `${JSON.stringify({ pid: process.pid, startedAtMs: 1, beatAtMs: 10, label: 'old gate' })}\n`,
    );
    const handle = acquireLock(fixture.path, { waitMs: 0, staleMs: 50, now: () => 100 });
    assert.ok(isHandle(handle));

    const raw = JSON.parse(readFileSync(fixture.path, 'utf8')) as {
      takeover?: { reason: string; holder: LockInfo | null };
    };
    assert.equal(raw.takeover?.reason, 'stale-heartbeat');
    assert.equal(raw.takeover?.holder?.label, 'old gate');
    handle.release();
  } finally {
    fixture.cleanup();
  }
});

test('a lock whose pid is gone is taken over', () => {
  const fixture = freshLock();
  try {
    writeFileSync(
      fixture.path,
      `${JSON.stringify({ pid: 2_147_483_647, startedAtMs: 80, beatAtMs: 100 })}\n`,
    );
    const handle = acquireLock(fixture.path, { waitMs: 0, staleMs: 1_000, now: () => 100 });
    assert.ok(isHandle(handle));
    const raw = JSON.parse(readFileSync(fixture.path, 'utf8')) as {
      takeover?: { reason: string; holder: LockInfo | null };
    };
    assert.equal(raw.takeover?.reason, 'dead-pid');
    assert.equal(raw.takeover?.holder?.pid, 2_147_483_647);
    handle.release();
  } finally {
    fixture.cleanup();
  }
});

test('corrupt lock contents count as stale', () => {
  const fixture = freshLock();
  try {
    writeFileSync(fixture.path, '{"pid":');
    assert.equal(readLock(fixture.path), null);

    const handle = acquireLock(fixture.path, { waitMs: 0, now: () => 100 });
    assert.ok(isHandle(handle));
    const raw = JSON.parse(readFileSync(fixture.path, 'utf8')) as {
      takeover?: { reason: string; holder: LockInfo | null };
    };
    assert.equal(raw.takeover?.reason, 'corrupt');
    assert.equal(raw.takeover?.holder, null);
    handle.release();
  } finally {
    fixture.cleanup();
  }
});

test('waiting reports blocked instead of proceeding', () => {
  const fixture = freshLock();
  try {
    const first = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(isHandle(first));

    let now = -10;
    const second = acquireLock(fixture.path, {
      waitMs: 30,
      pollMs: 10,
      now: () => {
        now += 10;
        return now;
      },
    });
    assert.ok(!isHandle(second));
    assert.equal(second.blocked, true);
    assert.equal(second.holder?.pid, process.pid);
    assert.equal(readLock(fixture.path)?.startedAtMs, 0);

    first.release();
  } finally {
    fixture.cleanup();
  }
});

test('a stale original handle cannot release its replacement', () => {
  const fixture = freshLock();
  try {
    const original = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(isHandle(original));
    const replacement = acquireLock(fixture.path, { waitMs: 0, staleMs: 50, now: () => 100 });
    assert.ok(isHandle(replacement));

    original.release();
    assert.equal(readLock(fixture.path)?.startedAtMs, 100);
    replacement.release();
  } finally {
    fixture.cleanup();
  }
});

// The test above only reproduces the failure where the replacement lands on a *different*
// inode -- it passed on APFS and failed on Linux, which reuses inode numbers aggressively.
// Overwriting the file in place forces the same-inode case on every platform, so the guard
// has to key on the owner token rather than on file identity. Two verifications sharing one
// build directory is what this prevents.
test('a handle will not release a lock that another owner rewrote in place', () => {
  const fixture = freshLock();
  try {
    const mine = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(isHandle(mine));
    const foreign = { pid: process.pid, startedAtMs: 500, beatAtMs: 500, ownerToken: 'someone-else' };
    writeFileSync(fixture.path, `${JSON.stringify(foreign)}\n`); // same path, same inode

    // Both guards, in the order they would really fire: the heartbeat notices first, and
    // release must still keep its hands off. (After a release the handle is spent, so the
    // heartbeat check has to come first.)
    assert.throws(() => mine.heartbeat(), /ownership was lost|cannot heartbeat/);
    mine.release();
    assert.equal(readLock(fixture.path)?.startedAtMs, 500, 'the other owner lock must survive');
  } finally {
    fixture.cleanup();
  }
});

// --- Executor ownership across a takeover (P4, fault-injection case 8c) -------------
//
// The hazard the branch model creates: router dies holding the lock, its executor is detached
// so it keeps running, the lock goes stale on dead-pid, and the next dispatch walks into a
// checkout the orphan is still writing. Under the worktree model this was harmless -- the
// orphan scribbled in an isolated directory. Now it is the user's own files.

test('reclaiming a dead holder’s lock kills its orphan executor group first (8c)', async () => {
  const fixture = freshLock();
  try {
    const first = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(!('blocked' in first));
    assert.equal(first.takeover, null); // uncontested

    // A real detached process standing in for the orphan executor -- deliberately spawned by a
    // short-lived LAUNCHER that then exits, so the orphan is reparented to init exactly as it is
    // in production, where the router that spawned it has died. Making it our own child instead
    // would leave a zombie after SIGKILL (nothing reaps it while acquireLock blocks the event
    // loop), and the test would be measuring the harness rather than the reap.
    const launcher = spawnSync(
      process.execPath,
      [
        '-e',
        "const {spawn}=require('node:child_process');" +
          "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});" +
          'c.unref();console.log(c.pid);',
      ],
      { encoding: 'utf8' },
    );
    const pgid = Number(launcher.stdout.trim());
    assert.ok(Number.isInteger(pgid) && pgid > 1, `launcher did not report a pid: ${launcher.stdout}`);
    assert.doesNotThrow(() => process.kill(-pgid, 0), 'the stand-in orphan is not running');
    first.recordExecPgid(pgid);
    assert.equal(readLock(fixture.path)!.execPgid, pgid);

    // The holder dies without releasing; its beat goes stale.
    const second = acquireLock(fixture.path, {
      waitMs: 0,
      staleMs: 50,
      now: () => 100,
      reapGraceMs: 3_000,
    });
    assert.ok(!('blocked' in second));

    // The reclaim is only allowed to return once the orphan is gone -- so by the time we get
    // the handle, it must already be dead. No polling here on purpose: that is the assertion.
    assert.throws(() => process.kill(-pgid, 0), /ESRCH|no such process/i);
    assert.equal(second.takeover?.reason, 'stale-heartbeat');
    assert.equal(second.takeover?.reaped?.pgid, pgid);
    assert.ok(second.takeover?.reaped?.signal === 'SIGTERM' || second.takeover?.reaped?.signal === 'SIGKILL');
    second.release();
  } finally {
    fixture.cleanup();
  }
});

test('a takeover with no executor recorded reports no reap', () => {
  const fixture = freshLock();
  try {
    const first = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(!('blocked' in first));
    const second = acquireLock(fixture.path, { waitMs: 0, staleMs: 50, now: () => 100 });
    assert.ok(!('blocked' in second));
    assert.equal(second.takeover?.reason, 'stale-heartbeat');
    assert.equal(second.takeover?.reaped, undefined);
    second.release();
  } finally {
    fixture.cleanup();
  }
});

// A lock written by a build that predates execPgid/ownerToken must stay readable. Rejecting it
// as corrupt would declare every pre-upgrade lock stale at the moment of upgrade -- which is to
// say, hand the checkout to a second process while the first one is still working in it.
test('a lock file from an older build is valid, not corrupt', () => {
  const fixture = freshLock();
  try {
    writeFileSync(fixture.path, `${JSON.stringify({ pid: process.pid, startedAtMs: 5, beatAtMs: 5 })}\n`);
    const info = readLock(fixture.path);
    assert.equal(info?.beatAtMs, 5);
    assert.equal(info?.execPgid, undefined);
    // Fresh beat + live pid => still held, so a second caller is blocked rather than taking over.
    const blocked = acquireLock(fixture.path, { waitMs: 0, staleMs: 10_000, now: () => 100 });
    assert.ok('blocked' in blocked);
    assert.equal(blocked.holder?.beatAtMs, 5);
  } finally {
    fixture.cleanup();
  }
});

test('recordExecPgid refuses once the lock has been taken over', () => {
  const fixture = freshLock();
  try {
    const first = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(!('blocked' in first));
    const second = acquireLock(fixture.path, { waitMs: 0, staleMs: 50, now: () => 100 });
    assert.ok(!('blocked' in second));
    assert.throws(() => first.recordExecPgid(4242), /ownership was lost/);
    second.release();
  } finally {
    fixture.cleanup();
  }
});
