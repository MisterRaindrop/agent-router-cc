// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCaps, summarizeSpend } from '../src/core/caps.ts';
import type { ExitClass, MetricRecord } from '../src/domain/types.ts';

const m = (over: Partial<MetricRecord> = {}): MetricRecord => ({
  ts: '2026-07-09T00:00:00.000Z',
  task_id: 't1',
  run_id: 'run-001',
  attempt_number: 1,
  model: 'codex',
  exit_class: 'task_failed' as ExitClass,
  verifier_result: 'FAILED',
  first_pass: false,
  tokens_input: 100,
  tokens_output: 50,
  cost_usd: 0.5,
  wall_seconds: 10,
  escalated: false,
  env_error: false,
  ...over,
});

test('summarizeSpend sums only the target task and skips non-attempt exits', () => {
  const records = [
    m({ task_id: 't1', exit_class: 'task_failed', cost_usd: 0.5, tokens_input: 100, tokens_output: 50 }),
    m({ task_id: 't1', exit_class: 'env_error', cost_usd: 0.1, tokens_input: 10, tokens_output: 5 }),
    m({ task_id: 't1', exit_class: 'quota_exhausted', cost_usd: 0.2, tokens_input: 20, tokens_output: 10 }),
    m({ task_id: 'other', exit_class: 'task_failed', cost_usd: 9, tokens_input: 9999, tokens_output: 9999 }),
  ];
  const u = summarizeSpend(records, 't1');
  assert.equal(u.attemptsUsed, 1); // env_error + quota do NOT count as attempts
  assert.equal(u.costUsd, 0.8); // 0.5 + 0.1 + 0.2 (cost still accumulates)
  assert.equal(u.tokens, 195); // 150 + 15 + 30
});

test('max_attempts blocks once the cap is reached (>=)', () => {
  const records = [m({ exit_class: 'ok' }), m({ exit_class: 'task_failed' })];
  assert.equal(checkCaps(records, 't1', { max_attempts: 3 }).allowed, true);
  const v = checkCaps(records, 't1', { max_attempts: 2 });
  assert.equal(v.allowed, false);
  assert.match(v.reason ?? '', /attempt cap/);
});

test('no cap configured => always allowed', () => {
  const records = [m(), m(), m()];
  assert.equal(checkCaps(records, 't1', {}).allowed, true);
});

test('budget cost cap blocks at/over the ceiling', () => {
  const records = [m({ cost_usd: 1.0 }), m({ cost_usd: 1.0 })]; // $2 total
  assert.equal(checkCaps(records, 't1', { budget_caps: { max_cost_usd: 2.5 } }).allowed, true);
  const v = checkCaps(records, 't1', { budget_caps: { max_cost_usd: 2.0 } });
  assert.equal(v.allowed, false);
  assert.match(v.reason ?? '', /budget cap/);
});

test('budget token cap blocks at/over the ceiling', () => {
  const records = [m({ tokens_input: 400, tokens_output: 100 })]; // 500 total
  assert.equal(checkCaps(records, 't1', { budget_caps: { max_tokens: 501 } }).allowed, true);
  assert.equal(checkCaps(records, 't1', { budget_caps: { max_tokens: 500 } }).allowed, false);
});

test('null cost/tokens are treated as zero', () => {
  const records = [m({ cost_usd: null, tokens_input: null, tokens_output: null, exit_class: 'ok' })];
  const u = summarizeSpend(records, 't1');
  assert.equal(u.costUsd, 0);
  assert.equal(u.tokens, 0);
  assert.equal(u.attemptsUsed, 1);
});
