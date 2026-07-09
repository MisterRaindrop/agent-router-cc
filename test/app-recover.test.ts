// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerPaths } from '../src/io/paths.ts';
import { fixedClock } from '../src/io/clock.ts';
import * as store from '../src/io/store.ts';
import type { Lease } from '../src/domain/types.ts';
import { createTask, currentState, transition } from '../src/app/transition.ts';
import { rebuildRegistry } from '../src/app/registry.ts';
import { recover } from '../src/app/recover.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'router-rec-'));
  const paths = routerPaths(join(dir, '.router'));
  const deps = { paths, clock: fixedClock('2026-07-09T00:00:00.000Z') };
  return { dir, deps, paths };
}
function deadPid(): number {
  return spawnSync('node', ['-e', 'process.exit(0)']).pid as number;
}
function lease(over: Partial<Lease>): Lease {
  return {
    run_id: 'run-001',
    task_id: 't1',
    attempt_number: 1,
    supervisor_pid: process.pid,
    worker_pgid: deadPid(), // safe: killing a dead group is a no-op
    host: hostname(),
    started_at: '2026-07-09T00:00:00.000Z',
    max_wall_minutes: 30,
    wall_deadline: new Date(Date.now() + 3_600_000).toISOString(),
    heartbeat_path: 'heartbeat',
    ...over,
  };
}
function makeRunning(deps: ReturnType<typeof setup>['deps'], id: string, l: Lease): void {
  createTask(deps, id, 'x');
  transition(deps, id, 'VALIDATED', { actor: 'v' });
  transition(deps, id, 'QUEUED', { actor: 'q' });
  transition(deps, id, 'RUNNING', { actor: 'r', runId: 'run-001', meta: { attempt_number: 1 } });
  store.writeLease(deps.paths, id, 'run-001', l);
}
function writeHeartbeat(paths: ReturnType<typeof setup>['paths'], id: string, ageMs: number): void {
  const hb = paths.heartbeat(id, 'run-001');
  writeFileSync(hb, '');
  const t = new Date(Date.now() - ageMs);
  utimesSync(hb, t, t);
}

test('reindex rebuilds registry and repairs deleted state.json', () => {
  const { dir, deps, paths } = setup();
  try {
    createTask(deps, 'a', 'A');
    transition(deps, 'a', 'VALIDATED', { actor: 'v' });
    createTask(deps, 'b', 'B');
    unlinkSync(paths.registry);
    unlinkSync(paths.stateFile('a'));
    const { registry, errors } = rebuildRegistry(deps);
    assert.deepEqual(errors, []);
    assert.equal(registry.tasks['a']?.state, 'VALIDATED');
    assert.equal(registry.tasks['b']?.state, 'DRAFT');
    assert.equal(store.readState(paths, 'a')?.state, 'VALIDATED'); // repaired
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reindex reports corrupt task, keeps good ones', () => {
  const { dir, deps, paths } = setup();
  try {
    createTask(deps, 'good', 'G');
    // hand-write an illegal event log directly (bypassing the guarded primitive)
    store.appendEvent(paths, 'bad', { seq: 1, ts: 't', from: null, to: 'DRAFT', actor: 'x', run_id: null });
    store.appendEvent(paths, 'bad', { seq: 2, ts: 't', from: 'DRAFT', to: 'MERGED', actor: 'x', run_id: null });
    const { registry, errors } = rebuildRegistry(deps);
    assert.ok(registry.tasks['good']);
    assert.equal(registry.tasks['bad'], undefined);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.id, 'bad');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recover: dead supervisor => run marked STALE', () => {
  const { dir, deps, paths } = setup();
  try {
    makeRunning(deps, 't1', lease({ supervisor_pid: deadPid() }));
    writeHeartbeat(paths, 't1', 0);
    const r = recover(deps);
    assert.deepEqual(r.stillRunning, []);
    assert.equal(r.recovered[0]?.id, 't1');
    assert.equal(r.recovered[0]?.reason, 'supervisor_dead');
    assert.equal(currentState(paths, 't1')?.state, 'STALE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recover: missing lease => STALE (no_lease)', () => {
  const { dir, deps, paths } = setup();
  try {
    makeRunning(deps, 't1', lease({}));
    unlinkSync(paths.lease('t1', 'run-001'));
    const r = recover(deps);
    assert.equal(r.recovered[0]?.reason, 'no_lease');
    assert.equal(currentState(paths, 't1')?.state, 'STALE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recover: alive supervisor + fresh heartbeat => still RUNNING', () => {
  const { dir, deps, paths } = setup();
  try {
    makeRunning(deps, 't1', lease({ supervisor_pid: process.pid }));
    writeHeartbeat(paths, 't1', 0);
    const r = recover(deps);
    assert.deepEqual(r.recovered, []);
    assert.deepEqual(r.stillRunning, ['t1']);
    assert.equal(currentState(paths, 't1')?.state, 'RUNNING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recover: LIVE same-host supervisor with stale heartbeat stays RUNNING (long-verify fix)', () => {
  const { dir, deps, paths } = setup();
  try {
    // A synchronous build/test verify blocks the supervisor's event loop, freezing
    // the heartbeat while the run is perfectly healthy. Same-host pid liveness wins.
    makeRunning(deps, 't1', lease({ supervisor_pid: process.pid, host: hostname() }));
    writeHeartbeat(paths, 't1', 600_000); // 10 min old
    const r = recover(deps, { heartbeatStaleMs: 60_000 });
    assert.deepEqual(r.recovered, []);
    assert.deepEqual(r.stillRunning, ['t1']);
    assert.equal(currentState(paths, 't1')?.state, 'RUNNING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recover: CROSS-host stale heartbeat => STALE (heartbeat_stale)', () => {
  const { dir, deps, paths } = setup();
  try {
    // Different host: we cannot check the pid, so a stale heartbeat is the signal.
    makeRunning(deps, 't1', lease({ supervisor_pid: process.pid, host: 'some-other-host' }));
    writeHeartbeat(paths, 't1', 120_000);
    const r = recover(deps, { heartbeatStaleMs: 60_000 });
    assert.equal(r.recovered[0]?.reason, 'heartbeat_stale');
    assert.equal(currentState(paths, 't1')?.state, 'STALE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recover is idempotent (second run finds nothing to do)', () => {
  const { dir, deps, paths } = setup();
  try {
    makeRunning(deps, 't1', lease({ supervisor_pid: deadPid() }));
    writeHeartbeat(paths, 't1', 0);
    recover(deps);
    const r2 = recover(deps);
    assert.deepEqual(r2.recovered, []);
    assert.deepEqual(r2.stillRunning, []);
    assert.equal(currentState(paths, 't1')?.state, 'STALE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
