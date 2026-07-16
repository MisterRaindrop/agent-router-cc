// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseWorker, type SuperviseSpec } from '../src/io/supervisor.ts';
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const NODE = process.execPath;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function baseSpec(dir: string, script: string, over: Partial<SuperviseSpec> = {}): SuperviseSpec {
  return {
    argv: [NODE, '-e', script],
    cwd: dir,
    env: process.env,
    logPath: join(dir, 'logs', 'worker.log'),
    heartbeatPath: join(dir, 'heartbeat'),
    watchDir: dir,
    maxWallMs: 10_000,
    stallMs: 10_000,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 50,
    sigkillGraceMs: 200,
    ...over,
  };
}
const tmp = (): string => mkdtempSync(join(tmpdir(), 'router-sup-'));

test('clean exit => ok, rc 0, heartbeat written', async () => {
  const dir = tmp();
  try {
    const o = await superviseWorker(baseSpec(dir, 'process.exit(0)'));
    assert.equal(o.exitClass, 'ok');
    assert.equal(o.rc, 0);
    assert.ok(existsSync(join(dir, 'heartbeat')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nonzero exit => task_failed', async () => {
  const dir = tmp();
  try {
    const o = await superviseWorker(baseSpec(dir, 'process.exit(7)'));
    assert.equal(o.exitClass, 'task_failed');
    assert.equal(o.rc, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exceeding max wall => timeout (killed)', async () => {
  const dir = tmp();
  try {
    const o = await superviseWorker(baseSpec(dir, 'setInterval(()=>{},1000)', { maxWallMs: 250 }));
    assert.equal(o.timedOut, true);
    assert.equal(o.exitClass, 'timeout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no log growth and no worktree change => stalled', async () => {
  const dir = tmp();
  try {
    // writes once, then idles forever without touching the worktree
    const o = await superviseWorker(
      baseSpec(dir, 'console.log("go"); setInterval(()=>{},1000)', {
        stallMs: 300,
        maxWallMs: 10_000,
      }),
    );
    assert.equal(o.stalled, true);
    assert.equal(o.exitClass, 'stalled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unlaunchable worker => env_error (does not count as attempt)', async () => {
  const dir = tmp();
  try {
    const o = await superviseWorker(
      baseSpec(dir, '', { argv: ['router-nonexistent-binary-xyz-123'] }),
    );
    assert.equal(o.exitClass, 'env_error');
    assert.ok(o.spawnError !== null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('death by signal we did not send => worker_crash', async () => {
  const dir = tmp();
  try {
    const o = await superviseWorker(baseSpec(dir, 'process.kill(process.pid, "SIGKILL")'));
    assert.equal(o.exitClass, 'worker_crash');
    assert.equal(o.signal, 'SIGKILL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('killing the group reaps a grandchild process', async () => {
  const dir = tmp();
  const gcFile = join(dir, 'gc.pid');
  try {
    const script =
      'const cp=require("child_process");const fs=require("fs");' +
      'const c=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"]);' +
      'fs.writeFileSync(process.env.GC_PID_FILE, String(c.pid));' +
      'setInterval(()=>{},1000);';
    const o = await superviseWorker(
      baseSpec(dir, script, {
        maxWallMs: 400,
        sigkillGraceMs: 150,
        env: { ...process.env, GC_PID_FILE: gcFile },
      }),
    );
    assert.equal(o.exitClass, 'timeout');
    const gcPid = Number(readFileSync(gcFile, 'utf8').trim());
    assert.ok(Number.isInteger(gcPid) && gcPid > 1);
    await sleep(400); // let SIGKILL propagate to the group
    assert.equal(isProcessAlive(gcPid), false, 'grandchild should be reaped with the group');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
