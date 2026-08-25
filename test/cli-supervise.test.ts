// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli/args.ts';
import { activityKey, activityState, readActivity } from '../src/io/activity.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const LOCK_MODULE = new URL('../src/io/lock.ts', import.meta.url).href;
const NODE = process.execPath;

const tmp = (): string => mkdtempSync(join(tmpdir(), 'router-cli-supervise-'));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function router(dir: string, argv: string[]) {
  return spawnSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

test('supervise preserves every command argument after the double-dash boundary', () => {
  const parsed = parseArgs([
    'supervise',
    '--label',
    'review:architect',
    '--log=review.log',
    '--',
    'codex',
    'exec',
    '--json',
    '--model=gpt-5.6-sol',
    'a brief with spaces',
  ]);

  assert.equal(parsed.verb, 'supervise');
  assert.deepEqual(parsed.flags, { label: 'review:architect', log: 'review.log' });
  assert.deepEqual(parsed.passthrough, [
    'codex',
    'exec',
    '--json',
    '--model=gpt-5.6-sol',
    'a brief with spaces',
  ]);
  assert.deepEqual(parsed.positionals, parsed.passthrough);
});

test('supervise validates its own arguments before creating router state', () => {
  const dir = tmp();
  try {
    const cases = [
      { argv: ['supervise', '--log', 'out.log', '--', NODE], message: /requires --label/ },
      { argv: ['supervise', '--label', 'review:architect', '--', NODE], message: /requires --log/ },
      {
        argv: ['supervise', '--label', 'review:architect', '--log', 'out.log', NODE],
        message: /requires '--' before the command/,
      },
      {
        argv: ['supervise', '--label', 'review:architect', '--log', 'out.log', '--'],
        message: /requires a command after --/,
      },
    ];

    for (const example of cases) {
      const run = router(dir, example.argv);
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, example.message);
    }
    assert.equal(existsSync(join(dir, '.router')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supervise preserves combined log bytes, truncates like redirection, and returns a nonzero code', () => {
  const dir = tmp();
  try {
    const directLog = join(dir, 'direct.log');
    const supervisedLog = join(dir, 'nested', 'supervised.log');
    const script =
      "const fs=require('node:fs');" +
      'fs.writeSync(1,Buffer.from([0,65,10]));' +
      'fs.writeSync(2,Buffer.from([255,66,10]));' +
      'fs.writeSync(1,Buffer.from(process.argv.slice(1).join("|")));' +
      'process.exit(7)';

    const directFd = openSync(directLog, 'w');
    const direct = spawnSync(NODE, ['-e', script, '--', '--child-json', 'brief with spaces'], {
      cwd: dir,
      stdio: ['ignore', directFd, directFd],
    });
    closeSync(directFd);
    assert.equal(direct.status, 7);

    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(supervisedLog, 'old bytes that direct > would remove');
    const supervised = router(dir, [
      'supervise',
      '--label',
      'review:architect',
      '--log',
      supervisedLog,
      '--',
      NODE,
      '-e',
      script,
      '--',
      '--child-json',
      'brief with spaces',
    ]);

    assert.equal(supervised.status, 7, supervised.stderr);
    assert.deepEqual(readFileSync(supervisedLog), readFileSync(directLog));
    const activityDir = join(dir, '.router', 'activity');
    assert.deepEqual(readdirSync(activityDir), []);
    assert.equal(existsSync(join(dir, '.router', 'gate.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supervise maps a command signal to the conventional shell exit code and cleans up', () => {
  const dir = tmp();
  try {
    const run = router(dir, [
      'supervise',
      '--label',
      'review:signal',
      '--log',
      'signal.log',
      '--',
      NODE,
      '-e',
      "process.kill(process.pid, 'SIGKILL')",
    ]);

    assert.equal(run.status, 137, run.stderr);
    assert.deepEqual(readdirSync(join(dir, '.router', 'activity')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a running supervise owns one moving activity, rejects its label peer, and never takes gate.lock', async () => {
  const dir = tmp();
  const label = 'review:architect';
  const activityPath = join(dir, '.router', 'activity', `${activityKey(label)}.json`);
  const workerPidPath = join(dir, 'worker.pid');
  const firstLog = join(dir, 'first.log');
  const secondLog = join(dir, 'second.log');
  const childScript =
    `require('node:fs').writeFileSync(${JSON.stringify(workerPidPath)}, String(process.pid));` +
    'setTimeout(() => process.exit(0), 18000)';
  let first: ChildProcess | undefined;

  try {
    first = spawn(
      NODE,
      [ENTRY, 'supervise', '--label', label, '--log', firstLog, '--', NODE, '-e', childScript],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await waitUntil(() => readActivity(activityPath) !== null && existsSync(workerPidPath));
    const initial = readActivity(activityPath);
    assert.ok(initial);
    assert.equal(initial.label, label);
    assert.equal(initial.pid, first.pid);

    writeFileSync(secondLog, 'do not truncate the running report');
    const duplicate = router(dir, [
      'supervise',
      '--label',
      label,
      '--log',
      secondLog,
      '--',
      NODE,
      '-e',
      'process.exit(0)',
    ]);
    assert.equal(duplicate.status, 2, duplicate.stderr);
    assert.match(duplicate.stderr, /review:architect/);
    assert.match(duplicate.stderr, new RegExp(`pid ${initial.pid}`));
    assert.equal(readFileSync(secondLog, 'utf8'), 'do not truncate the running report');

    const lockProbe = spawnSync(
      NODE,
      [
        '--input-type=module',
        '-e',
        `import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};\n` +
          'const held = acquireLock(process.argv[1], { waitMs: 0 });\n' +
          "if (!('release' in held)) process.exit(9);\n" +
          'held.release();',
        join(dir, '.router', 'gate.lock'),
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(lockProbe.status, 0, lockProbe.stderr);
    assert.equal(existsSync(join(dir, '.router', 'gate.lock')), false);

    await waitUntil(() => {
      const current = readActivity(activityPath);
      return current !== null && current.beat_at !== initial.beat_at;
    }, 17_000);

    const ended = await waitForExit(first);
    assert.deepEqual(ended, { code: 0, signal: null });
    assert.equal(existsSync(activityPath), false);
    assert.deepEqual(readdirSync(join(dir, '.router', 'activity')), []);
  } finally {
    if (first !== undefined && first.exitCode === null && first.pid !== undefined) first.kill('SIGKILL');
    if (existsSync(workerPidPath)) killGroup(Number(readFileSync(workerPidPath, 'utf8')));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGKILL of the supervise owner leaves a disconnected activity instead of deleting it', async () => {
  const dir = tmp();
  const label = 'review:killed-owner';
  const activityPath = join(dir, '.router', 'activity', `${activityKey(label)}.json`);
  const workerPidPath = join(dir, 'worker.pid');
  const childScript =
    `require('node:fs').writeFileSync(${JSON.stringify(workerPidPath)}, String(process.pid));` +
    'setInterval(() => {}, 1000)';
  let owner: ChildProcess | undefined;

  try {
    owner = spawn(
      NODE,
      [ENTRY, 'supervise', '--label', label, '--log', 'killed.log', '--', NODE, '-e', childScript],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await waitUntil(() => readActivity(activityPath) !== null && existsSync(workerPidPath));
    owner.kill('SIGKILL');
    const ended = await waitForExit(owner);
    assert.equal(ended.signal, 'SIGKILL');

    const activity = readActivity(activityPath);
    assert.ok(activity);
    assert.equal(activity.pid, owner.pid);
    assert.equal(existsSync(activityPath), true);
    assert.equal(activityState(activity), 'disconnected');
  } finally {
    if (owner !== undefined && owner.exitCode === null) owner.kill('SIGKILL');
    if (existsSync(workerPidPath)) killGroup(Number(readFileSync(workerPidPath, 'utf8')));
    rmSync(dir, { recursive: true, force: true });
  }
});
