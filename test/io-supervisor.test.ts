// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    watchPaths: [dir],
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

// Review finding 5. When the executor's leader exited NORMALLY, supervision resolved without
// touching the rest of its process group -- so an executor that started a background compiler,
// server or script and then returned cleanly left those children writing the same checkout after
// the caller had already released the exclusive lock. The escalation path only ran on timeout and
// stall, which means the SUCCESS path was the one that leaked.
test('a normal exit terminates the whole process group, not just the leader (finding 5)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-supervise-'));
  const script = join(dir, 'leader.mjs');
  const survivorPidFile = join(dir, 'survivor.pid');
  // The leader spawns a child IN ITS OWN GROUP (not detached), reports its pid, and exits 0.
  writeFileSync(
    script,
    "import { spawn } from 'node:child_process';\n" +
      "import { writeFileSync } from 'node:fs';\n" +
      "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });\n" +
      `writeFileSync(${JSON.stringify(survivorPidFile)}, String(c.pid));\n` +
      'c.unref();\n' +
      'process.exit(0);\n',
  );
  try {
    const outcome = await superviseWorker({
      argv: [process.execPath, script],
      cwd: dir,
      env: process.env,
      logPath: join(dir, 'worker.log'),
      heartbeatPath: join(dir, 'heartbeat'),
      watchPaths: [dir],
      maxWallMs: 20_000,
      stallMs: 20_000,
      pollIntervalMs: 50,
    });
    assert.equal(outcome.exitClass, 'ok');
    assert.equal(outcome.rc, 0);

    const survivor = Number(readFileSync(survivorPidFile, 'utf8').trim());
    assert.ok(Number.isInteger(survivor) && survivor > 1, 'the leader never reported its child');
    // Give the signal a moment to land; the kill is deliberately non-blocking.
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(survivor, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.throws(
      () => process.kill(survivor, 0),
      /ESRCH|no such process/i,
      'a child of the executor outlived a normal exit and would keep writing the checkout',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
