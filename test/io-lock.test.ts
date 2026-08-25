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
    // Sampled as INTERVALS, not as a count. There is one legitimate instant where the path does
    // not exist -- between the reclaim's unlink and its replacement lock -- and counting bare
    // samples made this test fail about one full run in six when the 20ms tick landed inside it.
    // What the finding is actually about is a hole lasting the whole reap, so measure duration.
    const watcher = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');let seen=0,goneAt=null,longest=0;` +
          `const t=setInterval(()=>{seen++;const now=Date.now();` +
          `if(!fs.existsSync(${JSON.stringify(fixture.path)})){if(goneAt===null)goneAt=now;` +
          `longest=Math.max(longest,now-goneAt);}else{goneAt=null;}},20);` +
          `setTimeout(()=>{clearInterval(t);console.log(JSON.stringify({seen,longest}));},1500);`,
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
    const { seen, longest } = JSON.parse(out.trim()) as { seen: number; longest: number };
    assert.ok(seen > 10, `watcher barely sampled (seen=${seen})`);
    // The whole finding in one number. Under the old unlink-then-reap order the file was absent
    // for the entire ~800ms reap; the handover gap this order still has is a single tick at most.
    assert.ok(longest < 100, `lock file was absent for ${longest}ms during the reap (${seen} samples)`);
    second.release();
    rmSync(stubDir, { recursive: true, force: true });
  } finally {
    fixture.cleanup();
  }
});

// The reclaim used to be: judge the file stale, spend up to two grace periods killing the dead
// holder's executor, then `unlinkSync(path)` -- with nothing in between asking whether the file
// at that path was still the one that had been judged. The reviewer hit it from the other end
// (two racing reclaimers, `bothAcquired: true`); this hits the same code from the victim's side,
// which is the half that can be made deterministic: while one reclaim is inside its reap,
// somebody else legitimately takes the lock, and the reclaim must not delete it.
test('a slow reclaim does not delete a lock that appeared while it was reaping (finding: stale-lock-double-reclaimer)', async () => {
  const fixture = freshLock();
  const stubDir = mkdtempSync(join(tmpdir(), 'router-reclaim-victim-'));
  try {
    const first = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(!('blocked' in first));

    // An orphan that ignores SIGTERM and then exits on its own ~900ms later. Its whole job is to
    // hold the reap open long enough for something to happen underneath it; the grace below is
    // far larger, so nothing here depends on a SIGKILL landing at a particular millisecond.
    const stub = join(stubDir, 'orphan.mjs');
    const ready = join(stubDir, 'ready');
    writeFileSync(
      stub,
      "import { writeFileSync as w } from 'node:fs';\n" +
        "process.on('SIGTERM', () => {});\n" +
        `w(${JSON.stringify(ready)}, '1');\n` +
        'setTimeout(() => process.exit(0), 900);\n' +
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

    // 300ms into the ~900ms reap, a second router finishes its own reclaim and installs a live
    // lock -- exactly what the loser of the reviewer's race saw. It runs in its own process
    // because acquireLock blocks this one's event loop for the whole reap.
    const usurper = { pid: process.pid, startedAtMs: 100, beatAtMs: 100, ownerToken: 'usurper' };
    const helper = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');` +
          `setTimeout(()=>{try{fs.unlinkSync(${JSON.stringify(fixture.path)})}catch{};` +
          `fs.writeFileSync(${JSON.stringify(fixture.path)}, ${JSON.stringify(JSON.stringify(usurper) + '\n')});},300);`,
      ],
      { stdio: 'ignore' },
    );
    const helperDone = new Promise<void>((resolve) => helper.on('exit', () => resolve()));

    const second = acquireLock(fixture.path, {
      waitMs: 0,
      staleMs: 50,
      now: () => 100,
      reapGraceMs: 3_000, // never reached; the orphan exits on its own well inside it
    });
    await helperDone;

    // The whole finding. The old code unlinked whatever was at the path once the reap returned,
    // so it deleted the usurper's live lock and handed back a handle -- two processes, one
    // checkout. Now the file is re-confirmed before removal, so the usurper's lock survives and
    // this caller is told the checkout is taken.
    assert.equal(
      readFileSync(fixture.path, 'utf8').trim(),
      JSON.stringify(usurper),
      'the reclaim deleted a lock that was installed while it was reaping',
    );
    assert.ok(
      'blocked' in second,
      `acquired the checkout while another process held it: ${JSON.stringify(second)}`,
    );
    assert.equal(second.holder?.pid, process.pid);
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
    fixture.cleanup();
  }
});

