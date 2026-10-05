// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import { childEnv } from './childEnv.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli/args.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const NODE = process.execPath;

const tmp = (): string => mkdtempSync(join(tmpdir(), 'router-cli-supervise-'));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function router(dir: string, argv: string[], env: NodeJS.ProcessEnv = childEnv()) {
  return spawnSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
}

// The ceiling is a LIVENESS bound, not a latency claim: every caller asks "does this eventually
// happen", and a thing that never happens never happens. 5s sat close enough to real startup and
// scheduling latency that a loaded machine (load average 136, measured) failed these tests while
// asserting nothing about the property under test. Set it far above any plausible latency so the
// only way to hit it is a genuine hang.
async function waitUntil(check: () => boolean, timeoutMs = 30_000): Promise<void> {
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

test('supervise validates its own arguments, and never creates router state', () => {
  const dir = tmp();
  try {
    const cases = [
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
    // Nothing is published anywhere: the log is the whole record of the run.
    assert.equal(existsSync(join(dir, '.router')), false);
    assert.equal(existsSync(`${supervisedLog}.heartbeat`), false);
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
    assert.equal(existsSync(join(dir, 'signal.log.heartbeat')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGTERM to the supervise process drains its worker and passes the signal on as an exit code', async () => {
  const dir = tmp();
  const workerPidPath = join(dir, 'signal-worker.pid');
  const childScript =
    `require('node:fs').writeFileSync(${JSON.stringify(workerPidPath)},String(process.pid));` +
    'setInterval(()=>{},1000)';
  let owner: ChildProcess | undefined;

  try {
    owner = spawn(
      NODE,
      [ENTRY, 'supervise', '--log', 'signal-owner.log', '--', NODE, '-e', childScript],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() },
    );
    await waitUntil(() => existsSync(workerPidPath));
    const workerPid = Number(readFileSync(workerPidPath, 'utf8'));

    owner.kill('SIGTERM');
    const ended = await waitForExit(owner);
    assert.deepEqual(ended, { code: 143, signal: null });
    await waitUntil(() => !processIsAlive(workerPid));
  } finally {
    if (owner !== undefined && owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    if (existsSync(workerPidPath)) killGroup(Number(readFileSync(workerPidPath, 'utf8')));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worker-heartbeat cleanup failure is diagnosed without replacing the worker exit code', () => {
  const dir = tmp();
  const workerHeartbeatPath = join(dir, 'worker-heartbeat-cleanup.log.heartbeat');
  try {
    const script =
      "const fs=require('node:fs');" +
      `while(!fs.existsSync(${JSON.stringify(workerHeartbeatPath)})){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}` +
      `fs.unlinkSync(${JSON.stringify(workerHeartbeatPath)});` +
      `fs.mkdirSync(${JSON.stringify(workerHeartbeatPath)});` +
      'process.exit(7)';
    const run = router(dir, ['supervise', '--log', 'worker-heartbeat-cleanup.log', '--', NODE, '-e', script]);

    assert.equal(run.status, 7, run.stderr);
    assert.match(run.stderr, /supervise cleanup: could not remove worker heartbeat/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
