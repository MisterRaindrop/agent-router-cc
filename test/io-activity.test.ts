// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { ActivityRecord } from '../src/domain/types.ts';
import {
  ActivityAlreadyExistsError,
  activityKey,
  activityState,
  claimActivity,
  finishActivity,
  observeActivities,
  readActivities,
  readActivity,
  setActivityTestHookForTesting,
  startActivityHeartbeat,
  writeActivity,
  type ActivityTestPoint,
} from '../src/io/activity.ts';
import { DEFAULT_STALE_MS } from '../src/io/lock.ts';
import { routerPaths } from '../src/io/paths.ts';

function fixture(): { root: string; activityDir: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'router-activity-'));
  const activityDir = join(root, '.router', 'activity');
  return {
    root,
    activityDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function record(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  const now = new Date().toISOString();
  return {
    label: 'task:p1',
    owner_token: 'test-owner',
    pid: process.pid,
    started_at: now,
    beat_at: now,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

async function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  assert.ok(
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, timeoutMs),
    'child did not exit in time',
  );
}

test('the paths getter uses a fixed lowercase digest under .router/activity', () => {
  const fx = fixture();
  try {
    const paths = routerPaths(join(fx.root, '.router'));
    const key = activityKey('../review:architect\\senior?');
    assert.match(key, /^[a-f0-9]{64}$/u);
    assert.equal(activityKey('../review:architect\\senior?'), key);
    assert.notEqual(activityKey('Review'), activityKey('review'));
    assert.equal(activityKey('x'.repeat(256)).length, 64);
    assert.equal(paths.activityDir, fx.activityDir);
    assert.equal(paths.activity(key), join(fx.activityDir, `${key}.json`));
    assert.equal(dirname(paths.activity(key)), fx.activityDir);
  } finally {
    fx.cleanup();
  }
});

test('activity storage round-trips the schema, removes ended records, and ignores a truncated sibling', () => {
  const fx = fixture();
  try {
    const paths = routerPaths(join(fx.root, '.router'));
    const complete = record({
      status_path: paths.runStatus('p1'),
    });
    const completePath = paths.activity(activityKey(complete.label));
    writeActivity(completePath, complete);
    writeFileSync(join(fx.activityDir, 'truncated.json'), '{ truncated');

    assert.deepEqual(readActivity(completePath), complete);
    assert.deepEqual(readActivities(fx.activityDir), [{ path: completePath, record: complete }]);
    assert.equal(readActivity(join(fx.activityDir, 'missing.json')), null);

    writeActivity(completePath, {
      ...complete,
      ended_at: '2026-08-25T01:02:03.000Z',
      outcome: 'ok',
    });
    assert.equal(existsSync(completePath), false, 'ended activity was retained as unbounded history');
  } finally {
    fx.cleanup();
  }
});

test('oversized and symlink activity files are ignored without hiding a valid sibling', () => {
  const fx = fixture();
  try {
    mkdirSync(fx.activityDir, { recursive: true });
    const goodPath = join(fx.activityDir, 'good.json');
    const hugePath = join(fx.activityDir, 'huge.json');
    const symlinkPath = join(fx.activityDir, 'symlink.json');
    const good = record({ label: 'good' });
    writeActivity(goodPath, good);
    writeFileSync(
      hugePath,
      `${JSON.stringify(record({ label: 'huge', status_path: 'x'.repeat(64 * 1024) }))}\n`,
    );
    symlinkSync(goodPath, symlinkPath);

    assert.equal(readActivity(hugePath), null);
    assert.equal(readActivity(symlinkPath), null);
    assert.deepEqual(readActivities(fx.activityDir), [{ path: goodPath, record: good }]);
  } finally {
    fx.cleanup();
  }
});

test('a FIFO activity file is ignored without blocking or hiding a valid sibling', async () => {
  const fx = fixture();
  const moduleUrl = new URL('../src/io/activity.ts', import.meta.url).href;
  let reader: ChildProcess | undefined;
  try {
    mkdirSync(fx.activityDir, { recursive: true });
    const goodPath = join(fx.activityDir, 'good.json');
    const fifoPath = join(fx.activityDir, 'fifo.json');
    const good = record({ label: 'good' });
    writeActivity(goodPath, good);
    const madeFifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(madeFifo.status, 0, madeFifo.stderr);

    reader = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { readActivity } = await import(${JSON.stringify(moduleUrl)});\n` +
          `process.exit(readActivity(${JSON.stringify(fifoPath)}) === null ? 0 : 91);\n`,
      ],
      { stdio: 'ignore' },
    );
    const returned = await waitUntil(
      () => reader!.exitCode !== null || reader!.signalCode !== null,
      750,
    );
    if (!returned) {
      reader.kill('SIGKILL');
      await waitForExit(reader);
    }
    assert.ok(returned, 'readActivity blocked while opening a FIFO');
    assert.equal(reader.exitCode, 0);
    assert.deepEqual(readActivities(fx.activityDir), [{ path: goodPath, record: good }]);
  } finally {
    if (reader !== undefined && reader.exitCode === null && reader.signalCode === null) {
      reader.kill('SIGKILL');
      await waitForExit(reader).catch(() => undefined);
    }
    fx.cleanup();
  }
});

test('the three-state rule requires both a live pid and a fresh heartbeat', () => {
  const now = Date.now();
  const fresh = record({ started_at: new Date(now - 1_000).toISOString(), beat_at: new Date(now - 100).toISOString() });
  assert.equal(activityState(null, now), 'idle');
  assert.equal(activityState({ ...fresh, ended_at: new Date(now).toISOString(), outcome: 'ok' }, now), 'idle');
  assert.equal(activityState(fresh, now), 'running');
  assert.equal(
    activityState({ ...fresh, beat_at: new Date(now - DEFAULT_STALE_MS - 1).toISOString() }, now),
    'disconnected',
  );
  assert.equal(
    activityState({ ...fresh, beat_at: new Date(now + 5_000).toISOString() }, now),
    'running',
    'small clock skew should stay within the explicit tolerance',
  );
  assert.equal(
    activityState({ ...fresh, beat_at: new Date(now + 5_001).toISOString() }, now),
    'disconnected',
    'a far-future heartbeat must not remain fresh indefinitely',
  );
  assert.equal(activityState({ ...fresh, pid: 2_147_483_647 }, now), 'disconnected');
  assert.equal(activityState({ ...fresh, pid: 2_147_483_648 }, now), 'disconnected');
});

test('a dead or expired reclaim lease earns one recovery retry and cannot wedge a label', () => {
  const fx = fixture();
  const paths = routerPaths(join(fx.root, '.router'));
  const label = 'review:expired-reclaimer';
  const path = paths.activity(activityKey(label));
  const reclaimPath = `${path}.reclaim`;
  try {
    const at = new Date().toISOString();
    writeActivity(path, {
      label,
      pid: 2_147_483_647,
      started_at: at,
      beat_at: at,
    });
    writeFileSync(
      reclaimPath,
      `${JSON.stringify({ pid: process.pid, beatAtMs: Date.now() - 30_001, token: 'expired' })}\n`,
    );

    const claimed = claimActivity(paths, label);
    assert.equal(claimed.record.pid, process.pid);
    assert.equal(activityState(readActivity(path)), 'running');
    assert.equal(existsSync(reclaimPath), false);
    const diagnostics: string[] = [];
    finishActivity(claimed, 'ok', diagnostics);
    assert.deepEqual(diagnostics, []);
  } finally {
    fx.cleanup();
  }
});

// The other half of what a mutex means. The test above proves a DEAD lease can be broken;
// nothing proved a LIVE one holds -- and dropping the liveness condition from
// clearDeadReclaimer left all sixteen tests green (main-session mutation, 2026-08-25).
// Two claimants both walking through reclaim is the double-reclaimer bug io/lock.ts already
// had to fix once.
test('a live reclaim lease is not broken, and an unparseable one is only cleared once stale', () => {
  const fx = fixture();
  const paths = routerPaths(join(fx.root, '.router'));
  const disconnected = (label: string): string => {
    const path = paths.activity(activityKey(label));
    const at = new Date(Date.now() - DEFAULT_STALE_MS - 1_000).toISOString();
    // A pid that cannot exist, so only the reclaim guard decides the outcome.
    writeActivity(path, { label, pid: 2_147_483_646, started_at: at, beat_at: at });
    return path;
  };

  try {
    // A guard held by THIS process, beating now: it is alive and must survive.
    const live = disconnected('review:live-lease');
    writeFileSync(
      `${live}.reclaim`,
      `${JSON.stringify({ pid: process.pid, beatAtMs: Date.now(), token: 'held' })}\n`,
    );
    assert.throws(
      () => claimActivity(paths, 'review:live-lease'),
      ActivityAlreadyExistsError,
      'a live reclaim lease was broken',
    );
    assert.equal(existsSync(`${live}.reclaim`), true, 'a live reclaim guard was removed');

    // An unparseable guard is judged by its mtime, so a fresh one is still somebody's.
    const fresh = disconnected('review:fresh-unparseable');
    writeFileSync(`${fresh}.reclaim`, '{ not a reclaimer');
    assert.throws(
      () => claimActivity(paths, 'review:fresh-unparseable'),
      ActivityAlreadyExistsError,
      'a freshly written unparseable guard was cleared before its lease expired',
    );

    // ...and the same guard, aged past the lease, is recoverable.
    const aged = disconnected('review:aged-unparseable');
    writeFileSync(`${aged}.reclaim`, '{ not a reclaimer');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(`${aged}.reclaim`, stale, stale);
    const claimed = claimActivity(paths, 'review:aged-unparseable');
    assert.equal(claimed.record.pid, process.pid);
    assert.equal(existsSync(`${aged}.reclaim`), false);
  } finally {
    fx.cleanup();
  }
});

test('a live reclaimer renews its lease across every claim boundary', () => {
  const fx = fixture();
  const paths = routerPaths(join(fx.root, '.router'));
  const label = 'review:renewed-reclaimer';
  const path = paths.activity(activityKey(label));
  const reclaimPath = `${path}.reclaim`;
  const activityModuleUrl = new URL('../src/io/activity.ts', import.meta.url).href;
  const pathsModuleUrl = new URL('../src/io/paths.ts', import.meta.url).href;
  const boundaries: ActivityTestPoint[] = [
    'reclaim-guard-established',
    'reclaim-liveness-confirmed',
    'reclaim-before-unlink',
    'reclaim-before-install',
  ];
  const seen: ActivityTestPoint[] = [];
  try {
    const at = new Date(Date.now() - DEFAULT_STALE_MS - 1_000).toISOString();
    writeActivity(path, { label, pid: 2_147_483_647, started_at: at, beat_at: at });

    setActivityTestHookForTesting((point) => {
      if (!boundaries.includes(point)) return;
      seen.push(point);
      const guard = JSON.parse(readFileSync(reclaimPath, 'utf8')) as {
        pid: number;
        beatAtMs: number;
        token: string;
      };
      assert.ok(
        Date.now() - guard.beatAtMs < 5_000,
        `${point} crossed with an expired reclaim lease`,
      );

      const contender = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { ActivityAlreadyExistsError, claimActivity } = await import(${JSON.stringify(activityModuleUrl)});\n` +
            `const { routerPaths } = await import(${JSON.stringify(pathsModuleUrl)});\n` +
            `try {\n` +
            `  claimActivity(routerPaths(${JSON.stringify(join(fx.root, '.router'))}), ${JSON.stringify(label)});\n` +
            `  process.exit(91);\n` +
            `} catch (error) {\n` +
            `  if (error instanceof ActivityAlreadyExistsError) process.exit(23);\n` +
            `  console.error(error); process.exit(92);\n` +
            `}\n`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(contender.status, 23, contender.stderr);

      if (point !== 'reclaim-before-install') {
        writeFileSync(
          reclaimPath,
          `${JSON.stringify({ ...guard, beatAtMs: Date.now() - 60_000 })}\n`,
        );
      }
    });

    const claimed = claimActivity(paths, label);
    assert.deepEqual(seen, boundaries);
    assert.equal(claimed.record.pid, process.pid);
    assert.equal(activityState(readActivity(path)), 'running');
    assert.equal(existsSync(reclaimPath), false);
    const diagnostics: string[] = [];
    finishActivity(claimed, 'ok', diagnostics);
    assert.deepEqual(diagnostics, []);
  } finally {
    setActivityTestHookForTesting(undefined);
    fx.cleanup();
  }
});

