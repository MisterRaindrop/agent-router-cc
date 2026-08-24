// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

// Review finding 1. The reclaim used to unlink the stale lock and only then kill the orphan
// executor group -- and the comment there claimed the opposite of what the code did. Reaping can
// wait out a SIGTERM grace and escalate to SIGKILL, so for that whole span the lock path did not
// exist and a third process could take it while the orphan was still writing the checkout.
test('the lock file stays in place until the orphan group is dead (finding 1)', async () => {
  const fixture = freshLock();
  try {
    const first = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(!('blocked' in first));

    // An orphan that does NOT die on SIGTERM, so the reap is forced to wait and escalate. That
    // wait is the window the old order left open. Written to a file rather than nested inside
    // another `-e`: the handler silently failed to register through three layers of quoting, and
    // the test then passed for the wrong reason (SIGTERM was enough, so there was no wait).
    const stubDir = mkdtempSync(join(tmpdir(), 'router-orphan-'));
    const stub = join(stubDir, 'orphan.mjs');
    const ready = join(stubDir, 'ready');
    // It announces readiness AFTER installing the handler. Without that the reap raced node's
    // startup: SIGTERM arrived before the handler existed, the orphan died on the default
    // disposition, the reap reported SIGTERM, and the test measured nothing -- there was no wait,
    // so there was no window to observe.
    writeFileSync(
      stub,
      "import { writeFileSync as w } from 'node:fs';\n" +
        "process.on('SIGTERM', () => {});\n" +
        `w(${JSON.stringify(ready)}, '1');\n` +
        'setInterval(() => {}, 1000);\n',
    );
    const launcher = spawnSync(
      process.execPath,
      [
        '-e',
        "const {spawn}=require('node:child_process');" +
          `const c=spawn(process.execPath,[${JSON.stringify(stub)}],{detached:true,stdio:'ignore'});` +
          'c.unref();console.log(c.pid);',
      ],
      { encoding: 'utf8' },
    );
    const pgid = Number(launcher.stdout.trim());
    assert.ok(Number.isInteger(pgid) && pgid > 1, launcher.stdout);
    const readyDeadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(ready), 'the orphan never installed its SIGTERM handler');
    first.recordExecPgid(pgid);

    // While the reclaim is inside the reap, the lock must still exist. Observed from a separate
    // process so it is the real filesystem answer, not ours.
    const watcher = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');let gone=0,seen=0;` +
          `const t=setInterval(()=>{seen++;if(!fs.existsSync(${JSON.stringify(fixture.path)}))gone++;},20);` +
          `setTimeout(()=>{clearInterval(t);console.log(JSON.stringify({seen,gone}));},1500);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    watcher.stdout.on('data', (c: Buffer) => (out += c.toString()));
    const watched = new Promise<void>((resolve) => watcher.on('exit', () => resolve()));

    const second = acquireLock(fixture.path, {
      waitMs: 0,
      staleMs: 50,
      now: () => 100,
      reapGraceMs: 400, // forces SIGTERM grace -> SIGKILL, i.e. a real wait
    });
    assert.ok(!('blocked' in second));
    // The orphan is dead by the time we hold the lock, and it took a SIGKILL to do it.
    assert.throws(() => process.kill(-pgid, 0), /ESRCH|no such process/i);
    assert.equal(second.takeover?.reaped?.pgid, pgid);
    // SIGKILL, not SIGTERM: the orphan ignored SIGTERM, so the reap really did wait. That wait is
    // the window, and it existed -- which is what makes the next assertion meaningful.
    assert.equal(second.takeover?.reaped?.signal, 'SIGKILL');

    await watched;
    const { seen, gone } = JSON.parse(out.trim()) as { seen: number; gone: number };
    assert.ok(seen > 10, `watcher barely sampled (seen=${seen})`);
    // The whole finding in one number. Under the old unlink-then-reap order the file was absent
    // for the entire ~800ms reap and this would be in the tens.
    assert.equal(gone, 0, `lock file vanished during the reap on ${gone}/${seen} samples`);
    second.release();
    rmSync(stubDir, { recursive: true, force: true });
  } finally {
    fixture.cleanup();
  }
});
