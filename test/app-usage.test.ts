// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateCostUsd,
  parseClaudeLog,
  parseCodexLog,
  parseCodexModel,
  parseCodexUsage,
  resolvePrice,
} from '../src/app/usage.ts';
import type { Policy } from '../src/domain/types.ts';

const basePolicy: Policy = {
  schema_version: 1,
  scope: { max_changed_lines: 100 },
  verification: { build: [['x']], test: [['y']] },
};

test('parseCodexUsage sums turn.completed usage across turns', () => {
  const log = [
    '{"type":"turn.started"}',
    'some non-json stderr line',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}',
    '{"type":"item.completed"}',
    '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":5}}',
  ].join('\n');
  const u = parseCodexUsage(log);
  assert.deepEqual(u, { input: 150, output: 15, cached: 40 });
});

test('parseCodexUsage returns null when no usage present', () => {
  assert.equal(parseCodexUsage('no json here\n{"type":"turn.started"}\n'), null);
});

test('parseCodexModel picks up a model field when present, null otherwise', () => {
  assert.equal(parseCodexModel('{"type":"thread.started","model":"gpt-5.5"}\n'), 'gpt-5.5');
  assert.equal(parseCodexModel('{"type":"turn.started","turn":{"model":"o3"}}\n'), 'o3');
  // current real codex exec --json carries no model field:
  assert.equal(parseCodexModel('{"type":"thread.started","thread_id":"x"}\n{"type":"turn.completed"}\n'), null);
});

test('parseCodexLog returns usage and model in a single pass', () => {
  const log = '{"type":"thread.started","model":"gpt-5.5"}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n';
  const r = parseCodexLog(log);
  assert.equal(r.model, 'gpt-5.5');
  assert.deepEqual(r.usage, { input: 10, output: 2, cached: 0 });
});

test('parseClaudeLog reads usage + total_cost_usd from the result event', () => {
  const log =
    '{"type":"assistant"}\n{"type":"result","subtype":"success","total_cost_usd":0.02,"usage":{"input_tokens":800,"output_tokens":60,"cache_read_input_tokens":100}}\n';
  const r = parseClaudeLog(log);
  assert.deepEqual(r.usage, { input: 800, output: 60, cached: 100 });
  assert.equal(r.costUsd, 0.02);
});

test('estimateCostUsd: null price -> null; priced -> computed', () => {
  const u = { input: 1_000_000, output: 500_000, cached: 0 };
  assert.equal(estimateCostUsd(u, null), null);
  assert.equal(estimateCostUsd(u, { input_per_mtok: 2, output_per_mtok: 8 }), 2 * 1 + 8 * 0.5); // 6
});

test('resolvePrice: env fallback', () => {
  const p = resolvePrice(basePolicy, 'anything', {
    ROUTER_PRICE_INPUT_PER_MTOK: '3',
    ROUTER_PRICE_OUTPUT_PER_MTOK: '9',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(p, { input_per_mtok: 3, output_per_mtok: 9 });
  assert.equal(resolvePrice(basePolicy, 'anything', {} as NodeJS.ProcessEnv), null);
});

test('resolvePrice: per-model price beats default; default beats env', () => {
  const policy: Policy = {
    ...basePolicy,
    pricing: {
      default: { input_per_mtok: 1, output_per_mtok: 1 },
      'gpt-5.5': { input_per_mtok: 2, output_per_mtok: 8 },
    },
  };
  assert.deepEqual(resolvePrice(policy, 'gpt-5.5', {} as NodeJS.ProcessEnv), { input_per_mtok: 2, output_per_mtok: 8 });
  assert.deepEqual(resolvePrice(policy, 'other', {} as NodeJS.ProcessEnv), { input_per_mtok: 1, output_per_mtok: 1 });
});
