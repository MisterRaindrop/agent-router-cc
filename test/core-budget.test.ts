// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrateBudget,
  estimateTokens,
  rollingConsumption,
  selectExecutor,
  type RoutingBudget,
} from '../src/core/budget.ts';
import type { MetricRecord, RoutingObservation, WorkerKind } from '../src/domain/types.ts';

// A minute in ms, and a base epoch, to build deterministic timelines.
const MIN = 60_000;
const T0 = Date.parse('2026-07-01T00:00:00.000Z');
const at = (msFromT0: number): string => new Date(T0 + msFromT0).toISOString();

function mk(over: Partial<MetricRecord>): MetricRecord {
  return {
    ts: at(0),
    task_id: 't',
    run_id: 'run-001',
    attempt_number: 1,
    model: null,
    executor: 'codex',
    exit_class: 'ok',
    verifier_result: 'PASSED',
    first_pass: true,
    tokens_input: 100,
    tokens_output: 0,
    cost_usd: null,
    wall_seconds: 1,
    escalated: false,
    env_error: false,
    ...over,
  };
}

test('rollingConsumption sums per executor within the window only', () => {
  const now = T0 + 100 * MIN;
  const records = [
    mk({ ts: at(0), executor: 'codex', tokens_input: 1000 }), // 100min ago, window=60 => excluded
    mk({ ts: at(50 * MIN), executor: 'codex', tokens_input: 200, tokens_output: 50 }), // in
    mk({ ts: at(70 * MIN), executor: 'claude', tokens_input: 300 }), // in
    mk({ ts: at(90 * MIN), executor: 'codex', tokens_input: 10, tokens_output: 5 }), // in
  ];
  const c = rollingConsumption(records, now, 60);
  assert.equal(c.get('codex'), 200 + 50 + 10 + 5);
  assert.equal(c.get('claude'), 300);
});

test('rollingConsumption ignores records with no executor or bad ts', () => {
  const now = T0 + 10 * MIN;
  const records = [
    mk({ ts: at(5 * MIN), executor: null, tokens_input: 999 }),
    mk({ ts: 'not-a-date', executor: 'codex', tokens_input: 999 }),
    mk({ ts: at(5 * MIN), executor: 'codex', tokens_input: 7 }),
  ];
  const c = rollingConsumption(records, now, 60);
  assert.equal(c.get('codex'), 7);
});

test('rollingConsumption excludes the exact lower boundary, includes now', () => {
  const now = T0 + 60 * MIN;
  const records = [
    mk({ ts: at(0), executor: 'codex', tokens_input: 5 }), // exactly now-window => excluded
    mk({ ts: at(60 * MIN), executor: 'codex', tokens_input: 9 }), // exactly now => included
  ];
  assert.equal(rollingConsumption(records, now, 60).get('codex'), 9);
});

test('estimateTokens: per-kind trailing average, then all, then seed', () => {
  const records = [
    mk({ executor: 'codex', tokens_input: 100, tokens_output: 0 }),
    mk({ executor: 'codex', tokens_input: 300, tokens_output: 0 }),
    mk({ executor: 'claude', tokens_input: 1000, tokens_output: 0 }),
  ];
  assert.equal(estimateTokens(records, 'codex', 42), 200); // (100+300)/2
  assert.equal(estimateTokens(records, 'claude', 42), 1000);
  // a kind with no history of its own falls back to all executors' average.
  const claudeOnly = [mk({ executor: 'claude', tokens_input: 100 }), mk({ executor: 'claude', tokens_input: 500 })];
  assert.equal(estimateTokens(claudeOnly, 'codex', 42), 300); // (100+500)/2
  assert.equal(estimateTokens([], 'codex', 42), 42); // no data => seed
  // records without token data don't count
  assert.equal(estimateTokens([mk({ tokens_input: null, tokens_output: null })], 'codex', 42), 42);
});

test('selectExecutor: identity order when no budgets configured', () => {
  const d = selectExecutor({
    chain: ['codex', 'claude'],
    consumed: new Map(),
    estimates: new Map(),
    defaultEstimate: 100,
    budgets: new Map(),
  });
  assert.deepEqual(d.order, [0, 1]);
  assert.equal(d.chosen, 0);
  assert.equal(d.anyFits, true);
});

