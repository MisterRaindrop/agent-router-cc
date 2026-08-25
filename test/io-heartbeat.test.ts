// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, readLock } from '../src/io/lock.ts';
import { startHeartbeat, startJsonHeartbeat } from '../src/io/heartbeat.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'router-heartbeat-'));
}

/** Block this thread the way a real verify command does -- spawnSync, not a sleep timer. */
function blockEventLoop(ms: number): void {
  spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`]);
}

/**
 * The last beat, retrying past a torn read.
 *
 * The child writes in place rather than truncating, so the worst a reader sees is a same-length
 * mix of two timestamps -- but that is still occasionally unparseable, and `readLock` reports
 * unparseable as null by design. Retrying is what the production reader does too: acquireLock
 * re-reads and re-decides before it reclaims anything, precisely so a transient torn read is
 * never mistaken for a stale lock. A helper that dereferenced null here would make this suite
 * flaky about a property the code already handles.
 */
function beatAt(path: string): number {
  for (let attempt = 0; attempt < 50; attempt++) {
    const info = readLock(path);
    if (info !== null) return info.beatAtMs;
    blockEventLoop(5);
  }
  throw new Error(`lock at ${path} never parsed across 50 reads`);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test('a generic heartbeat refreshes the selected JSON field and stops at a changed guard', async () => {
  const dir = tempDir();
  const path = join(dir, 'activity.json');
  const startedAt = '2026-08-25T00:00:00.000Z';
  try {
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, started_at: startedAt, beat_at: startedAt, label: 'test' })}\n`,
    );
    const beater = startJsonHeartbeat(path, {
      field: 'beat_at',
      valueFormat: 'iso',
      guard: { pid: process.pid, started_at: startedAt },
      intervalMs: 40,
    });
    try {
      assert.ok(
        await waitUntil(() => {
          const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
          return value.beat_at !== startedAt;
        }),
        'the selected field was never refreshed',
      );
      const refreshed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      assert.equal(refreshed.label, 'test', 'unrelated fields must survive an in-place beat');
      assert.equal(refreshed.started_at, startedAt);

      writeFileSync(
        path,
        `${JSON.stringify({ pid: process.pid, started_at: 'replacement', beat_at: 'replacement' })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const replacement = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      assert.equal(replacement.beat_at, 'replacement', 'an old heartbeat refreshed a replacement file');
      assert.ok(
        await waitUntil(() => {
          try {
            process.kill(beater.pid!, 0);
            return false;
          } catch {
            return true;
          }
        }),
        'the heartbeat child survived a guard mismatch',
      );
    } finally {
      beater.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fault-injection case 8b, rewritten after review finding 10 showed the original could not catch
// its own regression.
//
// The original blocked the loop and then asserted beatAtMs had advanced. That passes either way:
// if the beat were an in-process `setInterval`, the timer fires the instant the loop is released
// and the value advances just the same. PLAN §3 registered that test as the required evidence for
// Must NOT 5, so the green suite was overstating the guarantee it claimed to prove.
//
// The only assertion that separates the two is "beats landed WHILE we were blocked", and that
// cannot be observed by the blocked process. It takes two children: one that only blocks, and one
// whose own loop is free and does nothing but sample. Neither can be the same process.
test('beats land WHILE the owner is blocked, not just after (8b)', async () => {
  const dir = tempDir();
  const path = join(dir, 'gate.lock');
  const samples = join(dir, 'samples.jsonl');
  try {
    const handle = acquireLock(path, { waitMs: 0 });
    assert.ok(!('blocked' in handle));
    const beater = startHeartbeat(path, handle.ownerToken, 60);
    try {
      assert.ok(beater.pid !== null);

      // The watcher: its loop is free, so it can see what happens during our block. It records
      // (sampledAt, beatAtMs) pairs so the window can be reconstructed afterwards.
      const watcher = spawn(
        process.execPath,
        [
          '-e',
          "const fs=require('node:fs');" +
            `const t=setInterval(()=>{try{const b=JSON.parse(fs.readFileSync(${JSON.stringify(path)},'utf8')).beatAtMs;` +
            `fs.appendFileSync(${JSON.stringify(samples)}, JSON.stringify([Date.now(),b])+'\\n')}catch{}},15);` +
            'setTimeout(()=>{clearInterval(t);process.exit(0)},4000);',
        ],
        { stdio: 'ignore' },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 150)); // let it start sampling

        const blockedFrom = Date.now();
        blockEventLoop(1200); // our loop is gone; no timer of ours can run
        const blockedUntil = Date.now();

        await new Promise((resolve) => setTimeout(resolve, 150)); // let the last samples land
        const rows = readFileSync(samples, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as [number, number]);

        const inWindow = rows.filter(([at]) => at >= blockedFrom && at <= blockedUntil);
        assert.ok(inWindow.length > 5, `watcher barely sampled during the block (${inWindow.length})`);
        const distinct = new Set(inWindow.map(([, beat]) => beat));
        // The whole finding in one number. An in-process beat would show ONE value here -- the
        // one written before the block -- because nothing of ours ran until the block ended.
        assert.ok(
          distinct.size >= 2,
          `only ${distinct.size} distinct beatAtMs during a 1.2s block: the beat did not run while blocked`,
        );
      } finally {
        watcher.kill('SIGKILL');
      }
    } finally {
      beater.stop();
      handle.release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The mirror-image hazard: a heartbeat that outlives its owner keeps a dead holder's lock
// looking fresh, and then nobody can ever reclaim it. Ownership is proved by the token, the
// same rule release() follows.
test('the heartbeat stops once the lock is no longer ours', async () => {
  const dir = tempDir();
  const path = join(dir, 'gate.lock');
  try {
    const handle = acquireLock(path, { waitMs: 0 });
    assert.ok(!('blocked' in handle));
    const beater = startHeartbeat(path, handle.ownerToken, 40);
    try {
      const first = beatAt(path);
      assert.ok(await waitUntil(() => beatAt(path) > first), 'never beat at all');

      // Somebody reclaimed the lock and re-created it under their own token.
      writeFileSync(
        path,
        `${JSON.stringify({ pid: process.pid, startedAtMs: 1, beatAtMs: 1, ownerToken: 'someone-else' })}\n`,
      );
      // Give it several intervals to misbehave; the child must have exited instead.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(beatAt(path), 1, 'the heartbeat wrote to a lock it no longer owned');
      assert.ok(
        await waitUntil(() => {
          try {
            process.kill(beater.pid!, 0);
            return false;
          } catch {
            return true;
          }
        }),
        'the heartbeat child is still running',
      );
    } finally {
      beater.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt lock file stops the heartbeat rather than repairing it', async () => {
  const dir = tempDir();
  const path = join(dir, 'gate.lock');
  try {
    const handle = acquireLock(path, { waitMs: 0 });
    assert.ok(!('blocked' in handle));
    const beater = startHeartbeat(path, handle.ownerToken, 40);
    try {
      writeFileSync(path, '{ truncated');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(readFileSync(path, 'utf8'), '{ truncated');
    } finally {
      beater.stop();
      rmSync(path, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop() ends the child and is safe to call twice', async () => {
  const dir = tempDir();
  const path = join(dir, 'gate.lock');
  try {
    const handle = acquireLock(path, { waitMs: 0 });
    assert.ok(!('blocked' in handle));
    const beater = startHeartbeat(path, handle.ownerToken, 40);
    const pid = beater.pid!;
    beater.stop();
    beater.stop();
    assert.ok(
      await waitUntil(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
      'child survived stop()',
    );
    handle.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The deadlock this prevents: router dies, its heartbeat keeps beating, the lock never goes
// stale, and no later `go` can ever reclaim the checkout. The child watches its parent for
// exactly this reason -- so the test kills a real parent rather than simulating one.
test('the heartbeat child exits when its parent dies, so the lock can go stale', async () => {
  const dir = tempDir();
  const path = join(dir, 'gate.lock');
  try {
    const handle = acquireLock(path, { waitMs: 0 });
    assert.ok(!('blocked' in handle));
    const moduleUrl = new URL('../src/io/heartbeat.ts', import.meta.url).href;
    const parent = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { startHeartbeat } = await import(${JSON.stringify(moduleUrl)});\n` +
          `const h = startHeartbeat(${JSON.stringify(path)}, ${JSON.stringify(handle.ownerToken)}, 40);\n` +
          `console.log(h.pid);\n` +
          `setInterval(() => {}, 1000);\n`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let stdout = '';
    parent.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    assert.ok(await waitUntil(() => stdout.trim() !== ''), 'parent never reported the child pid');
    const childPid = Number(stdout.trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0);

    const before = beatAt(path);
    assert.ok(await waitUntil(() => beatAt(path) > before), 'the detached heartbeat never beat');

    // Kill the parent outright: no chance to run cleanup, which is the case that matters.
    parent.kill('SIGKILL');
    assert.ok(
      await waitUntil(() => {
        try {
          process.kill(childPid, 0);
          return false;
        } catch {
          return true;
        }
      }),
      'the heartbeat outlived its parent and would keep a dead holder’s lock fresh forever',
    );
    handle.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
