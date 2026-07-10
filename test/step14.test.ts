// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, summarizeBaseline } from '../src/core/stats.ts';
import { selftest } from '../src/app/selftest.ts';
import type { BaselineRecord, MetricRecord } from '../src/domain/types.ts';

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

test('aggregate computes spend per verified task and first-pass rate', () => {
  const s = aggregate([
    m({ task_id: 'a', cost_usd: 2, verifier_result: 'PASSED', attempt_number: 1 }),
    m({ task_id: 'b', cost_usd: 3, verifier_result: 'FAILED', attempt_number: 1 }),
    m({ task_id: 'c', cost_usd: 5, verifier_result: 'PASSED', attempt_number: 1 }),
  ]);
  assert.equal(s.totalRuns, 3);
  assert.equal(s.verifiedRuns, 2);
  assert.equal(s.spentUsd, 10);
  assert.equal(s.spentUsdPerVerifiedTask, 5); // 10 / 2
  assert.equal(s.firstPassRate, 2 / 3);
});

test('aggregate handles no data / no cost gracefully', () => {
  const s = aggregate([]);
  assert.equal(s.totalRuns, 0);
  assert.equal(s.spentUsdPerVerifiedTask, null);
  assert.equal(s.firstPassRate, null);

  const s2 = aggregate([m({ cost_usd: null, verifier_result: 'PASSED' })]);
  assert.equal(s2.spentUsd, null);
  assert.equal(s2.spentUsdPerVerifiedTask, null);
});

test('aggregate sums tokens and computes savings vs a baseline', () => {
  const records = [
    m({ task_id: 'a', tokens_input: 50000, tokens_output: 1000, cost_usd: 0.5, verifier_result: 'PASSED' }),
    m({ task_id: 'b', tokens_input: 50000, tokens_output: 1000, cost_usd: 0.5, verifier_result: 'PASSED' }),
  ];
  // baseline: 18k tokens/task, $2/task -> 2 verified => offloaded 36k, baseline $4, spent $1
  const s = aggregate(records, { tokensPerTask: 18000, costUsdPerTask: 2, n: 5 });
  assert.equal(s.tokensInput, 100000);
  assert.equal(s.tokensOutput, 2000);
  assert.equal(s.tokensTotal, 102000);
  assert.equal(s.spentUsd, 1);
  assert.equal(s.offloadedTokens, 36000); // 18000 * 2 verified
  assert.equal(s.savedUsd, 3); // baseline 4 - spent 1
  assert.equal(s.savedPct, 0.75); // 3/4
});

test('aggregate with a token-only baseline: offloaded tokens, savings null (no $)', () => {
  const s = aggregate([m({ tokens_input: 50000, tokens_output: 1000, cost_usd: null, verifier_result: 'PASSED' })], {
    tokensPerTask: 18000,
    costUsdPerTask: null,
    n: 3,
  });
  assert.equal(s.offloadedTokens, 18000);
  assert.equal(s.savedUsd, null);
  assert.equal(s.savedPct, null);
});

test('aggregate counts env_error runs and escalation rate', () => {
  const s = aggregate([
    m({ task_id: 'a', env_error: true, verifier_result: null, exit_class: 'env_error' }),
    m({ task_id: 'b', attempt_number: 2, verifier_result: 'PASSED' }),
  ]);
  assert.equal(s.envErrorRuns, 1);
  assert.equal(s.escalationRate, 0.5); // task b reached attempt 2
});

test('summarizeBaseline averages tokens and cost; null on empty', () => {
  assert.equal(summarizeBaseline([]), null);
  const b = (over: Partial<BaselineRecord>): BaselineRecord => ({
    ts: 't', task_id: null, model: 'opus', tokens_input: 0, tokens_output: 0, cost_usd: null, wall_seconds: null, ...over,
  });
  const s = summarizeBaseline([
    b({ tokens_input: 10000, tokens_output: 1000, cost_usd: 2 }),
    b({ tokens_input: 20000, tokens_output: 3000, cost_usd: 4 }),
  ]);
  assert.equal(s?.tokensPerTask, 17000); // (11000 + 23000) / 2
  assert.equal(s?.costUsdPerTask, 3); // (2 + 4) / 2
  assert.equal(s?.n, 2);
  // cost null unless EVERY record has one
  const s2 = summarizeBaseline([b({ tokens_input: 100, cost_usd: 1 }), b({ tokens_input: 200, cost_usd: null })]);
  assert.equal(s2?.costUsdPerTask, null);
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