test('selectExecutor: skips a primary that is over its switch point', () => {
  const budgets = new Map<WorkerKind, RoutingBudget>([
    ['codex', { budget_tokens: 1000, switch_at: 0.9 }],
    ['claude', { budget_tokens: 1000, switch_at: 0.9 }],
  ]);
  const d = selectExecutor({
    chain: ['codex', 'claude'],
    consumed: new Map<WorkerKind, number>([['codex', 950], ['claude', 0]]),
    estimates: new Map<WorkerKind, number>([['codex', 100], ['claude', 100]]),
    defaultEstimate: 100,
    budgets,
  });
  // codex projected 1050/1000 = 105% > 90% => demoted; claude fits and leads
  assert.deepEqual(d.order, [1, 0]);
  assert.equal(d.chosen, 1);
  assert.equal(d.anyFits, true);
});

test('selectExecutor: nothing fits => most-headroom first, anyFits false', () => {
  const budgets = new Map<WorkerKind, RoutingBudget>([
    ['codex', { budget_tokens: 1000 }],
    ['claude', { budget_tokens: 1000 }],
  ]);
  const d = selectExecutor({
    chain: ['codex', 'claude'],
    consumed: new Map<WorkerKind, number>([['codex', 2000], ['claude', 1500]]),
    estimates: new Map(),
    defaultEstimate: 0,
    budgets,
  });
  // both over 90%; claude has lower fraction (1.5 vs 2.0) => leads as best effort
  assert.equal(d.anyFits, false);
  assert.deepEqual(d.order, [1, 0]);
});

test('selectExecutor: an unbounded (budget-less) executor always fits', () => {
  const budgets = new Map<WorkerKind, RoutingBudget>([['codex', { budget_tokens: 100 }]]);
  const d = selectExecutor({
    chain: ['codex', 'claude'],
    consumed: new Map<WorkerKind, number>([['codex', 1000]]),
    estimates: new Map(),
    defaultEstimate: 0,
    budgets,
  });
  // codex is over budget; claude has no budget => fits, leads
  assert.deepEqual(d.order, [1, 0]);
  const codex = d.entries.find((e) => e.kind === 'codex')!;
  const claude = d.entries.find((e) => e.kind === 'claude')!;
  assert.equal(codex.fits, false);
  assert.equal(claude.fits, true);
  assert.equal(claude.budget_tokens, null);
});

test('calibrateBudget: no observations returns the seed unchanged', () => {
  assert.equal(calibrateBudget(5000, 'codex', [], [], { windowMinutes: 300 }), 5000);
});

test('calibrateBudget: EMA moves the seed toward the observed ceiling, minus margin', () => {
  // At the moment of the 429, codex had consumed 800 tokens in the window.
  const metrics = [mk({ ts: at(10 * MIN), executor: 'codex', tokens_input: 800, tokens_output: 0 })];
  const obs: RoutingObservation[] = [{ ts: at(20 * MIN), kind: 'codex', task_id: 't', run_id: 'run-002' }];
  // alpha=1 => ema jumps straight to the observed ceiling (800), minus margin 50 => 750
  const cal = calibrateBudget(5000, 'codex', obs, metrics, { windowMinutes: 300, alpha: 1, margin: 50 });
  assert.equal(cal, 750);
  // alpha=0.5 => halfway between seed and observed: (5000+800)/2 = 2900
  const half = calibrateBudget(5000, 'codex', obs, metrics, { windowMinutes: 300, alpha: 0.5 });
  assert.equal(half, 2900);
});

test('calibrateBudget: only observations for the given kind count', () => {
  const metrics = [mk({ ts: at(10 * MIN), executor: 'claude', tokens_input: 900 })];
  const obs: RoutingObservation[] = [{ ts: at(20 * MIN), kind: 'claude', task_id: 't', run_id: 'r' }];
  // asking about codex: no codex observations => seed unchanged
  assert.equal(calibrateBudget(5000, 'codex', obs, metrics, { windowMinutes: 300, alpha: 1 }), 5000);
  // asking about claude: jumps to 900
  assert.equal(calibrateBudget(5000, 'claude', obs, metrics, { windowMinutes: 300, alpha: 1 }), 900);
});
