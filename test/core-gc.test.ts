// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMetricRetention, planRunGc } from '../src/core/gc.ts';
import type { MetricRecord, TaskState } from '../src/domain/types.ts';

const m = (i: number, ts: string): MetricRecord => ({
  ts,
  task_id: `t${i}`,
  run_id: 'run-001',
  attempt_number: 1,
  model: null,
  exit_class: 'ok',
  verifier_result: 'PASSED',
  first_pass: true,
  tokens_input: null,
  tokens_output: null,
  cost_usd: null,
  wall_seconds: 1,
  escalated: false,
  env_error: false,
});

test('keepLast keeps the most-recent N and drops the rest', () => {
  const records = [0, 1, 2, 3, 4].map((i) => m(i, `2026-07-0${i + 1}T00:00:00.000Z`));
  const plan = planMetricRetention(records, { keepLast: 2 });
  assert.deepEqual(plan.keep.map((r) => r.task_id), ['t3', 't4']);
  assert.deepEqual(plan.dropped.map((r) => r.task_id), ['t0', 't1', 't2']);
});

test('keepLast >= length drops nothing', () => {
  const records = [0, 1].map((i) => m(i, '2026-07-09T00:00:00.000Z'));
  const plan = planMetricRetention(records, { keepLast: 10 });
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.keep.length, 2);
});

test('maxAge drops records older than the cutoff (nowMs injected)', () => {
  const nowMs = Date.parse('2026-07-10T00:00:00.000Z');
  const records = [
    m(0, '2026-07-01T00:00:00.000Z'), // 9 days old
    m(1, '2026-07-09T18:00:00.000Z'), // 6h old
  ];
  const plan = planMetricRetention(records, { maxAgeMs: 24 * 3600_000, nowMs });
  assert.deepEqual(plan.keep.map((r) => r.task_id), ['t1']);
  assert.deepEqual(plan.dropped.map((r) => r.task_id), ['t0']);
});

test('a record with an unparseable ts is kept, never silently dropped', () => {
  const nowMs = Date.parse('2026-07-10T00:00:00.000Z');
  const records = [m(0, 'not-a-date')];
  const plan = planMetricRetention(records, { maxAgeMs: 1000, nowMs });
  assert.equal(plan.keep.length, 1);
});

const gc = (id: string, state: TaskState, worktrees: string[]) => ({ id, state, worktrees });

test('planRunGc removes worktrees ONLY for terminal tasks', () => {
  const plan = planRunGc([
    gc('merged', 'MERGED', ['run-001', 'run-002']),
    gc('cancelled', 'CANCELLED', ['run-001']),
    gc('running', 'RUNNING', ['run-001']), // must NOT be removed
    gc('queued', 'QUEUED', ['run-001']), // must NOT be removed
    gc('failed', 'FAILED', ['run-001']), // not terminal -> kept
  ]);
  assert.deepEqual(
    plan.remove.map((a) => `${a.taskId}/${a.runId}`),
    ['merged/run-001', 'merged/run-002', 'cancelled/run-001'],
  );
  // everything non-terminal that had worktrees is reported as skipped
  assert.deepEqual(plan.skipped.map((s) => s.taskId).sort(), ['failed', 'queued', 'running']);
});

test('planRunGc never touches RUNNING/QUEUED even with worktrees present', () => {
  const plan = planRunGc([gc('r', 'RUNNING', ['run-001', 'run-002'])]);
  assert.equal(plan.remove.length, 0);
});