test('every reclaim crash boundary leaves at most one owner and remains recoverable', async (t) => {
  const reclaimPoints: ActivityTestPoint[] = [
    'reclaim-guard-established',
    'reclaim-liveness-confirmed',
    'reclaim-before-unlink',
    'reclaim-before-install',
    'finish-snapshot',
  ];
  const activityModuleUrl = new URL('../src/io/activity.ts', import.meta.url).href;
  const pathsModuleUrl = new URL('../src/io/paths.ts', import.meta.url).href;

  for (const point of reclaimPoints) {
    await t.test(point, async () => {
      const fx = fixture();
      const paths = routerPaths(join(fx.root, '.router'));
      const label = `review:crash:${point}`;
      const path = paths.activity(activityKey(label));
      const reclaimPath = `${path}.reclaim`;
      const marker = join(fx.root, 'barrier-reached');
      const release = join(fx.root, 'barrier-release');
      let child: ChildProcess | undefined;
      let stderr = '';
      try {
        if (point !== 'finish-snapshot') {
          const at = new Date().toISOString();
          writeActivity(path, {
            label,
            pid: 2_147_483_647,
            started_at: at,
            beat_at: at,
          });
        }

        child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `const { existsSync, writeFileSync } = await import('node:fs');\n` +
              `const { claimActivity, finishActivity, setActivityTestHookForTesting } = await import(${JSON.stringify(activityModuleUrl)});\n` +
              `const { routerPaths } = await import(${JSON.stringify(pathsModuleUrl)});\n` +
              `const paths = routerPaths(${JSON.stringify(join(fx.root, '.router'))});\n` +
              `setActivityTestHookForTesting((seen) => {\n` +
              `  if (seen !== ${JSON.stringify(point)}) return;\n` +
              `  writeFileSync(${JSON.stringify(marker)}, seen);\n` +
              `  while (!existsSync(${JSON.stringify(release)})) {\n` +
              `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);\n` +
              `  }\n` +
              `});\n` +
              `const claimed = claimActivity(paths, ${JSON.stringify(label)});\n` +
              (point === 'finish-snapshot'
                ? `finishActivity(claimed, 'ok', []);\n`
                : '') +
              `process.exit(90);\n`,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        assert.ok(
          await waitUntil(() => existsSync(marker)),
          `child never reached ${point}: ${stderr}`,
        );

        const guardExpected = point !== 'finish-snapshot';
        assert.equal(existsSync(reclaimPath), guardExpected);
        if (point === 'reclaim-before-install') assert.equal(existsSync(path), false);

        child.kill('SIGKILL');
        await waitForExit(child);
        assert.equal(child.signalCode, 'SIGKILL');

        const beforeRecovery = readActivity(path);
        assert.notEqual(activityState(beforeRecovery), 'running', 'a killed owner still looked live');

        const recovered = claimActivity(paths, label);
        assert.equal(recovered.record.pid, process.pid);
        assert.equal(activityState(readActivity(path)), 'running');
        assert.equal(existsSync(reclaimPath), false, 'the dead reclaim guard survived recovery');
        assert.equal(
          readdirSync(fx.activityDir).filter((name) => name.endsWith('.json')).length,
          1,
          'more than one public activity owner was installed',
        );
        const diagnostics: string[] = [];
        finishActivity(recovered, 'ok', diagnostics);
        assert.deepEqual(diagnostics, []);
      } finally {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await waitForExit(child).catch(() => undefined);
        }
        fx.cleanup();
      }
    });
  }
});

