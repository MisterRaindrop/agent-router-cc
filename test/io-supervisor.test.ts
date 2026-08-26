// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import { childEnv } from './childEnv.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
        // The worker has to boot node, spawn a grandchild and record its pid BEFORE the wall clock
        // fires, or there is nothing to assert about. 400ms did not clear node's own startup on a
        // loaded machine, and the test then died on ENOENT reading the pid file -- a broken
        // premise reported as a mysterious file error. This costs a slower test and buys a real one.
        maxWallMs: 5_000,
        sigkillGraceMs: 150,
        env: childEnv({ GC_PID_FILE: gcFile }),
      }),
    );
    assert.equal(o.exitClass, 'timeout');
    assert.ok(existsSync(gcFile), 'the worker never recorded a grandchild: nothing was tested');
    const gcPid = Number(readFileSync(gcFile, 'utf8').trim());
    assert.ok(Number.isInteger(gcPid) && gcPid > 1);
    // Poll, do not bet. The property is that the grandchild is reaped, and 400ms sat close enough
    // to real signal-delivery-plus-teardown latency that a loaded machine failed this every run.
    const deadline = Date.now() + 30_000;
    while (isProcessAlive(gcPid) && Date.now() < deadline) await sleep(50);
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
    // No polling loop here any more, and that is the point: supervision does not resolve until
    // the group is actually empty, so the survivor has to be gone the instant we get the
    // outcome. Waiting up to two seconds for it -- as this test used to -- measured only that
    // the signal eventually landed, which says nothing about whether the caller was already
    // running closeout and the project's build in the same checkout by then.
    assert.throws(
      () => process.kill(survivor, 0),
      /ESRCH|no such process/i,
      'a child of the executor outlived a normal exit and would keep writing the checkout',
    );
    assert.equal(outcome.groupSurvived, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The case the finding-5 test could not see: a child that INSTALLS a SIGTERM handler. One
// polite SIGTERM, sent and immediately forgotten, does nothing to it -- so it outlived
// superviseWorker() and went on writing the user's checkout right through closeout and
// verification, because the caller's own SIGKILL does not arrive until verification is over.
test('a SIGTERM-ignoring child is escalated and waited out before supervision returns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-supervise-stubborn-'));
  const script = join(dir, 'leader.mjs');
  const survivorPidFile = join(dir, 'survivor.pid');
  const ready = join(dir, 'ready');
  // The child reports ready only AFTER its handler is installed, so the leader cannot exit --
  // and the drain cannot start -- while SIGTERM would still kill it on the default disposition.
  writeFileSync(
    join(dir, 'stubborn.mjs'),
    "import { writeFileSync } from 'node:fs';\n" +
      "process.on('SIGTERM', () => {});\n" +
      `writeFileSync(${JSON.stringify(ready)}, '1');\n` +
      'setInterval(() => {}, 1000);\n',
  );
  writeFileSync(
    script,
    "import { spawn } from 'node:child_process';\n" +
      "import { existsSync, writeFileSync } from 'node:fs';\n" +
      `const c = spawn(process.execPath, [${JSON.stringify(join(dir, 'stubborn.mjs'))}], { stdio: 'ignore' });\n` +
      `writeFileSync(${JSON.stringify(survivorPidFile)}, String(c.pid));\n` +
      'c.unref();\n' +
      `const deadline = Date.now() + 5000;\n` +
      `while (!existsSync(${JSON.stringify(ready)}) && Date.now() < deadline) {}\n` +
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
      sigkillGraceMs: 300,
    });
    assert.equal(outcome.exitClass, 'ok');
    assert.equal(outcome.rc, 0);
    assert.ok(existsSync(ready), 'the survivor never installed its SIGTERM handler');

    const survivor = Number(readFileSync(survivorPidFile, 'utf8').trim());
    assert.ok(Number.isInteger(survivor) && survivor > 1, 'the leader never reported its child');
    // Asserted with no grace period at all: SIGTERM was ignored, so the only way this is gone is
    // that supervision escalated to SIGKILL and waited for the group to empty before returning.
    assert.throws(
      () => process.kill(survivor, 0),
      /ESRCH|no such process/i,
      'a SIGTERM-ignoring child of the executor outlived supervision',
    );
    assert.equal(outcome.groupSurvived, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The finding this test exists for is one `node --test` structurally cannot see: the drain's
// poll timer was `unref()`'d, so it did not hold the event loop open -- but the test runner's
// own handles did, on its behalf. The test passed while the real CLI, whose only driver is a
// top-level await, exited 13 with the drain half-done and the child still running.
//
// So this one runs supervision in a SEPARATE node process with nothing else pending, which is
// the shape the CLI actually has. It is the only honest way to assert "the process stays alive
// until the group is gone".
test('supervision keeps a standalone process alive until the group is drained', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-supervise-standalone-'));
  const ready = join(dir, 'ready');
  const survivorPidFile = join(dir, 'survivor.pid');
  writeFileSync(
    join(dir, 'stubborn.mjs'),
    "import { writeFileSync } from 'node:fs';\n" +
      "process.on('SIGTERM', () => {});\n" +
      `writeFileSync(${JSON.stringify(ready)}, '1');\n` +
      'setInterval(() => {}, 1000);\n',
  );
  writeFileSync(
    join(dir, 'leader.mjs'),
    "import { spawn } from 'node:child_process';\n" +
      "import { existsSync, writeFileSync } from 'node:fs';\n" +
      `const c = spawn(process.execPath, [${JSON.stringify(join(dir, 'stubborn.mjs'))}], { stdio: 'ignore' });\n` +
      `writeFileSync(${JSON.stringify(survivorPidFile)}, String(c.pid));\n` +
      'c.unref();\n' +
      `const deadline = Date.now() + 5000;\n` +
      `while (!existsSync(${JSON.stringify(ready)}) && Date.now() < deadline) {}\n` +
      'process.exit(0);\n',
  );
  // A top-level await and nothing else -- exactly src/index.ts.
  const driver = join(dir, 'driver.mjs');
  writeFileSync(
    driver,
    `const { superviseWorker } = await import(${JSON.stringify(join(process.cwd(), 'src/io/supervisor.ts'))});\n` +
      'const outcome = await superviseWorker({\n' +
      `  argv: [process.execPath, ${JSON.stringify(join(dir, 'leader.mjs'))}],\n` +
      `  cwd: ${JSON.stringify(dir)},\n` +
      '  env: process.env,\n' +
      `  logPath: ${JSON.stringify(join(dir, 'worker.log'))},\n` +
      `  heartbeatPath: ${JSON.stringify(join(dir, 'heartbeat'))},\n` +
      `  watchPaths: [${JSON.stringify(dir)}],\n` +
      '  maxWallMs: 20000, stallMs: 20000, pollIntervalMs: 50, sigkillGraceMs: 300,\n' +
      '});\n' +
      'console.log(JSON.stringify({ exitClass: outcome.exitClass, groupSurvived: outcome.groupSurvived }));\n',
  );
  try {
    const run = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 30_000 });
    // Exit 13 is node's "unsettled top-level await" -- the exact symptom of the unref'd timer.
    assert.equal(run.status, 0, `driver exited ${run.status}: ${run.stdout}${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { exitClass: 'ok', groupSurvived: false });

    const survivor = Number(readFileSync(survivorPidFile, 'utf8').trim());
    assert.ok(Number.isInteger(survivor) && survivor > 1, 'the leader never reported its child');
    assert.throws(
      () => process.kill(survivor, 0),
      /ESRCH|no such process/i,
      'the standalone process exited while its executor child was still running',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `groupSurvived` is reported, not merely commented on -- dispatch fails the run on it and keeps
// the checkout lock rather than handing the next process a checkout with a live writer in it.
// A grace of 0 is how this is made deterministic: a real unkillable group needs an uninterruptible
// syscall, so the drain is instead given no time at all to confirm the SIGKILL landed. That is the
// same code path and the same verdict, without needing a process nothing can stop.
test('a group the drain cannot confirm dead is reported, not assumed gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-supervise-survivor-'));
  const ready = join(dir, 'ready');
  writeFileSync(
    join(dir, 'stubborn.mjs'),
    "import { writeFileSync } from 'node:fs';\n" +
      "process.on('SIGTERM', () => {});\n" +
      `writeFileSync(${JSON.stringify(ready)}, '1');\n` +
      'setInterval(() => {}, 1000);\n',
  );
  const script = join(dir, 'leader.mjs');
  writeFileSync(
    script,
    "import { spawn } from 'node:child_process';\n" +
      "import { existsSync } from 'node:fs';\n" +
      `const c = spawn(process.execPath, [${JSON.stringify(join(dir, 'stubborn.mjs'))}], { stdio: 'ignore' });\n` +
      'c.unref();\n' +
      `const deadline = Date.now() + 5000;\n` +
      `while (!existsSync(${JSON.stringify(ready)}) && Date.now() < deadline) {}\n` +
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
      sigkillGraceMs: 0, // no time to confirm: the drain must say so rather than assume
    });
    assert.equal(outcome.groupSurvived, true, 'an unconfirmed group was reported as drained');
    assert.equal(outcome.rc, 0, 'the leader itself exited cleanly; only its child outlived it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
