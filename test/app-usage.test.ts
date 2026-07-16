// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeLog, parseCodexLog } from '../src/app/usage.ts';

test('parseCodexLog sums turn.completed usage across turns', () => {
  const log = [
    '{"type":"turn.started"}',
    'some non-json stderr line',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}',
    '{"type":"item.completed"}',
    '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":5}}',
  ].join('\n');
  assert.deepEqual(parseCodexLog(log).usage, { input: 150, output: 15, cached: 40 });
});

test('parseCodexLog returns null usage when none present', () => {
  assert.equal(parseCodexLog('no json here\n{"type":"turn.started"}\n').usage, null);
});

test('parseCodexLog picks up a model field when present, null otherwise', () => {
  assert.equal(parseCodexLog('{"type":"thread.started","model":"gpt-5.5"}\n').model, 'gpt-5.5');
  assert.equal(parseCodexLog('{"type":"turn.started","turn":{"model":"o3"}}\n').model, 'o3');
  // current real codex exec --json carries no model field:
  assert.equal(parseCodexLog('{"type":"thread.started","thread_id":"x"}\n{"type":"turn.completed"}\n').model, null);
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