test('an in-place owner update after stale detection makes reclaim stand down before unlink', async () => {
  const fx = fixture();
  const paths = routerPaths(join(fx.root, '.router'));
  const label = 'review:heartbeat-resumed';
  const path = paths.activity(activityKey(label));
  const marker = join(fx.root, 'before-unlink');
  const release = join(fx.root, 'release-unlink');
  const activityModuleUrl = new URL('../src/io/activity.ts', import.meta.url).href;
  const pathsModuleUrl = new URL('../src/io/paths.ts', import.meta.url).href;
  const staleBeat = new Date(Date.now() - DEFAULT_STALE_MS - 1_000).toISOString();
  const stale = writeActivity(path, {
    label,
    pid: process.pid,
    started_at: staleBeat,
    beat_at: staleBeat,
  });
  const originalStat = statSync(path, { bigint: true });
  let contender: ChildProcess | undefined;
  let stderr = '';
  try {
    contender = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { existsSync, writeFileSync } = await import('node:fs');\n` +
          `const { ActivityAlreadyExistsError, claimActivity, setActivityTestHookForTesting } = await import(${JSON.stringify(activityModuleUrl)});\n` +
          `const { routerPaths } = await import(${JSON.stringify(pathsModuleUrl)});\n` +
          `setActivityTestHookForTesting((seen) => {\n` +
          `  if (seen !== 'reclaim-before-unlink') return;\n` +
          `  writeFileSync(${JSON.stringify(marker)}, seen);\n` +
          `  while (!existsSync(${JSON.stringify(release)})) {\n` +
          `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);\n` +
          `  }\n` +
          `});\n` +
          `try {\n` +
          `  claimActivity(routerPaths(${JSON.stringify(join(fx.root, '.router'))}), ${JSON.stringify(label)});\n` +
          `  process.exit(91);\n` +
          `} catch (error) {\n` +
          `  if (error instanceof ActivityAlreadyExistsError) process.exit(23);\n` +
          `  console.error(error); process.exit(92);\n` +
          `}\n`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    contender.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    assert.ok(await waitUntil(() => existsSync(marker)), `reclaimer never paused: ${stderr}`);

    writeFileSync(
      path,
      `${JSON.stringify({ ...stale, beat_at: new Date().toISOString() }, null, 2)}\n`,
    );
    const resumed = readActivity(path);
    assert.ok(resumed);
    assert.equal(activityState(resumed), 'running');
    const resumedStat = statSync(path, { bigint: true });
    assert.equal(resumedStat.dev, originalStat.dev);
    assert.equal(resumedStat.ino, originalStat.ino, 'heartbeat replaced rather than updated the inode');

    writeFileSync(release, 'continue');
    await waitForExit(contender);
    assert.equal(contender.exitCode, 23, stderr);
    const retained = readActivity(path);
    assert.ok(retained);
    assert.equal(retained.owner_token, stale.owner_token);
    assert.equal(activityState(retained), 'running');
    assert.equal(existsSync(`${path}.reclaim`), false);
  } finally {
    if (contender !== undefined && contender.exitCode === null && contender.signalCode === null) {
      contender.kill('SIGKILL');
      await waitForExit(contender).catch(() => undefined);
    }
    fx.cleanup();
  }
});

test('an activity heartbeat skips every beat while its reclaim guard exists, then resumes', async () => {
  const fx = fixture();
  const path = join(fx.activityDir, 'guarded-heartbeat.json');
  const reclaimPath = `${path}.reclaim`;
  const initialBeat = '2000-01-01T00:00:00.000Z';
  try {
    const activity = writeActivity(path, {
      label: 'review:guarded-heartbeat',
      pid: process.pid,
      started_at: new Date().toISOString(),
      beat_at: initialBeat,
    });
    writeFileSync(reclaimPath, 'reclaim in progress');
    const heartbeat = startActivityHeartbeat(path, activity, 40);
    try {
      const started = await heartbeat.started;
      if (!started.ok) assert.fail(started.error.message);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        readActivity(path)?.beat_at,
        initialBeat,
        'the old owner wrote through an active reclaim guard',
      );
      assert.doesNotThrow(
        () => process.kill(heartbeat.pid!, 0),
        'the skipped heartbeat exited instead of waiting for reclaim to finish',
      );

      rmSync(reclaimPath, { force: true });
      assert.ok(
        await waitUntil(() => readActivity(path)?.beat_at !== initialBeat),
        'the old owner did not resume after reclaim stood down',
      );
    } finally {
      heartbeat.stop();
    }
  } finally {
    fx.cleanup();
  }
});

test('finish re-confirms ownership and inode after its snapshot before unlinking', async () => {
  const fx = fixture();
  const paths = routerPaths(join(fx.root, '.router'));
  const label = 'review:finish-race';
  const path = paths.activity(activityKey(label));
  const marker = join(fx.root, 'finish-snapshot');
  const release = join(fx.root, 'finish-release');
  const result = join(fx.root, 'finish-result.json');
  const activityModuleUrl = new URL('../src/io/activity.ts', import.meta.url).href;
  const pathsModuleUrl = new URL('../src/io/paths.ts', import.meta.url).href;
  let finisher: ChildProcess | undefined;
  let stderr = '';
  try {
    finisher = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { existsSync, writeFileSync } = await import('node:fs');\n` +
          `const { claimActivity, finishActivity, setActivityTestHookForTesting } = await import(${JSON.stringify(activityModuleUrl)});\n` +
          `const { routerPaths } = await import(${JSON.stringify(pathsModuleUrl)});\n` +
          `setActivityTestHookForTesting((seen) => {\n` +
          `  if (seen !== 'finish-snapshot') return;\n` +
          `  writeFileSync(${JSON.stringify(marker)}, seen);\n` +
          `  while (!existsSync(${JSON.stringify(release)})) {\n` +
          `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);\n` +
          `  }\n` +
          `});\n` +
          `const claimed = claimActivity(routerPaths(${JSON.stringify(join(fx.root, '.router'))}), ${JSON.stringify(label)});\n` +
          `const diagnostics = [];\n` +
          `finishActivity(claimed, 'ok', diagnostics);\n` +
          `writeFileSync(${JSON.stringify(result)}, JSON.stringify(diagnostics));\n`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    finisher.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    assert.ok(await waitUntil(() => existsSync(marker)), `finisher never paused: ${stderr}`);
    const oldOwner = readActivity(path);
    assert.ok(oldOwner);

    const now = new Date().toISOString();
    const replacement = writeActivity(path, {
      label,
      pid: process.pid,
      started_at: now,
      beat_at: now,
    });
    assert.notEqual(replacement.owner_token, oldOwner.owner_token);
    writeFileSync(release, 'continue');
    await waitForExit(finisher);
    assert.equal(finisher.exitCode, 0, stderr);

    assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), [
      `could not remove activity ${path}: ownership or file identity changed`,
    ]);
    const retained = readActivity(path);
    assert.ok(retained);
    assert.equal(retained.owner_token, replacement.owner_token);
    assert.equal(activityState(retained), 'running');
  } finally {
    if (finisher !== undefined && finisher.exitCode === null && finisher.signalCode === null) {
      finisher.kill('SIGKILL');
      await waitForExit(finisher).catch(() => undefined);
    }
    fx.cleanup();
  }
});

