// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Tests for the verifier's command runner.
//
// This file exists because nothing tested the one thing that matters about it. `runCommand` is how
// every reset, verify and gate command runs, and its `timeout` used to kill the direct child only:
// `npm`, `make` and every test runner start their own children, and those kept building after the
// gate reported FAILED -- in the checkout dispatch then handed to the next task, on the stated
// invariant that no writer was left in it. Measured before the fix: `timedOut: true` with the
// grandchild alive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/io/proc.ts';

const NODE = process.execPath;

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'io-proc-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readPid(file: string): number {
  try {
    const n = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 1 ? n : 0;
  } catch {
    return 0;
  }
}

// Only ESRCH means gone. EPERM means it is still there and merely not ours to signal, which is how
// processGroupIsGone in src/io/signals.ts reads it too.
function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function killIfAlive(pid: number): void {
  if (pid > 1 && !pidIsGone(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* cleanup only */
    }
  }
}

/** A command that starts a child outliving it, then blocks past any timeout the test sets. */
function leakyCommand(pidFile: string): readonly string[] {
  const source =
    `const {spawn}=require('node:child_process');` +
    `const fs=require('node:fs');` +
    `const c=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),120000)'],{stdio:'ignore'});` +
    `fs.writeFileSync(process.env.PID_FILE,String(c.pid));` +
    `setTimeout(()=>process.exit(0),120000)`;
  void pidFile;
  return [NODE, '-e', source];
}

test('a verify command that times out takes its descendants with it', () => {
  const fx = tmp();
  const pidFile = join(fx.dir, 'grandchild.pid');
  let grandchild = 0;
  try {
    const r = runCommand(leakyCommand(pidFile), {
      cwd: fx.dir,
      env: { ...process.env, PID_FILE: pidFile },
      timeoutMs: 1_500,
      reapGraceMs: 5_000,
    });
    assert.equal(r.timedOut, true, 'the fixture did not reach the timeout: nothing was tested');
    assert.equal(r.groupSurvived, false);

    grandchild = readPid(pidFile);
    assert.ok(grandchild > 1, 'the command never started a descendant: nothing was tested');
    // runCommand does not return until the group is empty, so this needs no polling. That is the
    // whole point of draining synchronously: dispatch releases the checkout lock on the next line.
    assert.ok(pidIsGone(grandchild), "the command's descendant outlived the timeout");
  } finally {
    killIfAlive(grandchild);
    fx.cleanup();
  }
});

// The other half of the same contract. A command can exit 0 while the work it started keeps
// running, and that is not a timeout -- so a reap wired only to the timeout path would leave the
// identical writer in the checkout.
test('a verify command that exits cleanly still takes its descendants with it', () => {
  const fx = tmp();
  const pidFile = join(fx.dir, 'grandchild.pid');
  let grandchild = 0;
  try {
    const source =
      `const {spawn}=require('node:child_process');` +
      `const fs=require('node:fs');` +
      `const c=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),120000)'],{stdio:'ignore'});` +
      // unref, or this process never exits: an active child handle holds its parent's event loop
      // open, so without it the "exits cleanly" fixture runs to the timeout and tests the other
      // path instead. Measured -- the first version of this test did exactly that.
      `c.unref();` +
      `fs.writeFileSync(process.env.PID_FILE,String(c.pid))`;
    const r = runCommand([NODE, '-e', source], {
      cwd: fx.dir,
      env: { ...process.env, PID_FILE: pidFile },
      timeoutMs: 30_000,
      reapGraceMs: 5_000,
    });
    assert.equal(r.rc, 0, 'the fixture did not exit cleanly: nothing was tested');
    assert.equal(r.timedOut, false);
    assert.equal(r.groupSurvived, false);

    grandchild = readPid(pidFile);
    assert.ok(grandchild > 1, 'the command never started a descendant: nothing was tested');
    assert.ok(pidIsGone(grandchild), "a cleanly-exiting command's descendant was left running");
  } finally {
    killIfAlive(grandchild);
    fx.cleanup();
  }
});

// `detached` is honoured by spawnSync at runtime but is not in its documented options, so it is not
// in the types either and nothing but this would notice a node release dropping it. Without a group
// of its own the drain reaches the direct child and nothing else: the leak, silently back.
test('the command leads its own process group, which is what the drain needs', () => {
  const fx = tmp();
  try {
    const r = runCommand(['/bin/sh', '-c', 'ps -o pgid= -p $$'], {
      cwd: fx.dir,
      env: process.env,
      timeoutMs: 30_000,
    });
    assert.equal(r.rc, 0);
    const childPgid = Number(r.stdout.trim());
    assert.ok(Number.isInteger(childPgid) && childPgid > 1, `unexpected ps output: ${r.stdout}`);

    // Compare against the group this test process is in. Equal would mean the command shared it,
    // and `kill(-pgid)` would then have been aimed at the test runner itself.
    const own = spawnSync('/bin/sh', ['-c', 'ps -o pgid= -p $$'], { encoding: 'utf8' });
    const ownPgid = Number((own.stdout ?? '').trim());
    assert.ok(Number.isInteger(ownPgid) && ownPgid > 1);
    assert.notEqual(childPgid, ownPgid, 'the command did not get a process group of its own');
  } finally {
    fx.cleanup();
  }
});

test('empty argv is a spawn error, not a crash', () => {
  const fx = tmp();
  try {
    const r = runCommand([], { cwd: fx.dir, env: process.env });
    assert.equal(r.spawnError, 'empty argv');
    assert.equal(r.groupSurvived, false);
    assert.equal(r.rc, null);
  } finally {
    fx.cleanup();
  }
});
