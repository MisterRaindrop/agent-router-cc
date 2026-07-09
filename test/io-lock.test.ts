import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  acquireLock,
  isProcessAlive,
  LockTimeoutError,
  releaseLock,
  withGlobalLock,
} from '../src/io/lock.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'router-lock-'));
const WORKER = fileURLToPath(new URL('../testkit/lockWorker.ts', import.meta.url));

function writeOwner(lockDir: string, pid: number, host = hostnameSafe()): void {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, 'owner.json'),
    `${JSON.stringify({ pid, host, nonce: 'manual', acquiredAt: new Date().toISOString() })}\n`,
  );
}
function hostnameSafe(): string {
  return hostname();
}
/** A pid that has definitely exited (spawn a trivial process and reuse its pid). */
function deadPid(): number {
  const r = spawnSync('node', ['-e', 'process.exit(0)']);
  return r.pid as number;
}

test('isProcessAlive: self is alive, huge pid is not', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0x7fffffff), false);
  assert.equal(isProcessAlive(-1), false);
});

test('acquire then release; second acquire succeeds after release', () => {
  const dir = tmp();
  try {
    const lockDir = join(dir, '.lock');
    const h = acquireLock(lockDir, { timeoutMs: 1000 });
    assert.ok(existsSync(lockDir));
    releaseLock(h);
    assert.equal(existsSync(lockDir), false);
    const h2 = acquireLock(lockDir, { timeoutMs: 1000 });
    releaseLock(h2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('held fresh lock by a live owner => timeout, not reclaimed', () => {
  const dir = tmp();
  try {
    const lockDir = join(dir, '.lock');
    writeOwner(lockDir, process.pid); // alive, fresh
    assert.throws(
      () => acquireLock(lockDir, { timeoutMs: 150, retryMs: 10, staleMs: 30_000 }),
      LockTimeoutError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale lock (dead pid) is reclaimed', () => {
  const dir = tmp();
  try {
    const lockDir = join(dir, '.lock');
    writeOwner(lockDir, deadPid());
    const h = acquireLock(lockDir, { timeoutMs: 2000, retryMs: 10 });
    assert.equal(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).pid, process.pid);
    releaseLock(h);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale lock (alive pid but mtime past TTL => pid-reuse) is reclaimed', () => {
  const dir = tmp();
  try {
    const lockDir = join(dir, '.lock');
    writeOwner(lockDir, process.pid); // alive
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old); // age > staleMs
    const h = acquireLock(lockDir, { timeoutMs: 2000, retryMs: 10, staleMs: 1000 });
    releaseLock(h);
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseLock does not remove a lock we no longer own', () => {
  const dir = tmp();
  try {
    const lockDir = join(dir, '.lock');
    const h = acquireLock(lockDir, { timeoutMs: 1000 });
    // Someone else reclaimed & re-took it (different nonce):
    writeFileSync(
      join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, host: hostnameSafe(), nonce: 'other', acquiredAt: new Date().toISOString() })}\n`,
    );
    releaseLock(h);
    assert.ok(existsSync(lockDir), 'must not delete a lock owned by another nonce');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withGlobalLock releases even when fn throws', () => {
  const dir = tmp();
  try {
    const lockDir = join(dir, '.lock');
    assert.throws(() =>
      withGlobalLock(lockDir, () => {
        throw new Error('boom');
      }),
    );
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('N concurrent child processes never interleave the critical section', async () => {
  const dir = tmp();
  try {
    const lockDir = join(dir, '.lock');
    const marker = join(dir, 'marker.log');
    writeFileSync(marker, '');
    const N = 6;
    await Promise.all(
      Array.from({ length: N }, (_, i) => runWorker(lockDir, marker, `w${i}`)),
    );
    const lines = readFileSync(marker, 'utf8').trim().split('\n');
    assert.equal(lines.length, N * 2);
    // Every BEGIN must be immediately followed by its own END (no interleaving).
    for (let i = 0; i < lines.length; i += 2) {
      const [b, tagB] = lines[i]!.split(' ');
      const [e, tagE] = lines[i + 1]!.split(' ');
      assert.equal(b, 'BEGIN');
      assert.equal(e, 'END');
      assert.equal(tagB, tagE, `interleaved: ${lines[i]} / ${lines[i + 1]}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runWorker(lockDir: string, marker: string, tag: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('node', [WORKER, lockDir, marker, tag], (err) => {
      if (err) reject(err);
      else resolvePromise();
    });
  });
}