test('a replacement with the same label, pid, and millisecond gets a new heartbeat authority', async () => {
  const fx = fixture();
  const path = join(fx.activityDir, 'replaced.json');
  const startedAt = '2026-08-25T00:00:00.000Z';
  const initialBeat = '2000-01-01T00:00:00.000Z';
  try {
    const first = writeActivity(path, {
      label: 'review:architect',
      pid: process.pid,
      started_at: startedAt,
      beat_at: initialBeat,
    });
    const beater = startActivityHeartbeat(path, first, 40);
    try {
      assert.ok(
        await waitUntil(() => readActivity(path)?.beat_at !== initialBeat),
        'the original activity never beat',
      );
      const replacement = writeActivity(path, {
        label: first.label,
        pid: first.pid,
        started_at: first.started_at,
        beat_at: initialBeat,
      });
      assert.notEqual(replacement.owner_token, first.owner_token);

      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        readActivity(path)?.beat_at,
        initialBeat,
        'the old heartbeat refreshed a same-millisecond replacement',
      );
    } finally {
      beater.stop();
    }
  } finally {
    fx.cleanup();
  }
});

test('owner stays running while spawnSync blocks it, then becomes disconnected after SIGKILL', async () => {
  const fx = fixture();
  const path = join(fx.activityDir, 'blocked.json');
  const blockedWindow = join(fx.root, 'blocked-window.json');
  const samples = join(fx.root, 'samples.jsonl');
  const watcherReady = join(fx.root, 'watcher-ready');
  const watcherStop = join(fx.root, 'watcher-stop');
  const ownerGo = join(fx.root, 'owner-go');
  const moduleUrl = new URL('../src/io/activity.ts', import.meta.url).href;
  const blockerSource =
    `const fs=require('node:fs');` +
    `const blockedFrom=Date.now();` +
    `fs.writeFileSync(${JSON.stringify(blockedWindow)},JSON.stringify({blockedFrom}));` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);` +
    `const blockedUntil=Date.now();` +
    `fs.writeFileSync(${JSON.stringify(blockedWindow)},JSON.stringify({blockedFrom,blockedUntil}));`;
  let owner: ChildProcess | undefined;
  let watcher: ChildProcess | undefined;
  try {
    const spawnedOwner = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { spawnSync } = await import('node:child_process');\n` +
          `const { existsSync } = await import('node:fs');\n` +
          `const { writeActivity, startActivityHeartbeat } = await import(${JSON.stringify(moduleUrl)});\n` +
          `const started_at = new Date().toISOString();\n` +
          `const activity = writeActivity(${JSON.stringify(path)}, { label: 'task:blocked', pid: process.pid, started_at, beat_at: started_at });\n` +
          `const heartbeat = startActivityHeartbeat(${JSON.stringify(path)}, activity, 40);\n` +
          `console.log(JSON.stringify({ started_at, heartbeat_pid: heartbeat.pid }));\n` +
          `while (!existsSync(${JSON.stringify(ownerGo)})) await new Promise((resolve) => setTimeout(resolve, 10));\n` +
          `spawnSync(process.execPath, ['-e', ${JSON.stringify(blockerSource)}]);\n` +
          `setInterval(() => {}, 1000);\n`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    owner = spawnedOwner;
    let stdout = '';
    spawnedOwner.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    assert.ok(await waitUntil(() => stdout.trim() !== ''), 'owner never initialized its activity');

    watcher = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');` +
          `fs.writeFileSync(${JSON.stringify(watcherReady)},'ready');` +
          `const t=setInterval(()=>{` +
          `try{const beat=JSON.parse(fs.readFileSync(${JSON.stringify(path)},'utf8')).beat_at;` +
          `fs.appendFileSync(${JSON.stringify(samples)},JSON.stringify([Date.now(),beat])+'\\n');}catch{}` +
          `if(fs.existsSync(${JSON.stringify(watcherStop)})){clearInterval(t);process.exit(0);}` +
          `},15);` +
          `setTimeout(()=>{clearInterval(t);process.exit(1)},5000);`,
      ],
      { stdio: 'ignore' },
    );
    assert.ok(await waitUntil(() => existsSync(watcherReady)), 'independent watcher never started');
    writeFileSync(ownerGo, 'go');

    let window: { blockedFrom: number; blockedUntil: number } | null = null;
    assert.ok(
      await waitUntil(() => {
        try {
          const value = JSON.parse(readFileSync(blockedWindow, 'utf8')) as Partial<{
            blockedFrom: number;
            blockedUntil: number;
          }>;
          if (typeof value.blockedFrom !== 'number' || typeof value.blockedUntil !== 'number') return false;
          window = { blockedFrom: value.blockedFrom, blockedUntil: value.blockedUntil };
          return true;
        } catch {
          return false;
        }
      }),
      'owner never completed its spawnSync block',
    );
    writeFileSync(watcherStop, 'stop');
    assert.ok(
      await waitUntil(() => watcher!.exitCode !== null || watcher!.signalCode !== null),
      'independent watcher did not stop',
    );
    assert.equal(watcher.exitCode, 0);

    assert.ok(window !== null);
    const rows = readFileSync(samples, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as [number, string]);
    const inWindow = rows.filter(
      ([sampledAt]) => sampledAt > window!.blockedFrom && sampledAt < window!.blockedUntil,
    );
    assert.ok(inWindow.length > 5, `watcher barely sampled during the block (${inWindow.length})`);
    const distinctBeats = new Set(inWindow.map(([, beatAt]) => beatAt));
    assert.ok(
      distinctBeats.size >= 2,
      `only ${distinctBeats.size} distinct beat_at values during spawnSync: no cross-process beat`,
    );

    const blocked = readActivity(path);
    assert.ok(blocked !== null);
    assert.equal(activityState(blocked), 'running');

    spawnedOwner.kill('SIGKILL');
    assert.ok(
      await waitUntil(() => spawnedOwner.exitCode !== null || spawnedOwner.signalCode !== null),
      'owner survived SIGKILL',
    );
    assert.equal(activityState(readActivity(path)), 'disconnected');
  } finally {
    if (watcher !== undefined && watcher.exitCode === null && watcher.signalCode === null) {
      watcher.kill('SIGKILL');
    }
    if (owner !== undefined && owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    fx.cleanup();
  }
});

