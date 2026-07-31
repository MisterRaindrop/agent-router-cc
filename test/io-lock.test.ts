// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
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
