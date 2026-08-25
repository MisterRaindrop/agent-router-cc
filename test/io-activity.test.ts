// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { ActivityRecord } from '../src/domain/types.ts';
import {
  activityKey,
  activityState,
  observeActivities,
  readActivities,
  readActivity,
  writeActivity,
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

test('the paths getter stores a path-safe, deterministic key under .router/activity', () => {
  const fx = fixture();
  try {
    const paths = routerPaths(join(fx.root, '.router'));
    const key = activityKey('../review:architect\\senior?');
    assert.doesNotMatch(key, /[/\\]/u);
    assert.equal(paths.activityDir, fx.activityDir);
    assert.equal(paths.activity(key), join(fx.activityDir, `${key}.json`));
    assert.equal(dirname(paths.activity(key)), fx.activityDir);
  } finally {
    fx.cleanup();
  }
});

test('activity storage round-trips the frozen schema and ignores a truncated sibling', () => {
  const fx = fixture();
  try {
    const paths = routerPaths(join(fx.root, '.router'));
    const complete = record({
      status_path: paths.runStatus('p1'),
      ended_at: '2026-08-25T01:02:03.000Z',
      outcome: 'ok',
    });
    const completePath = paths.activity(activityKey(complete.label));
    writeActivity(completePath, complete);
    writeFileSync(join(fx.activityDir, 'truncated.json'), '{ truncated');

    assert.deepEqual(readActivity(completePath), complete);
    assert.deepEqual(readActivities(fx.activityDir), [{ path: completePath, record: complete }]);
    assert.equal(readActivity(join(fx.activityDir, 'missing.json')), null);
  } finally {
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
  assert.equal(activityState({ ...fresh, pid: 2_147_483_647 }, now), 'disconnected');
});

test('owner stays running while spawnSync blocks it, then becomes disconnected after SIGKILL', async () => {
  const fx = fixture();
  const path = join(fx.activityDir, 'blocked.json');
  const moduleUrl = new URL('../src/io/activity.ts', import.meta.url).href;
  let owner: ChildProcess | undefined;
  try {
    const spawnedOwner = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { spawnSync } = await import('node:child_process');\n` +
          `const { writeActivity, startActivityHeartbeat } = await import(${JSON.stringify(moduleUrl)});\n` +
          `const started_at = new Date().toISOString();\n` +
          `const activity = { label: 'task:blocked', pid: process.pid, started_at, beat_at: started_at };\n` +
          `writeActivity(${JSON.stringify(path)}, activity);\n` +
          `const heartbeat = startActivityHeartbeat(${JSON.stringify(path)}, activity, 40);\n` +
          `console.log(JSON.stringify({ started_at, heartbeat_pid: heartbeat.pid }));\n` +
          `spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000)']);\n` +
          `setInterval(() => {}, 1000);\n`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    owner = spawnedOwner;
    let stdout = '';
    spawnedOwner.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    assert.ok(await waitUntil(() => stdout.trim() !== ''), 'owner never initialized its activity');
    const startedAt = (JSON.parse(stdout.trim()) as { started_at: string }).started_at;

    assert.ok(
      await waitUntil(() => {
        const current = readActivity(path);
        return current !== null && current.beat_at !== startedAt;
      }),
      'no heartbeat landed while the owner was blocked',
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
    writeActivity(join(fx.activityDir, 'ended.json'), record({ label: 'ended', ended_at: new Date(now).toISOString(), outcome: 'ok' }));
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