test('observeActivities skips ended and corrupt files without hiding live or disconnected rows', () => {
  const fx = fixture();
  try {
    mkdirSync(fx.activityDir, { recursive: true });
    const now = Date.now();
    writeActivity(join(fx.activityDir, 'live.json'), record({ label: 'live', started_at: new Date(now - 3_000).toISOString(), beat_at: new Date(now).toISOString() }));
    writeActivity(join(fx.activityDir, 'lost.json'), record({ label: 'lost', pid: 2_147_483_647, started_at: new Date(now - 2_000).toISOString(), beat_at: new Date(now).toISOString() }));
    writeFileSync(
      join(fx.activityDir, 'ended.json'),
      `${JSON.stringify(record({ label: 'ended', ended_at: new Date(now).toISOString(), outcome: 'ok' }))}\n`,
    );
    writeFileSync(join(fx.activityDir, 'broken.json'), '{ truncated');

    assert.deepEqual(
      observeActivities(fx.activityDir, now).map(({ record: activity, state }) => [activity.label, state]),
      [
        ['live', 'running'],
        ['lost', 'disconnected'],
      ],
    );
  } finally {
    fx.cleanup();
  }
});

test('activity lifecycle writes are atomically visible to a concurrent reader', async () => {
  const fx = fixture();
  const path = join(fx.activityDir, 'atomic.json');
  const done = join(fx.root, 'done');
  const moduleUrl = new URL('../src/io/activity.ts', import.meta.url).href;
  try {
    writeActivity(path, record({ label: 'initial' }));
    const writer = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { writeFileSync } = await import('node:fs');\n` +
          `const { writeActivity } = await import(${JSON.stringify(moduleUrl)});\n` +
          `for (let i = 0; i < 100; i++) {\n` +
          `  const at = new Date().toISOString();\n` +
          `  writeActivity(${JSON.stringify(path)}, { label: 'writer-' + i, pid: process.pid, started_at: at, beat_at: at });\n` +
          `}\n` +
          `writeFileSync(${JSON.stringify(done)}, 'done');\n`,
      ],
      { stdio: 'inherit' },
    );
    const exited = new Promise<number | null>((resolve) => writer.once('exit', resolve));
    const deadline = Date.now() + 5000;
    let reads = 0;
    while (!existsSync(done) && Date.now() < deadline) {
      const raw = readFileSync(path, 'utf8');
      assert.doesNotThrow(() => JSON.parse(raw));
      assert.ok(readActivity(path) !== null, 'reader observed a partial activity document');
      reads += 1;
    }
    assert.ok(existsSync(done), 'concurrent writer did not finish');
    assert.equal(await exited, 0);
    assert.ok(reads > 0, 'the reader never overlapped the writer');
    assert.equal(readdirSync(fx.activityDir).some((name) => name.startsWith('.tmp.')), false);
  } finally {
    fx.cleanup();
  }
});
