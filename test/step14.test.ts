// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../src/core/stats.ts';
import { selftest } from '../src/app/selftest.ts';
import type { MetricRecord } from '../src/domain/types.ts';

const m = (over: Partial<MetricRecord>): MetricRecord => ({
  ts: 't',
  task_id: 'x',
  run_id: 'run-001',
  attempt_number: 1,
  model: 'codex-test',
  exit_class: 'ok',
  verifier_result: 'PASSED',
  first_pass: true,
  tokens_input: null,
  tokens_output: null,
  cost_usd: 1,
  wall_seconds: 10,
  escalated: false,
  env_error: false,
  ...over,
});

test('aggregate computes cost per verified task and first-pass rate', () => {
  const s = aggregate([
    m({ task_id: 'a', cost_usd: 2, verifier_result: 'PASSED', attempt_number: 1 }),
    m({ task_id: 'b', cost_usd: 3, verifier_result: 'FAILED', attempt_number: 1 }),
    m({ task_id: 'c', cost_usd: 5, verifier_result: 'PASSED', attempt_number: 1 }),
  ]);
  assert.equal(s.totalRuns, 3);
  assert.equal(s.verifiedRuns, 2);
  assert.equal(s.totalCostUsd, 10);
  assert.equal(s.costPerVerifiedTask, 5); // 10 / 2
  assert.equal(s.firstPassRate, 2 / 3);
});

test('aggregate handles no data / no cost gracefully', () => {
  const s = aggregate([]);
  assert.equal(s.totalRuns, 0);
  assert.equal(s.costPerVerifiedTask, null);
  assert.equal(s.firstPassRate, null);

  const s2 = aggregate([m({ cost_usd: null, verifier_result: 'PASSED' })]);
  assert.equal(s2.totalCostUsd, null);
  assert.equal(s2.costPerVerifiedTask, null);
});

test('aggregate counts env_error runs and escalation rate', () => {
  const s = aggregate([
    m({ task_id: 'a', env_error: true, verifier_result: null, exit_class: 'env_error' }),
    m({ task_id: 'b', attempt_number: 2, verifier_result: 'PASSED' }),
  ]);
  assert.equal(s.envErrorRuns, 1);
  assert.equal(s.escalationRate, 0.5); // task b reached attempt 2
});

test('selftest: 2 canaries PASS and the scope trap is CAUGHT', async () => {
  const r = await selftest();
  assert.equal(r.canaries.length, 3);
  const byName = new Map(r.canaries.map((c) => [c.name, c]));
  assert.equal(byName.get('trivial-fix')?.actual, 'PASSED');
  assert.equal(byName.get('constrained-refactor')?.actual, 'PASSED');
  assert.equal(byName.get('scope-trap')?.actual, 'FAILED');
  assert.ok(byName.get('scope-trap')?.detail.includes('caught=true'));
  assert.equal(r.ok, true, JSON.stringify(r.canaries, null, 2));
});