// The mutex has to be recoverable, or a reclaimer killed at the wrong moment would leave the
// checkout permanently unacquirable -- trading a rare double-acquire for a guaranteed deadlock.
test('a live reclaimer mutex blocks a second reclaim; a dead one does not', () => {
  const fixture = freshLock();
  try {
    const first = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(!('blocked' in first));
    const before = readFileSync(fixture.path, 'utf8');
    const mutexPath = `${fixture.path}.reclaim`;
    const live = (token: string) =>
      `${JSON.stringify({ pid: process.pid, beatAtMs: Date.now(), token })}\n`;

    // Someone else is mid-reclaim: this caller must not judge, reap or unlink anything.
    writeFileSync(mutexPath, live('someone-else'));
    const blocked = acquireLock(fixture.path, { waitMs: 0, staleMs: 50, now: () => 100 });
    assert.ok('blocked' in blocked, 'reclaimed a stale lock while another reclaimer held the mutex');
    assert.equal(readFileSync(fixture.path, 'utf8'), before, 'the stale lock was touched anyway');
    assert.match(readFileSync(mutexPath, 'utf8'), /someone-else/, 'a live reclaimer mutex was deleted');

    // An EMPTY mutex is the shape a holder has for the instant between creating and writing it.
    // Reading that as "dead" is how the previous version let a second reclaimer in while the
    // first was alive and about to reap, so a fresh empty file must still count as live.
    writeFileSync(mutexPath, '');
    const alsoBlocked = acquireLock(fixture.path, { waitMs: 0, staleMs: 50, now: () => 100 });
    assert.ok('blocked' in alsoBlocked, 'a just-created mutex was read as a dead one');
    assert.equal(existsSync(mutexPath), true, 'deleted a mutex whose owner had not finished writing it');

    // The reclaimer died. `pid: 1` stands in for a pid that is alive but is not a router -- the
    // lease is what settles it, so an unrenewed mutex is broken even when its pid still answers.
    writeFileSync(
      mutexPath,
      `${JSON.stringify({ pid: 1, beatAtMs: Date.now() - 600_000, token: 'gone' })}\n`,
    );
    const recovered = acquireLock(fixture.path, { waitMs: 0, staleMs: 50, now: () => 100 });
    assert.ok(!('blocked' in recovered), 'a dead reclaimer mutex wedged the checkout for good');
    assert.equal(recovered.takeover?.reason, 'stale-heartbeat');
    assert.equal(existsSync(mutexPath), false, 'the reclaim left its mutex behind');
    recovered.release();
  } finally {
    fixture.cleanup();
  }
});

// The reclaim's own release must be identity-checked. A lease-breaker can replace the mutex while
// we are inside a long reap, and a `finally` that deletes the PATH rather than OUR file removes
// the new holder's mutex -- putting a third reclaimer into the same critical section.
test('a reclaim releases only its own mutex, never whoever replaced it', () => {
  const fixture = freshLock();
  try {
    const first = acquireLock(fixture.path, { waitMs: 0, now: () => 0 });
    assert.ok(!('blocked' in first));
    const mutexPath = `${fixture.path}.reclaim`;

    // A stale-but-live-looking mutex that our reclaim will NOT be able to break, so acquireLock
    // returns without ever owning it -- and must leave it exactly where it found it.
    const other = `${JSON.stringify({ pid: process.pid, beatAtMs: Date.now(), token: 'other' })}\n`;
    writeFileSync(mutexPath, other);
    acquireLock(fixture.path, { waitMs: 0, staleMs: 50, now: () => 100 });
    assert.equal(readFileSync(mutexPath, 'utf8'), other, 'released a mutex belonging to someone else');
  } finally {
    fixture.cleanup();
  }
});
